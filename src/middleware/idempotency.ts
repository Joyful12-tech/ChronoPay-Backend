/**
 * @file src/middleware/idempotency.ts
 *
 * Replays a cached response when a client retries a request with the same
 * `Idempotency-Key`.
 *
 * ─── Ordering requirement ───────────────────────────────────────────────────
 * The storage key is namespaced by the caller principal (see
 * {@link deriveIdempotencyPrincipal}), so this middleware MUST run AFTER the
 * authentication middleware on every route that mounts it. Otherwise the
 * principal falls back to a hashed client IP and two authenticated callers
 * sharing a NAT/proxy address could still collide on the same key.
 *
 * Mounted routes:
 *   - POST /api/v1/booking-intents  (after requireAuthenticatedActor)
 *   - POST /api/v1/checkout/sessions (after optionalJwtAuth — auth is optional
 *     on this route, so unauthenticated callers fall back to hashed-IP scope)
 *
 * The principal is only read from verified authentication context
 * (`req.auth`, `req.user`, `req.apiKeyId`) — never from raw client headers.
 */

import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getRedisClient } from "../cache/redisClient.js";
import { generateRequestHash } from "../utils/hash.js";
import { getIdempotencyPayloadCodec } from "../utils/idempotencyPayloadCodec.js";
import { validateIdempotencyKey } from "./headerValidation.js";
import { IdempotencyError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";
import { logger } from "../utils/logger.js";

const IDEMPOTENCY_EXPIRATION_SECONDS = 86400;

/**
 * Derive the caller principal used to namespace idempotency storage.
 *
 * Priority (first match wins):
 *   1. `req.auth?.userId`        — set by the route's authentication middleware
 *   2. `req.user?.sub || id`     — verified JWT payload
 *   3. `req.apiKeyId`            — API-key authentication
 *   4. hashed client IP          — anonymous callers (keeps retry replay working)
 *
 * Only verified authentication context is consulted; raw identity headers
 * (e.g. `x-chronopay-user-id`) are deliberately NOT read here — they must go
 * through an authentication middleware that populates `req.auth` first.
 *
 * IP addresses are hashed so plaintext client addresses never appear in
 * Redis keys.
 */
export function deriveIdempotencyPrincipal(req: Request): string {
  if (req.auth?.userId) {
    return `user:${req.auth.userId}`;
  }

  const jwtUser = req.user;
  if (jwtUser) {
    const userId = jwtUser.sub || jwtUser.id;
    if (userId) {
      return `user:${userId}`;
    }
  }

  if (req.apiKeyId) {
    return `apiKey:${req.apiKeyId}`;
  }

  const ip = req.ip || req.socket?.remoteAddress || "anonymous";
  return `anon:${createHash("sha256").update(ip, "utf8").digest("hex")}`;
}

/**
 * Resolve the route scope so the same key used on two different endpoints
 * cannot collide. Prefers the matched route template (e.g.
 * `/api/v1/booking-intents/:id/confirm`), falling back to the request path
 * without its query string when the middleware runs outside a route match.
 */
function resolveRouteScope(req: Request): string {
  const routePath = (req as unknown as { route?: { path?: unknown } }).route?.path;
  if (typeof routePath === "string" && routePath.length > 0) {
    return `${req.baseUrl || ""}${routePath}`;
  }

  const url = req.originalUrl || req.url || "/";
  return url.split("?")[0];
}

/**
 * Build the Redis storage key for an idempotency entry.
 *
 * Key shape: `idempotency:req:<sha256(principal|method|route|key)>`
 *
 * Hashing the components bounds the key length and keeps the raw principal,
 * route and client key out of Redis key names. Scoping by principal means one
 * caller can never read (or be blocked by) another caller's cached response,
 * even when clients pick predictable or identical keys.
 */
export function buildIdempotencyStorageKey(req: Request, idempotencyKey: string): string {
  const components = [
    deriveIdempotencyPrincipal(req),
    req.method,
    resolveRouteScope(req),
    idempotencyKey,
  ];
  const digest = createHash("sha256").update(JSON.stringify(components)).digest("hex");
  return `idempotency:req:${digest}`;
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
    // Namespaced by principal + method + route so a key that collides across
    // users or endpoints can never replay another caller's response.
    const storageKey = buildIdempotencyStorageKey(req, idempotencyKey);
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
