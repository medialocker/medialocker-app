# Idempotency

Mutating requests can be made **exactly-once** by supplying an `Idempotency-Key`.
A retry with the same key replays the original response instead of performing the
mutation again — useful for safely retrying after a network error or timeout.

## Using idempotency keys

Send an `Idempotency-Key` header (any unique string — a UUID is a good choice) on a
mutating request:

```bash
curl -X POST https://api.medialocker.io/api/buckets \
  -H "Authorization: Bearer <secret>" \
  -H "Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7" \
  -H "Content-Type: application/json" \
  -d '{"name": "campaign-assets"}'
```

Idempotency applies to **mutating methods only** — `POST`, `PUT`, `DELETE`, and
`PATCH`. `GET` requests are naturally idempotent and ignore the header. Requests
without the header are unaffected and incur no extra overhead.

## How replays work

The first request with a given key runs normally and its successful response
(any `2xx`) is stored. A subsequent request with the **same key, method, and URL**
replays the stored status code and body, with an extra header:

```
idempotency-replayed: true
```

Stored responses are kept for **24 hours**, after which the key is forgotten and a
new request with that key executes fresh.

::: info Keys are scoped per principal, org, and URL
The cache key combines your `Idempotency-Key` with the **caller** (user or API key),
the **organization**, and the **full request URL including query string**. The same
key used by a different caller, a different org, or a different URL is treated as a
distinct request — so keys never collide across tenants.
:::

::: warning Reuse a key only for the same operation
Idempotency keys identify a specific operation. Reusing a key for a genuinely
different request (different body but same method + URL) returns the **original**
stored response, not a new result. Generate a fresh key per distinct operation.
:::

## Fail-open behavior

Idempotency is backed by Redis and **fails open**: if Redis is briefly unavailable,
the request proceeds normally without idempotency rather than failing. Don't rely on
idempotency as a correctness guarantee for non-retry-safe operations during an outage.

## Excluded endpoints

The Stripe webhook (`/api/stripe/webhook`) never participates in idempotency — it is
unauthenticated and Stripe provides its own at-least-once delivery with event-ID
deduplication handled by the billing layer.
