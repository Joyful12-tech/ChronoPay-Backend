import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { getRedisClient } from "../cache/redisClient.js";
import { generateRequestHash } from "../utils/hash.js";
import { getIdempotencyPayloadCodec } from "../utils/idempotencyPayloadCodec.js";
import { validateIdempotencyKey } from "./headerValidation.js";
import { IdempotencyError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";
import { logger } from "../utils/logger.js";
import { verifyJwt } from "../utils/jwt.js";
import { configService } from "../config/config.service.js";

const IDEMPOTENCY_EXPIRATION_SECONDS = 86400;

const IDEMPOTENCY_KEY_PREFIX = "idempotency:req:";

/**
 * MIDDLEWARE ORDERING REQUIREMENT (issue #1306)
 *
 * The storage key is namespaced by the calling principal so that two callers
 * reusing the same Idempotency-Key value can never read each other's cached
 * responses (cross-tenant disclosure) or trigger spurious 409/422 conflicts.
 *
 * The principal is resolved in this order:
 *   1. req.auth.userId  — set by verified auth middleware (JWT or the
 *      trusted gateway headers consumed by requireAuthenticatedActor).
 *   2. req.apiKeyId     — set by apiKeyAuth for partner API-key callers.
 *   3. A verified JWT bearer token on the request (the middleware derives
 *      the principal itself on routes that mount no auth middleware, e.g.
 *      POST /api/v1/checkout/sessions). The token is cryptographically
 *      verified — a raw/unverified header value is never trusted.
 *   4. Anonymous callers — a salt-less SHA-256 of the caller IP, which keeps
 *      retry replay working for a single caller without storing the raw IP.
 *
 * Therefore: on routes that HAVE an authentication middleware, mount this
 * middleware AFTER it so req.auth is populated before the key is derived.
 * On routes WITHOUT an auth middleware this middleware falls back to
 * verifying the bearer token itself; it must never be re-ordered after
 * middleware that trusts unverified client headers for identity.
 */

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Route portion of the storage key: the mounted base URL plus the matched
 * route pattern (e.g. "/api/v1/booking-intents/"), so the same key value
 * used on two different endpoints can never collide. Falls back to the
 * query-stripped original URL when the request has not been routed yet.
 */
export function getIdempotencyRouteNamespace(req: Request): string {
  const routePath: unknown = req.route?.path;
  if (typeof routePath === "string") {
    return `${req.baseUrl}${routePath}`;
  }
  const url = req.originalUrl || req.url || "/";
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/**
 * Principal portion of the storage key. See the ordering requirement above.
 * Never derives identity from raw client-supplied headers: the bearer token
 * (when used here) is verified with the platform JWT secrets.
 */
export async function getIdempotencyPrincipalNamespace(req: Request): Promise<string> {
  if (req.auth?.userId) {
    return `user:${req.auth.userId}`;
  }

  if (req.apiKeyId) {
    return `apiKey:${req.apiKeyId}`;
  }

  const token = readBearerToken(req);
  if (token) {
    try {
      const payload = await verifyJwt(token, {
        issuer: configService.jwtIssuer ?? undefined,
      });
      const subject = payload.sub ?? payload.id;
      if (typeof subject === "string" && subject.trim().length > 0) {
        return `user:${subject.trim()}`;
      }
    } catch {
      // Invalid or expired token: whether the request may proceed is the
      // route's concern (checkout allows unauthenticated sessions). Namespace
      // it as anonymous so it cannot collide with any verified principal.
    }
  }

  const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  return `anon:${sha256Hex(ip)}`;
}

/**
 * Builds the Redis storage key from (principal, method, route, key). All
 * parts are hashed together so key length stays bounded regardless of user
 * ID or route length, and no principal identifier leaks into Redis keys.
 */
export function buildIdempotencyStorageKey(parts: {
  principal: string;
  method: string;
  route: string;
  idempotencyKey: string;
}): string {
  const material = [
    parts.principal,
    parts.method,
    parts.route,
    parts.idempotencyKey,
  ].join("\n");
  return `${IDEMPOTENCY_KEY_PREFIX}${sha256Hex(material)}`;
}

interface IdempotencyProcessingState {
  status: "processing";
  requestHash: string;
}

interface IdempotencyCompletedState {
  status: "completed";
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
}

type IdempotencyState = IdempotencyProcessingState | IdempotencyCompletedState;

export const idempotencyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const idempotencyKey = req.header("Idempotency-Key");

  if (!idempotencyKey) {
    next();
    return;
  }

  const redis = getRedisClient();
  if (!redis) {
    // Fail closed: without Redis we cannot guarantee idempotency, so reject
    // rather than silently allowing duplicate processing.
    res.status(503).json({
      success: false,
      code: "DEPENDENCY_UNAVAILABLE",
      error: "Redis is currently unavailable",
    });
    return;
  }

  // --- Header validation: reject malformed keys before touching Redis ---
  const keyValidation = validateIdempotencyKey(idempotencyKey);
  if (!keyValidation.valid) {
    sendErrorResponse(
      res,
      new IdempotencyError(
        // @ts-expect-error - Auto-fixed by script
        keyValidation.reason,
        ERROR_CODES.IDEMPOTENCY_KEY_INVALID.code,
      ),
      req,
    );
    return;
  }

  try {
    const principal = await getIdempotencyPrincipalNamespace(req);
    const storageKey = buildIdempotencyStorageKey({
      principal,
      method: req.method,
      route: getIdempotencyRouteNamespace(req),
      idempotencyKey,
    });
    const incomingHash = generateRequestHash(req.method, req.originalUrl, req.body);
    const codec = getIdempotencyPayloadCodec();
    const existingData = await redis.get(storageKey);

    if (existingData) {
      const parsedData = codec.deserialize<IdempotencyState>(existingData);

      if (parsedData.status === "processing") {
        sendErrorResponse(
          res,
          new IdempotencyError(
            "Conflict: This transaction is actively running.",
            ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code,
          ),
          req,
        );
        return;
      }

      if (parsedData.requestHash !== incomingHash) {
        sendErrorResponse(
          res,
          new IdempotencyError(
            "Unprocessable Entity: Idempotency-Key used with different payload.",
            ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH.code,
          ),
          req,
        );
        return;
      }

      res.status(parsedData.statusCode).json(parsedData.responseBody);
      return;
    }

    const processingState: IdempotencyProcessingState = {
      status: "processing",
      requestHash: incomingHash,
    };

    const lockAcquired = await redis.set(
      storageKey,
      codec.serialize(processingState),
      "EX",
      IDEMPOTENCY_EXPIRATION_SECONDS,
      "NX",
    );

    if (lockAcquired !== "OK") {
      sendErrorResponse(
        res,
        new IdempotencyError(
          "Conflict: This transaction is actively running.",
          ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code,
        ),
        req,
      );
      return;
    }

    const originalJson = res.json.bind(res);

    res.json = ((body: unknown) => {
      const completedState: IdempotencyCompletedState = {
        status: "completed",
        requestHash: incomingHash,
        statusCode: res.statusCode,
        responseBody: body,
      };

      redis
        .set(
          storageKey,
          codec.serialize(completedState),
          "EX",
          IDEMPOTENCY_EXPIRATION_SECONDS,
        )
        .catch((error: Error) => {
          logger.error({ err: error }, "failed to persist idempotency response");
        });

      return originalJson(body);
    }) as Response["json"];

    next();
  } catch (error) {
    next(error);
  }
};
