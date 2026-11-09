# Sourcery gateway

A Cloudflare Worker that is the only public entry for the Sourcery browser extension. It validates a Polar license key, enforces per-key quotas, and forwards allow-listed routes to two private origins (pricing and catalog), injecting each origin's service token. No npm dependencies at runtime or for tests (ES modules, Node 22).

## Routes

Auth (`Authorization: Bearer <license key>` plus `X-Instance-Id`) is required on every route except `OPTIONS`, `GET /v1/health` and `POST /v1/license/activate`. Authed responses carry `X-Quota-Remaining` (daily).

| Route | Auth | Behaviour |
|---|---|---|
| `GET /v1/health` | no | `{ok, origins:{pricing, catalog}}` (booleans = configured; no upstream call) |
| `POST /v1/license/activate` | no | body `{licenseKey, instanceName}`; 200 `{instanceId, status, expiresAt, activationLimit, activationUsage, tier}`; 409 `activation_limit`; 401/402 as below |
| `POST /v1/license/deactivate` | yes | deactivates this instance, clears the cached verdict; 200 `{deactivated:true}` |
| `GET /v1/license` | yes | `{status, expiresAt, activationLimit, activationUsage, benefitId, tier}` (`activationUsage` is always `null`: Polar does not report usage on validate; `tier` is a string or `null`, see Tiers) |
| `POST /v1/prices/quote` | yes | body must be a JSON array, max 1 MB; forwarded to `PRICING_ORIGIN/v1/prices/quote` with `x-app-token` and `x-fill-policy` (chosen by the key's tier, see Tiers) |
| `POST /v1/products:lookup` | yes | forwarded to `CATALOG_ORIGIN` with `x-app-token` |
| `GET /v1/prices/games` | yes | the pricing service's `GET /v1/games` (games it prices), with `x-app-token`; kept an hour |
| `GET /v1/catalog/games` | yes | the catalog service's `GET /v1/games` (game lines and product counts), with `x-app-token` |
| `GET /v1/products/<digits>` | yes | forwarded to `CATALOG_ORIGIN`, query string preserved |

Anything else is 404 `{error:"not_found"}`; a known path with the wrong method is 405. Forwarding strips every client header except `content-type` and `accept`, and copies back only status, `content-type`, body, `ETag` and `Cache-Control`. Origin 5xx or network failure is 502 `origin_unavailable`; an unconfigured origin is 503 `origin_not_configured`.

Error codes: `license_required` (401), `license_invalid` (401), `license_inactive` (402, with `status`), `quota_exceeded` (429, `scope` `day` or `minute`, `Retry-After`), `license_service_unavailable` (503), `payload_too_large` (413), `invalid_body` (400), `deactivation_failed` (400), `activation_limit` (409).

Verdict rules for a Polar `200`, in order: wrong or unset `POLAR_ORGANIZATION_ID` -> 401; `benefit_id` outside `POLAR_BENEFIT_IDS` (when set; when it is empty and `POLAR_TIERS` is set, outside the `POLAR_TIERS` benefit ids) -> 401; status `expired`/`revoked`/`disabled` or `expires_at` in the past -> 402. Polar has no `valid` boolean: a `200` from validate is the only "valid" signal.

Polar errors map as follows. Validate `404` (not found, revoked, disabled, expired, or the activation does not match) is cached as an invalid verdict for `LICENSE_CACHE_SECONDS`: a `detail` matching `expired|revoked|disabled` -> 402 `license_inactive` (`status` = the matched word), anything else -> 401 `license_invalid` (the detail is logged with the key-hash prefix). Validate `400`/`422` -> 401, not cached. Activate `403` -> `detail` containing "limit" -> 409 `activation_limit`, `expired|revoked|disabled` -> 402, otherwise 401; activate `404` -> 401. Deactivate `204` and `404` both clear the cached verdict and answer 200 `{deactivated:true}`. A `5xx`, `429`, network error or non-JSON answer from Polar is "unavailable".

Verdicts are cached in KV (`lic:<sha256(key|activation id)>`; the extension sends the Polar activation id as `X-Instance-Id`) for `LICENSE_CACHE_SECONDS`. If Polar is unavailable, a cached valid verdict younger than `LICENSE_GRACE_SECONDS` is reused; otherwise 503. Quota counters (`q:<sha256(key)>:<UTC date>`, `b:<sha256(key)>:<unix minute>`) are per license key, shared across its activations. KV has no atomic increment, so counters are approximate. License keys are never logged, only a hash prefix.

## Tiers

Two Polar products (one License Keys benefit each) map to two tiers through `POLAR_TIERS`:

- **Basic**: cached NM / product-level prices only. Quotes go out with `x-fill-policy: none`.
- **Pro**: per-condition prices; the pricing service may spend JustTCG budget to fill them. Quotes go out with `x-fill-policy: default`.

The verdict's `benefit_id` is looked up in `POLAR_TIERS` when the verdict is built, and the resulting `tier` (string, or `null` when the benefit has no tier) is cached with the verdict and returned by `GET /v1/license` and activate. The quote route sends the policy `FILL_POLICY_BY_TIER` gives that tier; a key with no tier gets `FILL_POLICY`. `POLAR_BENEFIT_IDS` still works as the allow-list; when it is empty, the `POLAR_TIERS` benefit ids are the allow-list. Verdicts cached before a `POLAR_TIERS` change keep their old tier until they are re-validated (`LICENSE_CACHE_SECONDS`).

CORS: an `Origin` starting with one of `ALLOWED_ORIGIN_PREFIXES` gets the CORS headers on every response; preflight is 204. Other origins get no CORS headers (the browser blocks them) but are still processed.

## Env

| Name | Kind | Meaning | Default |
|---|---|---|---|
| `POLAR_ORGANIZATION_ID` | var | Polar organization id, sent as `organization_id`; a key whose `organization_id` differs is rejected 401 | `""` (empty rejects every key and logs why; Polar is not called) |
| `POLAR_BENEFIT_IDS` | var | comma list of License Keys benefit ids that grant access (checked against the response's `benefit_id`); empty = any benefit of the organization | `""` |
| `POLAR_TIERS` | var | comma list of `<benefit_id>:<tier>` pairs, e.g. `fb9ee746-...:basic,1234abcd-...:pro`; sets the verdict's `tier`; when `POLAR_BENEFIT_IDS` is empty its benefit ids are the allow-list | `""` |
| `POLAR_API_BASE` | var | Polar API base URL; `https://sandbox-api.polar.sh` for testing | `https://api.polar.sh` |
| `PRICING_ORIGIN` | var | base URL of the private pricing origin | `""` |
| `PRICING_APP_TOKEN` | secret | sent as `x-app-token` to pricing | |
| `CATALOG_ORIGIN` | var | base URL of the private catalog origin | `""` |
| `CATALOG_APP_TOKEN` | secret | sent as `x-app-token` to catalog | |
| `FILL_POLICY` | var | `x-fill-policy` for a key whose benefit has no tier | `none` |
| `FILL_POLICY_BY_TIER` | var | comma list of `<tier>:<policy>` pairs; the `x-fill-policy` sent on quotes for that tier | `basic:none,pro:default` |
| `DAILY_QUOTA` | var | requests per key per UTC day | `2000` |
| `BURST_PER_MINUTE` | var | requests per key per minute | `60` |
| `LICENSE_CACHE_SECONDS` | var | how long a validate verdict is cached | `600` |
| `LICENSE_GRACE_SECONDS` | var | how long a cached valid verdict may be reused when Polar is unavailable | `86400` |
| `ALLOWED_ORIGIN_PREFIXES` | var | comma list of allowed `Origin` prefixes | `chrome-extension://,moz-extension://` |

An origin counts as configured only when both its `*_ORIGIN` and `*_APP_TOKEN` are set.

## Polar contract

Implemented in `src/polar.js` and verified against polar.sh/docs on 2026-11-05; it has not yet been exercised against a live organization. The three endpoints are public (no auth header, no API key) and take JSON.

```
POST {POLAR_API_BASE}/v1/customer-portal/license-keys/activate
  body { key, organization_id, label, meta? }
  200 -> { id, license_key_id, label, meta, created_at, modified_at,
           license_key:{ id, organization_id, customer_id, benefit_id, key, display_key,
                         status:"granted", limit_activations, usage, limit_usage,
                         validations, last_validated_at, expires_at } }
  403 { error:"NotPermitted", detail }   revoked, disabled, expired, no activation support, or limit reached
  404 { error:"ResourceNotFound", detail }   key not found;   422 validation error

POST {POLAR_API_BASE}/v1/customer-portal/license-keys/validate
  body { key, organization_id, activation_id?, benefit_id?, conditions?, increment_usage? }
  200 -> { id, organization_id, customer_id, benefit_id, key, display_key, status:"granted",
           limit_activations, usage, limit_usage, validations, last_validated_at,
           expires_at (null = never), activation:{id,label,...}|null }
  400 BadRequest (usage increment exceeded; never sent)
  404 { error:"ResourceNotFound", detail }   not found, revoked, disabled, expired, or activation mismatch
  422 validation error

POST {POLAR_API_BASE}/v1/customer-portal/license-keys/deactivate
  body { key, organization_id, activation_id }
  204 no body;   404 key or activation not found
```

Things to confirm once a real key exists: the exact `detail` wording on `403` (the gateway looks for "limit" and for `expired|revoked|disabled`) and on validate `404`.

## Tests

From the repo root: `node gateway/test/run.js` (or `npm run test:gateway`), or `npm test` inside `gateway/`. Plain `node:assert` with a fake KV and a fake `fetch`; prints `sourcery-gateway: N checks passed` and exits non-zero on any failure.

## Deploy (owner)

From `gateway/`:

1. `npx wrangler kv namespace create LICENSES`, then put the printed id in `wrangler.toml`.
2. Fill the `[vars]` in `wrangler.toml` (`POLAR_ORGANIZATION_ID`, `POLAR_BENEFIT_IDS`, `PRICING_ORIGIN`, `CATALOG_ORIGIN`).
3. `npx wrangler secret put PRICING_APP_TOKEN` and `npx wrangler secret put CATALOG_APP_TOKEN`.
4. `npx wrangler deploy`.

## Needed from Polar (owner)

- The organization id, from the Polar dashboard (Settings); set it as `POLAR_ORGANIZATION_ID`. The gateway rejects every key until it is set.
- A product with the License Keys benefit attached, with the activation limit set on that benefit (Polar enforces it; a key without an activation limit cannot be limited). Customers receive the license key when they buy.
- Optional: the benefit id for `POLAR_BENEFIT_IDS` (empty accepts any benefit of the organization).
- To test without real money, create the organization, product and benefit in the Polar sandbox (`https://sandbox.polar.sh`) and set `POLAR_API_BASE = "https://sandbox-api.polar.sh"`. Sandbox organization ids differ from production ones, so switch both vars together.
- A real license key to verify the contract above end to end.

## Sandbox (verified live 2026-11-05)

The contract above was driven end to end against the Polar sandbox with the real worker: activate, cached validate (no Polar call), a wrong activation id (Polar 404 "Not found" → 401), the activation limit (Polar 403 "License key activation limit already reached" → 409), deactivate (204), validate after deactivate (→ 401) and an unknown key (→ 401). The expired/revoked wording is still unverified.

| sandbox object | id |
|---|---|
| organization "Dyzzy's Cards" | `3a6001fe-6581-43e2-810d-48c8febbae1d` |
| License Keys benefit (prefix `SRC`, 3 activations, no expiry) | `fb9ee746-6350-4713-b418-c76eccfef570` |
| product "Sourcery", $10/month | `971ce5bb-ea8e-4096-aef2-69832765542e` |
| Pro License Keys benefit (prefix `SRCP`, 3 activations, no expiry) | `0917b3fb-a187-421a-8b7a-05575df57101` |
| product "Sourcery Pro", $20/month | `b748ce47-d1ef-4783-895c-ae7ebdd4da33` |

Sandbox `POLAR_TIERS`: `fb9ee746-6350-4713-b418-c76eccfef570:basic,0917b3fb-a187-421a-8b7a-05575df57101:pro`.

Polar's license endpoints are limited to 3 requests a second and answer 429 with a `Retry-After` of 30–40 s once tripped; the gateway passes that header through on its 503. Space any live test calls about 40 s apart. Management calls (creating products, listing keys) need an organization access token, a real `User-Agent` (Cloudflare blocks the default Python one), trailing slashes on paths, and no `organization_id` in request bodies.
