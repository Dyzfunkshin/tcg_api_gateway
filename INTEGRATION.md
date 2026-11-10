# Integrating with the TCG API gateway

The gateway (`tcg-api-gateway`, a Cloudflare Worker) is the only way to reach the
TCG pricing and catalog services from outside the Droplet. You call the gateway;
it identifies you, checks your policy, and forwards to the service.

> **Status (built through G5, not yet deployed).** Production
> `https://api.dyzzyscards.com` (and `api.mintuition.app`) is still served by `sourcery-gateway` (or unattached) until
> cut-over step G3 (see [docs/PLAN.md](docs/PLAN.md) section 8).

## Base URL and path scheme

The gateway is served on two hostnames with identical behaviour: `api.dyzzyscards.com`
(use this for all clients) and `api.mintuition.app` (used by the Mintuition extension).
Everything below applies to both; examples use `api.dyzzyscards.com`.

```
https://api.dyzzyscards.com/pricing/v1/<rest>   ->  pricing  /v1/<rest>
https://api.dyzzyscards.com/catalog/v1/<rest>   ->  catalog  /v1/<rest>
https://api.dyzzyscards.com/v1/<route>          ->  the gateway's own routes
```

The rest of the path is forwarded verbatim and the query string is preserved.
Request and response bodies are the services' own: **each service's
`INTEGRATION.md` is the contract for its routes**
(`_services/tcg_pricing_service/INTEGRATION.md`,
`_services/tcg_catalog_service/INTEGRATION.md`).

## Routes the gateway knows

| Route | Service route |
|---|---|
| `GET /pricing/v1/health` | pricing health — **open to every caller, no credential** (used by pricing's tcgcsv freshness alert) |
| `POST /pricing/v1/prices/quote` | quote (JSON array body) |
| `GET /pricing/v1/prices/product/<digits>` | per-product prices |
| `GET /pricing/v1/history`, `/history/printings`, `/history/coverage` | price history |
| `GET /pricing/v1/games` | games pricing covers |
| `GET /catalog/v1/health` | catalog health |
| `GET /catalog/v1/manifest.json` | artifact manifest |
| `GET /catalog/v1/artifacts/<file>` | content-hashed artifact |
| `GET /catalog/v1/images/<file>` | scan-tier image |
| `GET /catalog/v1/products/<digits>`, `POST /catalog/v1/products:lookup` | product facts |
| `GET /catalog/v1/games` | catalog game lines |
| `GET /catalog/v1/tags`, `POST /catalog/v1/tags/<eqKey>` | tags (the POST is a write, granted to no client by default) |
| `GET /v1/health` | gateway config check, no upstream call: `{ok, origins:{pricing, catalog}}` |
| `POST /v1/license/activate`, `POST /v1/license/deactivate`, `GET /v1/license` | Mintuition licence lifecycle (Polar) |
| `POST /v1/session` | public browser session from a Turnstile proof (see below) |

Knowing a route is not permission to call it: **your client's policy lists the
routes you may call.** `<file>` is one path segment of `[A-Za-z0-9._-]`, not
starting with a dot.

## Authentication

Send exactly one credential:

| Client kind | Header(s) |
|---|---|
| Server-side app | `Authorization: Bearer <app key>` (64 hex chars, issued per app) |
| Mintuition extension | `Authorization: Bearer <licence key>` + `X-Instance-Id: <activation id>` |
| Public website (poke-guide) | `Authorization: Session <token>` from `POST /v1/session`, sent from the same `Origin` |
| Open routes only (`GET /v1/health`, `POST /v1/license/activate`, `POST /v1/session`, `GET /pricing/v1/health`) | no `Authorization` header (per-IP rate limited) |

App keys are matched first (by SHA-256); a key that is not an app key is treated
as a licence when `X-Instance-Id` is present. **A credential that is present but
invalid is always refused with 401**; it never falls back to anonymous access.

To get an app key, add a policy row to `src/clients.js` (routes, fill policy,
quota) and store the key in Bitwarden (project `api-gateway`,
`TCG_GATEWAY_APP_KEY_<APP>`); see [docs/PLAN.md](docs/PLAN.md) section 6.4.

## Public browser sessions (poke-guide)

A public site cannot keep a secret, so it proves a Cloudflare Turnstile challenge
instead and gets a short-lived, read-only session:

1. Embed an invisible Turnstile widget (the **site key** is public; it lives in the
   site's code), rendered with the action `gateway-session` (`data-action="gateway-session"`
   or the `action` render option); a token from a widget without that action is
   refused with `403 turnstile_failed`. When it yields a widget token, call
   `POST /v1/session` with body `{"turnstileToken": "<widget token>"}` and
   **no `Authorization` header**. Its `Origin` must be exactly one of the client's
   origins (`https://poke-guide.com`, preview `https://dyzfunkshin.github.io`).
2. Response `200 {token, expiresAt, ttlSeconds}` (30 minutes). Send
   `Authorization: Session <token>` on every call, from the same origin.
3. Refresh before `expiresAt` (a fresh widget token, step 1). After expiry calls
   return `401 session_expired`. **Never send the old token to `/v1/session`**:
   any credential sent there is checked, and an expired one is refused.

The session is not tied to the visitor's IP. It may read prices (quote, max
**100 items** per call, always cache-only: `x-fill-policy: none`), price
history, product facts, games lists, the catalog manifest, artifacts and images.
It cannot write, look up products in bulk, or spend JustTCG budget.

### poke-guide client contract

**Session lifecycle.** `POST /v1/session`, body `{"turnstileToken": "<widget token>"}`,
`Content-Type: application/json`, no `Authorization` header. Success is
`200 {token, expiresAt, ttlSeconds}` with `Cache-Control: no-store`. The token lives
`SESSION_TTL_SECONDS` (default **1800 s**, 30 minutes). Refresh it *before*
`expiresAt` (get a fresh widget token and call `/v1/session` again). If any call
still returns `401` (`session_expired` or `session_invalid`), re-issue the session
**once** and retry the call once; if that fails too, surface the error. Never send
the old token to `/v1/session`: a credential sent there is checked, and an expired
one is refused.

**Routes poke-guide may call** (exactly its policy in `src/clients.js`; anything
else is `403 forbidden`):

- `POST /pricing/v1/prices/quote` (max 100 items)
- `GET /pricing/v1/prices/product/<digits>`
- `GET /pricing/v1/history`, `/history/printings`, `/history/coverage`
- `GET /pricing/v1/games`
- `GET /catalog/v1/manifest.json`
- `GET /catalog/v1/artifacts/<file>`
- `GET /catalog/v1/images/<file>`
- `GET /catalog/v1/products/<digits>`
- `GET /catalog/v1/games`

**Errors a public client should handle** (all JSON `{error, ...}`):

| Status | `error` | Meaning / action |
|---|---|---|
| 401 | `session_invalid` | bad, foreign or wrong-origin token: re-issue once |
| 401 | `session_expired` | token past `expiresAt`: re-issue once |
| 403 | `forbidden` | route not in the poke-guide policy |
| 403 | `origin_not_allowed` | `Origin` is not one of the client's origins |
| 403 | `turnstile_failed` | challenge not solved, solved on another site, or the widget lacks the `gateway-session` action |
| 413 | `payload_too_large` | body over 1 MB (also for a chunked body with no `Content-Length`) |
| 413 | `batch_too_large` (`{"error":"batch_too_large","max":100}`) | quote batch over 100 items: split it |
| 429 | `quota_exceeded` (`scope: "minute"`) | back off for the `Retry-After` seconds; limited per IP (an IPv6 /64) and per session token |
| 502 | `origin_unavailable` | the service failed or is unreachable |
| 503 | `turnstile_unavailable` | Turnstile down: retry after `Retry-After` |
| 503 | `session_not_configured` / `origin_not_configured` | gateway misconfigured |

**CORS.** The gateway answers preflights (`OPTIONS`, 204) and sets
`Access-Control-Allow-Origin` only on an **exact** match of the request `Origin`
against the client origins (`https://poke-guide.com`, preview
`https://dyzfunkshin.github.io`); `Vary: Origin` is always set with it. Allowed
request headers: `authorization, content-type, x-instance-id`; methods `GET, POST,
OPTIONS`. Exposed response headers: `X-Quota-Remaining, Retry-After, ETag`.

**No gateway caching.** The gateway does not cache. Every allowed call, quotes
included, reaches the service, and the response is the service's own, passed
through unchanged (status, body, `content-type`, `ETag`, `Cache-Control`).
Caching, if any, is set by the service's own `Cache-Control`.

### Compression

Large JSON (a catalog artifact is ~50 MB raw; the price snapshot file below is
similar in kind) is **streamed** by the gateway, not buffered. The gateway keeps the
upstream `content-type`, never adds `Cache-Control: no-transform`, and does not set
`Content-Encoding` itself. Cloudflare's edge compresses the response (br/gzip) for
clients that send `Accept-Encoding`, so the browser receives
`Content-Encoding: br` or `gzip` and decodes it transparently. Wire compression is
verified by a live probe (`curl -H 'Accept-Encoding: br' -I` on a large artifact)
once the gateway is live, not by the offline tests.

### Pending routes (not yet available)

**Not allow-listed: both return `404 not_found` today.** The gateway allows a path only
after the owning service's own `INTEGRATION.md` defines it. What these routes return is
`tcg_pricing_service`'s contract, not the gateway's.

- `GET /pricing/v1/prices/snapshot/manifest.json`
- `GET /pricing/v1/prices/snapshot/<file>`

## What the gateway adds and removes

- Forwarded requests carry only your `content-type` and `accept`. Every other
  header you send is dropped, including `x-fill-policy`.
- Every pricing request carries the `x-fill-policy` **from your policy**
  (`none` = cache-only, never spends JustTCG budget; `default` = may fill).
- Responses are the service's own, passed through unchanged: status, body,
  `content-type`, `ETag`, `Cache-Control`, plus `X-Quota-Remaining` (your daily
  quota) for credentialed calls and CORS headers. The gateway caches nothing.
- Request bodies are capped at 1 MB; a policy may also cap quote batches.

## Legacy paths (temporary)

Old Mintuition-extension paths keep working and are logged as `legacy_alias`; they are
removed at G7: `POST /v1/prices/quote`, `POST /v1/products:lookup`,
`GET /v1/products/<id>`, `GET /v1/prices/games`, `GET /v1/catalog/games`.

## Errors

All errors are JSON `{error, ...}`.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_body` | e.g. quote body is not a JSON array |
| 401 | `credential_required` | the route needs a credential and none was sent |
| 401 | `credential_invalid` | malformed `Authorization` header |
| 401 | `license_required` | bearer key is not an app key and has no `X-Instance-Id` |
| 401 | `license_invalid` | licence unknown or rejected by Polar |
| 402 | `license_inactive` | licence expired, revoked or disabled (`status` says which) |
| 403 | `forbidden` | your policy does not include this route |
| 404 | `not_found` | unknown path |
| 405 | `method_not_allowed` | known path, wrong method (`Allow` header lists methods) |
| 409 | `activation_limit` | licence activation limit reached |
| 413 | `payload_too_large` / `batch_too_large` | body over 1 MB (declared or chunked) / quote batch over your policy's `max` |
| 429 | `quota_exceeded` | `scope` `minute` or `day`; honour `Retry-After` |
| 429 | `license_attempts_exceeded` | too many licence checks (validate, activate, deactivate) from one IP in a minute; sent with `Retry-After: 60` |
| 502 | `origin_unavailable` | the service failed or is unreachable |
| 503 | `origin_not_configured` / `license_service_unavailable` | gateway misconfigured / Polar down or the gateway's Polar budget spent (with `Retry-After`; a recently checked licence keeps working) |

## Smoke test

```
curl -s https://<gateway host>/v1/health
# {"ok":true,"origins":{"pricing":true,"catalog":true}}
```
