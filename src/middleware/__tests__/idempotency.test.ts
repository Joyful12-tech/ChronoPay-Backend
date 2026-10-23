import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "@jest/globals";
import { setRedisClient, type RedisClient } from "../../cache/redisClient.js";
import {
  buildIdempotencyStorageKey,
  idempotencyMiddleware,
} from "../idempotency.js";
import {
  IdempotencyPayloadDecryptError,
  createIdempotencyPayloadCodec,
} from "../../utils/idempotencyPayloadCodec.js";
import { generateRequestHash } from "../../utils/hash.js";

type StoredValue = { value: string; expiresAt?: number };

class InMemoryRedisMock implements RedisClient {
  private readonly store = new Map<string, StoredValue>();
  constructor(private readonly delayedCompleteWriteMs = 0) {}

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(
    key: string,
    value: string,
    exMode: "EX",
    ttl: number,
    condition?: "NX",
  ): Promise<unknown> {
    if (condition === "NX" && this.store.has(key)) {
      return null;
    }

    // Delay non-NX writes to keep "processing" visible during concurrency tests.
    if (!condition && this.delayedCompleteWriteMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayedCompleteWriteMs));
    }

    const expiresAt = exMode === "EX" ? Date.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    this.store.delete(key);
    return 1;
  }

  async keys(pattern: string): Promise<string[]> {
    if (pattern === "*") {
      return [...this.store.keys()];
    }
    const prefix = pattern.replace("*", "");
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    this.store.clear();
    return "OK";
  }

  forceExpire(key: string): void {
    const entry = this.store.get(key);
    if (!entry) return;
    this.store.set(key, { ...entry, expiresAt: Date.now() - 1 });
  }
}

function createTestApp(
  handler: (req: express.Request, res: express.Response) => Promise<void> | void,
  options: { authenticated?: boolean } = {},
) {
  const app = express();
  app.use(express.json());
  if (options.authenticated) {
    // Stands in for requireAuthenticatedActor/requireAuth: populates
    // req.auth from a test-only header so the principal namespace is known.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      if (userId) {
        req.auth = { userId, role: "customer", claims: {} } as express.Request["auth"];
      }
      next();
    });
  }
  app.post("/payments", idempotencyMiddleware, handler);
  return app;
}

describe("idempotencyMiddleware", () => {
  let redis: InMemoryRedisMock;
  let handlerExecutions = 0;

  beforeEach(() => {
    redis = new InMemoryRedisMock();
    handlerExecutions = 0;
    setRedisClient(redis);
  });

  it("replays stored response for key reuse with identical payload", async () => {
    const app = createTestApp((req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true, run: handlerExecutions, amount: req.body.amount });
    });

    const first = await request(app)
      .post("/payments")
      .set("Idempotency-Key", "pay-same-body-1")
      .send({ amount: 1250, currency: "USD" });
    const second = await request(app)
      .post("/payments")
      .set("Idempotency-Key", "pay-same-body-1")
      .send({ amount: 1250, currency: "USD" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(handlerExecutions).toBe(1);
  });

  it("returns 422 when same key is reused with a different payload hash", async () => {
    const app = createTestApp((_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true });
    });

    await request(app)
      .post("/payments")
      .set("Idempotency-Key", "pay-mismatch-1")
      .send({ amount: 1000, note: "first" });

    const mismatch = await request(app)
      .post("/payments")
      .set("Idempotency-Key", "pay-mismatch-1")
      .send({ amount: 1000, note: "second" });

    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error).toMatch(/different payload/i);
    expect(handlerExecutions).toBe(1);
  });

  it("ensures concurrent first-requests with same key do not both execute handler", async () => {
    redis = new InMemoryRedisMock(80);
    setRedisClient(redis);
    const key = "pay-concurrency-1";

    const app = createTestApp((_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true, run: handlerExecutions });
    });

    const [first, second] = await Promise.all([
      request(app).post("/payments").set("Idempotency-Key", key).send({ amount: 5000 }),
      request(app).post("/payments").set("Idempotency-Key", key).send({ amount: 5000 }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    expect(handlerExecutions).toBe(1);
  });

  it("allows normal non-idempotent behavior when key is missing", async () => {
    const app = createTestApp((_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true, run: handlerExecutions });
    });

    const first = await request(app).post("/payments").send({ amount: 100 });
    const second = await request(app).post("/payments").send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.run).toBe(1);
    expect(second.body.run).toBe(2);
    expect(handlerExecutions).toBe(2);
  });

  it("treats an expired key as a new request and executes handler again", async () => {
    const app = createTestApp((_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true, run: handlerExecutions });
    });

    const key = "pay-expired-key-1";
    const first = await request(app)
      .post("/payments")
      .set("Idempotency-Key", key)
      .send({ amount: 700 });

    const [storageKey] = await redis.keys("idempotency:req:*");
    expect(storageKey).toBeDefined();
    redis.forceExpire(storageKey as string);

    const second = await request(app)
      .post("/payments")
      .set("Idempotency-Key", key)
      .send({ amount: 700 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.run).toBe(1);
    expect(second.body.run).toBe(2);
    expect(handlerExecutions).toBe(2);
  });

  it("returns 503 when idempotency key is provided but Redis is unavailable", async () => {
    setRedisClient(null);
    const app = createTestApp((_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true });
    });

    const response = await request(app)
      .post("/payments")
      .set("Idempotency-Key", "pay-no-redis-1")
      .send({ amount: 1 });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(handlerExecutions).toBe(0);
  });

  it("documents collision assumption: matching hash always replays cached response", async () => {
    const app = createTestApp((_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true, source: "handler" });
    }, { authenticated: true });

    const key = "pay-collision-assumption-1";
    const storageKey = buildIdempotencyStorageKey({
      principal: "user:seed-user",
      method: "POST",
      route: "/payments",
      idempotencyKey: key,
    });
    const payload = { amount: 8080, note: "from-request" };
    const requestHash = generateRequestHash("POST", "/payments", payload);
    const codec = createIdempotencyPayloadCodec({
      enabled: false,
      algorithm: "aes-256-gcm",
      activeKey: null,
      decryptionKeys: [],
    });

    await redis.set(
      storageKey,
      codec.serialize({
        status: "completed",
        requestHash,
        statusCode: 201,
        responseBody: { ok: true, source: "cached" },
      }),
      "EX",
      86400,
    );

    const response = await request(app)
      .post("/payments")
      .set("x-test-user-id", "seed-user")
      .set("Idempotency-Key", key)
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true, source: "cached" });
    expect(handlerExecutions).toBe(0);
  });
});

describe("idempotencyMiddleware principal namespacing (issue #1306)", () => {
  let redis: InMemoryRedisMock;
  let handlerExecutions = 0;

  beforeEach(() => {
    redis = new InMemoryRedisMock();
    handlerExecutions = 0;
    setRedisClient(redis);
  });

  it("does not replay one user's cached response to another user reusing the same key (cross-user regression)", async () => {
    const app = createTestApp((req, res) => {
      handlerExecutions += 1;
      res.status(201).json({
        ok: true,
        run: handlerExecutions,
        ownerId: req.auth?.userId ?? null,
      });
    }, { authenticated: true });

    const first = await request(app)
      .post("/payments")
      .set("x-test-user-id", "user-a")
      .set("Idempotency-Key", "shared-key-1")
      .send({ amount: 100, currency: "USD" });
    const second = await request(app)
      .post("/payments")
      .set("x-test-user-id", "user-b")
      .set("Idempotency-Key", "shared-key-1")
      .send({ amount: 100, currency: "USD" });

    // Each caller gets its own fresh response — never the other user's body.
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.ownerId).toBe("user-a");
    expect(second.body.ownerId).toBe("user-b");
    expect(second.body.run).toBe(2);
    expect(handlerExecutions).toBe(2);
  });

  it("replays the cached response for the same user reusing the same key and body", async () => {
    const app = createTestApp((req, res) => {
      handlerExecutions += 1;
      res.status(201).json({
        ok: true,
        run: handlerExecutions,
        ownerId: req.auth?.userId ?? null,
      });
    }, { authenticated: true });

    const first = await request(app)
      .post("/payments")
      .set("x-test-user-id", "user-a")
      .set("Idempotency-Key", "same-user-key-1")
      .send({ amount: 250 });
    const second = await request(app)
      .post("/payments")
      .set("x-test-user-id", "user-a")
      .set("Idempotency-Key", "same-user-key-1")
      .send({ amount: 250 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(handlerExecutions).toBe(1);
  });

  it("does not collide when the same key is used on two different routes", async () => {
    const app = express();
    app.use(express.json());
    app.post("/payments", idempotencyMiddleware, (_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ route: "payments", run: handlerExecutions });
    });
    app.post("/refunds", idempotencyMiddleware, (_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ route: "refunds", run: handlerExecutions });
    });

    const payload = { amount: 500 };
    const first = await request(app)
      .post("/payments")
      .set("Idempotency-Key", "route-collision-1")
      .send(payload);
    const second = await request(app)
      .post("/refunds")
      .set("Idempotency-Key", "route-collision-1")
      .send(payload);

    // Each route executes its own handler; neither replays nor 422-conflicts.
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.route).toBe("payments");
    expect(second.body.route).toBe("refunds");
    expect(handlerExecutions).toBe(2);
  });

  it("keeps replay behaviour for anonymous callers retrying from the same client", async () => {
    const app = createTestApp((_req, res) => {
      handlerExecutions += 1;
      res.status(201).json({ ok: true, run: handlerExecutions });
    });

    const first = await request(app)
      .post("/payments")
      .set("Idempotency-Key", "anon-key-1")
      .send({ amount: 42 });
    const second = await request(app)
      .post("/payments")
      .set("Idempotency-Key", "anon-key-1")
      .send({ amount: 42 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(handlerExecutions).toBe(1);
  });
});

describe("IdempotencyPayloadCodec security", () => {
  it("encrypts payloads without leaking plaintext when encryption is enabled", () => {
    const codec = createIdempotencyPayloadCodec({
      enabled: true,
      algorithm: "aes-256-gcm",
      activeKey: { id: "k1", value: Buffer.alloc(32, 7) },
      decryptionKeys: [{ id: "k1", value: Buffer.alloc(32, 7) }],
    });

    const serialized = codec.serialize({ status: "completed", secret: "sensitive-pii" });

    expect(serialized).not.toContain("sensitive-pii");
    const parsed = JSON.parse(serialized) as { enc?: unknown };
    expect(parsed.enc).toBeDefined();
    expect(codec.deserialize<{ secret: string }>(serialized).secret).toBe("sensitive-pii");
  });

  it("fails decryption on tampered ciphertext/tag", () => {
    const key = Buffer.alloc(32, 9);
    const codec = createIdempotencyPayloadCodec({
      enabled: true,
      algorithm: "aes-256-gcm",
      activeKey: { id: "k1", value: key },
      decryptionKeys: [{ id: "k1", value: key }],
    });

    const serialized = codec.serialize({ status: "completed", amount: 99 });
    const parsed = JSON.parse(serialized) as { enc: { tag: string } };
    parsed.enc.tag = Buffer.from("tampered").toString("base64");

    expect(() => codec.deserialize(JSON.stringify(parsed))).toThrow(
      IdempotencyPayloadDecryptError,
    );
  });
});
