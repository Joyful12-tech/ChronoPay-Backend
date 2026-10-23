# Idempotency in ChronoPay-Backend

Idempotency allows clients to safely retry requests without accidentally performing the same operation twice. This is particularly critical for payment and scheduling transactions where race conditions or network timeouts could result in duplicate records.

## Opt-in Idempotency
To make a request idempotent, clients must provide a unique `Idempotency-Key` header. If the header is missing, the request proceeds normally and is not cached.

```http
POST /api/v1/slots HTTP/1.1
Idempotency-Key: req_12345
```

## Strong Idempotency Binding

An idempotency key is tightly bound to the **caller principal**, the **request method**, the **matched route** and the **payload**:

1. **Principal** — the verified caller identity (see [Principal scoping](#principal-scoping-scoped-storage-keys))
2. **Request Method** (e.g., `POST`)
3. **Route** (e.g., `/api/v1/booking-intents`)
4. **Payload Hash** (Deterministic SHA-256 hash of the JSON body)

The Redis storage key is derived as `idempotency:req:<sha256(principal | method | route | key)>`, so entries are per-caller and per-endpoint; hashing bounds the key length and keeps principals and raw client keys out of Redis key names.

### Rejection Scenarios
- **Cross-endpoint / cross-caller reuse**: the same `Idempotency-Key` on a different route or from a different principal resolves to a *separate* storage entry — each caller gets their own fresh response instead of a collision.
- **Payload Mismatch (422 Unprocessable Entity)**: If the client sends the same key to the same route as the same caller but alters the request body, the server will return a `422 Unprocessable Entity`.

## Principal scoping (scoped storage keys)

The storage key is namespaced by the caller principal so a cached response can
never be replayed to another tenant (this was a cross-tenant data-disclosure
risk: clients often pick predictable keys such as order ids or counters).

Principal priority (first match wins):

1. `req.auth?.userId` — set by the route's authentication middleware
2. `req.user?.sub || req.user?.id` — verified JWT payload
3. `req.apiKeyId` — API-key authentication
4. Hashed client IP — anonymous callers (retries from the same caller still replay)

Only **verified authentication context** is read — never raw client headers.

### Ordering requirement

`idempotencyMiddleware` must be mounted **after** authentication on every route:

| Route | Ordering |
| --- | --- |
| `POST /api/v1/booking-intents` | `requireAuthenticatedActor` → `idempotencyMiddleware` |
| `POST /api/v1/checkout/sessions` | `optionalJwtAuth` → `idempotencyMiddleware` (auth is optional; unauthenticated callers fall back to hashed-IP scope) |

If it runs before authentication, the principal falls back to a hashed client IP and two authenticated callers sharing a NAT/proxy address could still collide on the same key.

## Security Assumptions

- **Stable Hashing**: The JSON request body is deeply and deterministically sorted before hashing. This means that two payloads with the exact same data but keys ordered differently will correctly resolve to the exact same hash.
- **Data Privacy**: The server **never logs or stores** the raw request payload within the idempotency lock. Instead, the payload is reduced to a one-way `SHA-256` hash. This guarantees that sensitive fields (like PII or payment details) are never leaked into the Redis idempotency storage.

## Redis Lock Lifecycle (TTL)
Once a request successfully completes, its response status and body are written to Redis with a TTL (Time-To-Live) of 24 hours. After this period, the key expires, and a retry using the same key will be treated as a completely new request.

## Middleware Test Coverage

The middleware behavior is covered by `src/middleware/__tests__/idempotency.test.ts`.

- Replay of stored responses for identical retries
- `422` payload mismatch for same key and different body hash
- Principal scoping: two users with the same key and body each get their own fresh response (regression test for cross-user replay)
- Same user + same key + same body still replays from cache
- Same key on two different routes does not collide
- Anonymous callers are isolated by hashed IP while same-caller replay is preserved
- Concurrency guard (`409`) so concurrent first-requests with same key do not both execute
- Missing-key pass-through behavior
- Expired-key behavior (treated as a new request)
- Redis-unavailable fail-closed behavior (`503`)
- Encryption codec security checks (no plaintext leak, tamper detection)

### Collision and Trust Assumption

Idempotency correctness assumes:

1. SHA-256 request hashes are collision-resistant in practice.
2. Redis idempotency entries are trusted and not tampered with by untrusted actors.

If a collision were to occur (or a cache entry were maliciously forged with a matching hash), the middleware would replay the cached response because the hash is the binding primitive.
