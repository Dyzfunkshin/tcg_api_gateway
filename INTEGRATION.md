# Integrating with the TCG API gateway

The gateway (`tcg-api-gateway`, a Cloudflare Worker) is the only way to reach the
TCG pricing and catalog services from outside the Droplet. You call the gateway;
it identifies you, checks your policy, and forwards to the service.

> **Status (G1, not yet deployed).** Production `https://api.dyzzyscards.com` is
> still served by `sourcery-gateway` until cut-over step G3 (see
> [docs/PLAN.md](docs/PLAN.md) section 8). Public browser sessions
> (`POST /v1/session`) arrive at G5.

## Base URL and path scheme

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
| `POST /v1/license/activate`, `POST /v1/license/deactivate`, `GET /v1/license` | Sourcery licence lifecycle (Polar) |

Knowing a route is not permission to call it: **your client's policy lists the
routes you may call.** `<file>` is one path segment of `[A-Za-z0-9._-]`, not
starting with a dot.

## Authentication

Send exactly one credential:

| Client kind | Header(s) |
|---|---|
| Server-side app | `Authorization: Bearer <app key>` (64 hex chars, issued per app) |
| Sourcery extension | `Authorization: Bearer <licence key>` + `X-Instance-Id: <activation id>` |
| Open routes only (`GET /v1/health`, `POST /v1/license/activate`, `GET /pricing/v1/health`) | no `Authorization` header (per-IP rate limited) |

App keys are matched first (by SHA-256); a key that is not an app key is treated
as a licence when `X-Instance-Id` is present. **A credential that is present but
invalid is always refused with 401**; it never falls back to anonymous access.

To get an app key, add a policy row to `src/clients.js` (routes, fill policy,
quota) and store the key in Bitwarden (project `poke-scans`,
`TCG_GATEWAY_APP_KEY_<APP>`); see [docs/PLAN.md](docs/PLAN.md) section 6.4.

## What the gateway adds and removes

- Forwarded requests carry only your `content-type` and `accept`. Every other
  header you send is dropped, including `x-fill-policy`.
- Every pricing request carries the `x-fill-policy` **from your policy**
  (`none` = cache-only, never spends JustTCG budget; `default` = may fill).
- Responses carry status, body, `content-type`, `ETag`, `Cache-Control`, plus
  `X-Quota-Remaining` (your daily quota) for credentialed calls.
- Request bodies are capped at 1 MB; a policy may also cap quote batches.

## Legacy paths (temporary)

Old Sourcery paths keep working and are logged as `legacy_alias`; they are
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
| 413 | `payload_too_large` / `batch_too_large` | body over 1 MB / quote batch over your policy's `max` |
| 429 | `quota_exceeded` | `scope` `minute` or `day`; honour `Retry-After` |
| 502 | `origin_unavailable` | the service failed or is unreachable |
| 503 | `origin_not_configured` / `license_service_unavailable` | gateway misconfigured / Polar down (with `Retry-After`) |

## Smoke test

```
curl -s https://<gateway host>/v1/health
# {"ok":true,"origins":{"pricing":true,"catalog":true}}
```
