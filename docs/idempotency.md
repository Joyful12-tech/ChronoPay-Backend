# Idempotency in ChronoPay-Backend

Idempotency allows clients to safely retry requests without accidentally performing the same operation twice. This is particularly critical for payment and scheduling transactions where race conditions or network timeouts could result in duplicate records.

## Opt-in Idempotency
To make a request idempotent, clients must provide a unique `Idempotency-Key` header. If the header is missing, the request proceeds normally and is not cached.

```http
POST /api/v1/slots HTTP/1.1
Idempotency-Key: req_12345
```

## Strong Idempotency Binding

To prevent **cross-endpoint and cross-caller replay confusion**, an idempotency
key is tightly bound to four elements, all hashed together into the Redis
storage key:
1. **Caller Principal** (see *Principal Namespacing* below)
2. **Request Method** (e.g., `POST`)
3. **Request Path** (e.g., `/api/v1/slots`)
4. **Payload Hash** (Deterministic SHA-256 hash of the JSON body)

### Principal Namespacing

The Redis storage key is scoped to the calling principal, so two different
callers reusing the same `Idempotency-Key` value can never read each other's
cached responses (cross-tenant data disclosure) or trigger spurious
`409`/`422` conflicts. The principal is resolved in this order:

1. `req.auth.userId` — set by the route's verified authentication middleware.
2. `req.apiKeyId` — set for partner API-key callers.
3. A **verified** JWT bearer token on the request (the middleware derives the
   principal itself on routes that mount no auth middleware, e.g.
   `POST /api/v1/checkout/sessions`). The token is cryptographically verified;
   a raw, unverified header value is never trusted.
4. Anonymous callers — a salt-less SHA-256 of the caller IP, preserving
   retry-replay for a single caller without storing the raw IP.

**Middleware ordering:** on routes that have an authentication middleware,
mount `idempotencyMiddleware` **after** it so `req.auth` is populated before
the key is derived. On routes without an auth middleware the middleware falls
back to verifying the bearer token itself; it must never be ordered after
middleware that trusts unverified client headers for identity.

**Backward compatibility:** anonymous callers (no auth) keep the same
retry-replay behaviour they had before — the only change is that their cache
is now isolated per client rather than shared globally.

### Rejection Scenarios
- **Endpoint Mismatch (409 Conflict)**: If a client reuses the same `Idempotency-Key` for a different route or HTTP method, the server will deterministically reject it with a `409 Conflict`.
- **Payload Mismatch (422 Unprocessable Entity)**: If the client sends the same key to the same route but alters the request body, the server will return a `422 Unprocessable Entity`.

## Security Assumptions

- **Stable Hashing**: The JSON request body is deeply and deterministically sorted before hashing. This means that two payloads with the exact same data but keys ordered differently will correctly resolve to the exact same hash.
- **Data Privacy**: The server **never logs or stores** the raw request payload within the idempotency lock. Instead, the payload is reduced to a one-way `SHA-256` hash. This guarantees that sensitive fields (like PII or payment details) are never leaked into the Redis idempotency storage.

## Redis Lock Lifecycle (TTL)
Once a request successfully completes, its response status and body are written to Redis with a TTL (Time-To-Live) of 24 hours. After this period, the key expires, and a retry using the same key will be treated as a completely new request.

## Middleware Test Coverage

The middleware behavior is covered by `src/middleware/__tests__/idempotency.test.ts`.

- Replay of stored responses for identical retries
- `422` payload mismatch for same key and different body hash
- Concurrency guard (`409`) so concurrent first-requests with same key do not both execute
- Missing-key pass-through behavior
- Expired-key behavior (treated as a new request)
- Redis-unavailable fail-closed behavior (`503`)
- Principal namespacing: no cross-user replay of a shared key, no cross-route
  collision, same-user replay preserved, anonymous replay preserved
- Encryption codec security checks (no plaintext leak, tamper detection)

### Collision and Trust Assumption

Idempotency correctness assumes:

1. SHA-256 request hashes are collision-resistant in practice.
2. Redis idempotency entries are trusted and not tampered with by untrusted actors.
3. The storage key binds the caller principal, so a matching hash under one
   caller's namespace can never be replayed to a different caller.

If a collision were to occur (or a cache entry were maliciously forged with a matching hash), the middleware would replay the cached response because the hash is the binding primitive. Because the storage key is additionally namespaced by principal, any such replay is confined to the caller who created the entry.
