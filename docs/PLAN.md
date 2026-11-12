# TCG API gateway — the single front door

**Status:** plan, agreed in principle 2026-11-08; open points settled
2026-11-09 (section 11). Built and tested offline, nothing deployed: G0, G1,
the gateway half of G2 (`/pricing/v1/health` open), the Worker half of G4
(Access service-token headers) and the Worker half of G5 (sessions; its edge
and quote caches were later removed, decision 26), each on its own `feature/g<n>-…` branch, all merged
into `dev`. The Cloudflare token `tcg-api-gateway` has its permissions and is
in Bitwarden (`api-gateway`); deploys use the `gateway-deploy` machine token on
the PC (section 7). Still outside code: G2's alert repoint (after deploy), G4's Zero Trust
setup, G5's Turnstile widget and the two G5 secrets.
**Owner repo:** `_services/tcg_api_gateway` (this repo).
**Replaces:** `_apps/sourcery/gateway` (the Sourcery-only Worker at `api.dyzzyscards.com`).

## 1. What this is and why

One Cloudflare Worker at `https://api.dyzzyscards.com` that is the **only**
way anything outside the Droplet reaches the TCG services. Every external
client (the Sourcery extension, the poke-guide website, future apps) talks to
this Worker; the Worker decides who the caller is, what that caller may do,
and forwards allowed requests to the private services with the services' own
credentials attached.

Why one front door:

- **Access management in one place.** Adding, restricting, or revoking a
  client is a change here, never in a service.
- **The services stay simple and private.** Pricing and catalog keep their one
  shared app token each and never learn about licence keys, browsers, or
  quotas. They accept traffic only from this Worker.
- **Pass-through, never a cache.** The gateway controls access and
  throughput only; every allowed request goes to its service and the answer
  comes back unchanged (decision 26). If origin load ever matters, the
  services set their own `Cache-Control` and Cloudflare caches on that.
- **It already mostly exists.** `sourcery/gateway` already does route
  allow-listing, service-token injection, CORS, per-key quotas, Polar licence
  validation, and per-tier `x-fill-policy`. This repo generalises that code
  from "one product's gateway" into "the platform's gateway". Start by copying
  `sourcery/gateway/src/{worker,polar,kv}.js` and `test/run.js` (at sourcery
  commit `401b189`) and refactor; do not rewrite from scratch.

## 2. What sits behind it

All on the Droplet (`deploy@159.203.114.223`), on the shared Docker network
`sourcery`, reached through the one Cloudflare Tunnel
(`30b1fc11-8979-4165-9bd5-d676baa2948d`, two `cloudflared` replicas in the
pricing stack):

| Service | Repo | Tunnel hostname (today) | Its auth | Routes it serves |
|---|---|---|---|---|
| Pricing | `_services/tcg_pricing_service` | `pricing-origin.dyzzyscards.com` | `x-app-token` (`APP_TOKEN`); `x-fill-policy: none\|default` chooses whether a quote may spend JustTCG budget | `GET /v1/health` (open), `POST /v1/prices/quote`, `GET /v1/prices/product/:id`, `GET /v1/history`, `GET /v1/history/printings`, `GET /v1/history/coverage`, `GET /v1/games` |
| Catalog | `_services/tcg_catalog_service` | `catalog-origin.dyzzyscards.com` | `x-app-token` (`CATALOG_APP_TOKEN`) | `GET /v1/health`, `GET /v1/manifest.json`, `GET /v1/artifacts/<file>` (content-hashed, immutable), `GET /v1/images/<file>`, `GET /v1/products/<id>`, `POST /v1/products:lookup`, `GET /v1/games`, `GET /v1/tags`, `POST /v1/tags/<eqKey>` (**a write**) |

Not behind it: the catalog repo's corrections-service (port 8441) is
loopback-only operator tooling and stays that way. Each service's
`INTEGRATION.md` is the authoritative route contract; the Worker's
allow-list must be kept in sync with them.

## 3. URL scheme

```
https://api.dyzzyscards.com/pricing/v1/<rest>   ->  pricing  /v1/<rest>
https://api.dyzzyscards.com/catalog/v1/<rest>   ->  catalog  /v1/<rest>
https://api.dyzzyscards.com/v1/<gateway-route>  ->  the gateway's own routes
```

Each service keeps its own version segment, so a service can ship `/v2`
without the gateway changing its scheme. The gateway forwards the rest of the
path verbatim and preserves the query string. A path is forwarded **only** if
the caller's policy allows that method + path pattern (section 5); everything
else is `404 {error:"not_found"}`, and a known path with the wrong method is
`405`.

Gateway-owned routes:

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/health` | none | `{ok, origins:{pricing, catalog}}` — configuration only, no upstream call (as today) |
| `POST /v1/license/activate`, `POST /v1/license/deactivate`, `GET /v1/license` | as today | Sourcery licence lifecycle (Polar), unchanged |
| `POST /v1/session` | Turnstile token + allowed `Origin` | Exchanges a Turnstile proof for a short-lived public session token (section 6.3) |

**Legacy aliases (temporary).** Installed copies of the Sourcery extension
call today's paths. Keep these working, mapped onto the new routes, until the
extension has shipped a version using the new scheme and old installs have
aged out:
`POST /v1/prices/quote` -> `/pricing/v1/prices/quote`,
`POST /v1/products:lookup` -> `/catalog/v1/products:lookup`,
`GET /v1/products/<id>` -> `/catalog/v1/products/<id>`,
`GET /v1/prices/games` -> `/pricing/v1/games`,
`GET /v1/catalog/games` -> `/catalog/v1/games`.
Log alias hits so you can see when they reach zero.

## 4. Locking the services so only the gateway can reach them

Today both tunnel hostnames are publicly resolvable. Everything except health
already needs an app token, but anyone can reach the origin and try. Target:
**nothing but this Worker can reach either service.**

1. **Cloudflare Access in front of both tunnel hostnames.** In Zero Trust,
   create one self-hosted Access application per hostname
   (`pricing-origin.dyzzyscards.com`, `catalog-origin.dyzzyscards.com`) with a
   single **Service Auth** policy that allows one **service token**
   ("tcg-api-gateway"). Every request without valid
   `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers is refused at
   Cloudflare's edge and never reaches the Droplet. The Worker sends those two
   headers on every forwarded request. Service tokens are free on the Zero
   Trust free plan.
2. **Keep the app tokens.** The Worker still sends `x-app-token`, so a leaked
   Access token alone opens nothing (defence in depth). Rotate either
   independently.
3. **The Droplet keeps no inbound ports except SSH.** The tunnel is an
   outbound connection, so with step 1 in place the services have no public
   ingress at all. Check the DigitalOcean firewall allows only 22 inbound.
4. **Verify the lock** after enabling: `curl -s -o /dev/null -w "%{http_code}"
   https://pricing-origin.dyzzyscards.com/v1/health` must return an Access
   denial (403, or a 302 to the Access login), not 200.

Knock-on change: pricing's tcgcsv freshness alert
(`tcg_pricing_service/.github/workflows/tcgcsv-freshness.yml`) polls
`https://pricing-origin.dyzzyscards.com/v1/health` directly. Before step 1,
expose `GET /pricing/v1/health` through the gateway (open, read-only) and
repoint the alert at `https://api.dyzzyscards.com/pricing/v1/health`.
Otherwise the alert starts failing the moment the lock goes on.

Alternative considered: a Workers VPC / private-network binding to the tunnel,
which needs no Access application. It is newer and less proven; prefer Access
and revisit later.

## 5. Clients and policies (one table, one place)

Every request is attributed to exactly one **client**, and every client has
one **policy**. Policies live in code (`src/clients.js`) as a frozen table,
reviewed like code; credentials live in Bitwarden (section 7). A policy says:

- `auth`: how the client proves who it is (`license`, `app-key`, `public-session`, `none`)
- `routes`: allowed `METHOD /service/v1/path-pattern` entries
- `fillPolicy`: the `x-fill-policy` the gateway sends to pricing. **Always set
  by the gateway, never taken from the client**; any client-sent value is
  stripped.
- `quota`: per-day and per-minute limits, and what they are keyed on (licence
  key, app key, or IP)
- `origins`: allowed browser `Origin` prefixes (CORS), if any

### Who needs access

| Client | Today | Kind | Auth | Allowed | Fill policy | Notes |
|---|---|---|---|---|---|---|
| **Sourcery extension** | Live, via `sourcery/gateway` | Browser extension, paid | `license`: Polar licence key + `X-Instance-Id`, verdict cached in KV (unchanged) | quote, products lookup/get, both games lists, licence routes | by tier: `basic:none`, `pro:default` (unchanged) | Origins `chrome-extension://`, `moz-extension://`. Quotas per key as today (`DAILY_QUOTA=20000`, `BURST_PER_MINUTE=300`). |
| **poke-guide website** (poke-guide.com) | Reads static snapshots from R2 (`data.poke-guide.com`) | Public static site | `public-session` (section 6.3) | Reads only: `POST pricing/v1/prices/quote` (fill policy forced to `none`, **max 100 items per call**), and GET `pricing/v1/prices/product/:id`, `pricing/v1/history*`, `pricing/v1/games`; `catalog/v1/manifest.json`, `catalog/v1/artifacts/*`, `catalog/v1/images/*`, `catalog/v1/products/*`, `catalog/v1/games` | **`none`, forced** | Origins `https://poke-guide.com` (+ preview origin). Per-IP limits. Migration is the poke_guide huddle. |
| **Server-side apps**: poke-scans backend, Binder_v2 backend, ops tools, monitors | All point at `localhost:8430/8440` today | Code that can keep a secret | `app-key`: one key per app, `Authorization: Bearer <key>` | per app, least privilege | per app (`default` only where the app genuinely needs per-condition fills) | Keys stored hashed (SHA-256) in the policy table, plaintext only in Bitwarden. |
| **Browser apps of our own**: Binder web, poke-scans frontend | localhost today | Public code | `public-session`, own client id and origins | per app | `none` unless proxied through that app's own backend | Anything that must spend JustTCG budget goes through a backend with an app key, never straight from a browser. |
| **Binder mobile** | localhost today | Native app, public code | **Open question**: Turnstile is web-only. Options: route through Binder_v2 backend (app key), or a per-install token like Sourcery's activation. | — | `none` | Decide before mobile ships against production. |
| **Pricing freshness alert** (GitHub Actions) | Polls pricing-origin health directly | Monitor | `none` (health is open) | `GET /pricing/v1/health` only | — | See section 4. |
| **TCG_TestHarness** | localhost dev tool | Local only | n/a | — | — | Stays on localhost; no production access needed. |

Write routes (`POST /catalog/v1/tags/<eqKey>`) are granted to **no** client by
default. Grant one explicitly, to an `app-key` client only, if a real need
appears.

## 6. How access is provided and restricted

### 6.1 Request pipeline (every request)

1. Match the route. Unknown path -> 404, wrong method -> 405, before any auth
   work.
2. Identify the client from its credential. Licences and app keys share one
   header, `Authorization: Bearer <key>`; public sessions use
   `Authorization: Session <token>`. Resolution order for `Bearer`:
   1. Look up `sha256(key)` in the app-key table. An exact match is that app
      key's client. (A licence can never match an app-key hash, so this never
      depends on a header Sourcery might drop.)
   2. Otherwise, if `X-Instance-Id` is present, treat the key as a Sourcery
      licence (section 6.2).
   3. Otherwise -> 401.

   **A credential that is present but invalid (bad, expired, revoked,
   unknown, malformed) is refused immediately; it never falls back to the
   `none` client.** Only a request with no `Authorization` header at all is
   the `none` client, which may only reach the open routes. Status codes:
   401 for any invalid credential; the licence path keeps Sourcery's existing
   codes, which the extension depends on (`401 license_required` when a
   bearer key has no instance id, `401 license_invalid`, `402
   license_inactive` for an expired/revoked/disabled licence, `503
   license_service_unavailable` when Polar is down and there is no grace
   verdict).
3. Check the policy allows this route. If not -> 403 `{error:"forbidden"}`,
   or `401 {error:"credential_required"}` when no credential was sent.
4. Enforce quota. **Per-minute and per-IP limits use the Workers
   rate-limiting binding on every plan** (one binding per distinct limit,
   since a binding's limit and period are fixed in `wrangler.toml`). **KV
   holds only the daily licence and app-key quotas**, buffered in memory and
   flushed in batches as `sourcery/gateway` does today. If the plan turns out
   to be the free one and the daily counters prove too write-heavy, revisit
   then. Over quota -> 429 with `Retry-After`.
5. (Removed by decision 26: the gateway never answers from a cache.)
6. Forward: strip **every** client header except `content-type` and `accept`
   (as today), then add `CF-Access-Client-Id`, `CF-Access-Client-Secret`,
   `x-app-token` for that service, and, on **every** pricing request (not
   only quotes, since pricing treats an absent header as `default`),
   `x-fill-policy` from the policy. Body size cap of 1 MB (as today). The
   Access headers are added at G4.
7. Copy back only status, `content-type`, body, `ETag` and the origin's own
   `Cache-Control`, unchanged.
   Add CORS headers for an allowed `Origin`.

### 6.2 Licence keys (Sourcery)

Unchanged from `sourcery/gateway`: Polar `validate` / `activate` /
`deactivate`, verdicts cached in the `LICENSES` KV namespace for
`LICENSE_CACHE_SECONDS` with `LICENSE_GRACE_SECONDS` of grace when Polar is
down, `POLAR_TIERS` mapping benefit ids to tiers. Polar's licence endpoints
are public, so no Polar secret is needed. This gateway points
`POLAR_API_BASE` at Polar **production** (decision 27); a test fails if it is
ever set back to the sandbox.

### 6.3 Public browser clients (poke-guide and our own web apps)

A public website cannot hold a secret: anything in its JavaScript is readable.
So the gateway does not try to authenticate the *visitor*. It makes public
access **harmless and bounded**, and makes it costly to abuse:

1. **Origin allow-list.** CORS headers only for the client's own origins.
   This stops other websites' pages from calling the API from their visitors'
   browsers. It does not stop scripts, which is why the next steps exist.
2. **Turnstile.** The site embeds an invisible Cloudflare Turnstile widget
   and posts its token to `POST /v1/session`. The gateway verifies it with
   Turnstile's `siteverify` API (using `TURNSTILE_SECRET_KEY`), checks the
   `Origin` and the hostname Turnstile reports, and returns a **session
   token**: an HMAC-SHA256 (with `SESSION_SIGNING_KEY`) over
   `{client, origin, expiresAt}`, valid for about 30 minutes. The site sends
   it as `Authorization: Session <token>` and refreshes it before expiry.
   **The token is deliberately not bound to an IP** (decided 2026-11-09):
   phones and dual-stack networks change IP mid-visit, and a short-lived,
   read-only session that can never spend JustTCG gains almost nothing from
   it. Protection comes from the Origin check, Turnstile at issue time,
   per-IP rate limits, and the short lifetime.
3. **Per-IP rate limits** on every public call, via the Workers
   rate-limiting binding keyed by IP (never KV), plus one Cloudflare WAF
   rate-limiting rule as a coarse backstop (the free plan includes one rule).
4. **Harmless by construction.** Public policies are reads only: GETs plus
   `POST pricing/v1/prices/quote`, with `fillPolicy: none` forced whatever
   the client sends, and a quote batch capped at **100 items** for public
   clients (`413 {error:"batch_too_large", max:100}` above that) so one call can't do the work of a
   scrape. Public traffic can never spend JustTCG budget or write anything.
5. **No gateway caching** (decision 26). Public responses, quotes included,
   are forwarded on every call and returned exactly as the service sent
   them; the gateway never caches, splits or merges a quote batch.

Exposure check: everything a public client can read is already published
openly today (R2's `pricing/prices.json` and `catalog/pokemon.json`, and
tcgcsv itself). Moving to the gateway adds limits, not exposure.

### 6.4 App keys (server-side apps)

`Authorization: Bearer <key>`, where the key is 32 random bytes in hex. The
policy table stores `sha256(key)`; the plaintext exists only in Bitwarden and
in the consuming app's own secret store. Revoking an app means removing its
row and redeploying. Each app gets its own key, so a leak is revoked without
touching any other client.

## 7. Secrets: Bitwarden is the source of truth

Layout (owner, 2026-11-09): a new Bitwarden organization
(`fb861205-eddd-488f-a18c-b4fd0066477a`) with one project and one read-only
machine account per consumer, so no token reads more than its service needs.
The gateway's own secrets go in project **`api-gateway`**
(`a24de797-21ea-4454-b0a9-b4fd0070fc4a`), read by machine account
`api-gateway`. The service tokens it forwards stay in project `hosted-api`
(shared with the Droplet stacks). Secret values are never printed or committed.

**How they reach the Worker.** Workers cannot run the Bitwarden SDK at
request time, and should not. `tools/push_secrets.py` reads each secret from
Bitwarden and writes it to the Worker's secrets through the Cloudflare API
(`PUT /accounts/{account}/workers/scripts/{script}/secrets`), printing names
only, never values. Run it after creating or rotating a secret. The G3/G4
Cloudflare steps are `tools/cutover.py`; both share `tools/cloudflare_api.py`,
print a plan unless given `--apply`, and are tested offline by
`tools/test_tools.py`. Pushes
run on the owner's PC as the narrow `gateway-deploy` machine account (owner,
2026-11-10): **Can read** on `api-gateway` and `hosted-api` only. Windows
Credential Manager entry `gateway-deploy/bitwarden-machine-token`, read with
`tcg_catalog_service/tools/machine_token.py`. It never holds standing write: the
owner grants **write on `api-gateway`** for the G3 cut-over (it stores the Access
service token halves) or a key rotation, then removes it. `owner-ops` (read/write
on every project) is not used by the gateway tools, and its token is not kept on
the PC. Never use a token mounted into a service.

| Worker secret | Purpose | Bitwarden secret (project) | Exists? |
|---|---|---|---|
| `PRICING_APP_TOKEN` | `x-app-token` to pricing | `PRICING_APP_TOKEN`, id `6f7c5b06-131c-4e77-9e93-bebcadfc5e9d` (`hosted-api`) | **Yes** (already pushed to `sourcery-gateway`) |
| `CATALOG_APP_TOKEN` | `x-app-token` to catalog | `CATALOG_APP_TOKEN`, id `cc0ded80-9afc-471a-903c-9a139e17e777` (`hosted-api`) | **Yes** (already pushed to `sourcery-gateway`) |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | Cloudflare Access service token (section 4) | to create in `api-gateway`: `TCG_GATEWAY_ACCESS_CLIENT_ID`, `TCG_GATEWAY_ACCESS_CLIENT_SECRET` | **No.** Create the service token in Zero Trust, then store both halves. |
| `TURNSTILE_SECRET_KEY` | verify Turnstile (section 6.3) | `TCG_GATEWAY_TURNSTILE_SECRET` (`api-gateway`) | **Yes** (2026-11-10), pushed to `tcg-api-gateway`. Widget "poke-guide gateway session", invisible, domains `poke-guide.com` + `dyzfunkshin.github.io`; public site key `0x4AAAAAAF7EdXeIJUV7y-30` (poke_guide's page). |
| `SESSION_SIGNING_KEY` | HMAC for public session tokens | `TCG_GATEWAY_SESSION_SIGNING_KEY` (`api-gateway`) | **Yes** (2026-11-10), 32 random bytes generated by `tools/push_secrets.py --generate-session-key`, never displayed; pushed. Rotate per 7.1. |
| App keys (one per server-side app) | `app-key` clients (section 6.4) | to create in `api-gateway`: `TCG_GATEWAY_APP_KEY_<APP>` | **No.** Create one per app when that app onboards. Only the hash goes in `src/clients.js`. |

Deployment credentials (used by `wrangler deploy` / `push_secrets.py`, not by
the Worker):

| Credential | Bitwarden | Exists? |
|---|---|---|
| Cloudflare API token | `TCG_GATEWAY_CLOUDFLARE_API_TOKEN` (`api-gateway`); dashboard name `tcg-api-gateway` | **Yes.** Dedicated token, client-IP filtered to the owner's PC (2026-11-09). `tools/check_cloudflare_token.py` passed all 10 read-only checks on 2026-11-09 (Workers Scripts, KV `LICENSES`, Access apps + service tokens, Turnstile, zone `dyzzyscards.com`, Workers Routes, DNS). If the owner's IP changes, update the token's IP filter. The old `sourcery_cloudflare_api_token` stays tunnel-only and is not used by the gateway tools. |
| Bitwarden machine token (PC) | n/a (`gateway-deploy`, Credential Manager, above) | **Yes** (2026-11-10). Read on `api-gateway` + `hosted-api`; write on `api-gateway` only while granted for G3 or a rotation. |

Unchanged and not the gateway's concern: `JUSTTCG_API_KEY`
(`139c13f6-…`, project `pricing-runtime`), used only by pricing;
`sourcery_tunnel` (`b7dac9bb-…`, project `hosted-api`), the Droplet's tunnel token.

Non-secret configuration (`wrangler.toml` `[vars]`): `PRICING_ORIGIN`,
`CATALOG_ORIGIN`, `POLAR_*`, `ALLOWED_ORIGIN_PREFIXES` per client (or folded
into `src/clients.js`), quota defaults, Turnstile **site** keys.
Cloudflare account `722b682d1c0bb958ea4d14b5bc6275d1`; KV namespace
`LICENSES` (`3216419ee1244988a05fc0bad9d7b17c`) carries over so cached
Sourcery verdicts survive the cut-over.

### 7.1 Rotating `SESSION_SIGNING_KEY`

Session tokens carry no key id (section 6.3), so rotating the key invalidates
every live session at once. That is acceptable: tokens last 30 minutes
(`SESSION_TTL_SECONDS`) and clients re-issue on a 401.

- **When:** a suspected leak, or a machine or person with access to the key
  changes.
- **How:** generate a new random value of at least 32 bytes inside the tooling
  so it is never displayed. Store it in Bitwarden project `api-gateway` as
  `TCG_GATEWAY_SESSION_SIGNING_KEY`, replacing the old value. Then push it as
  the Worker secret `SESSION_SIGNING_KEY` with `tools/push_secrets.py
  --apply --generate-session-key --only SESSION_SIGNING_KEY`, as `gateway-deploy`
  with write on `api-gateway` granted for the rotation, then removed.
- **Expected effect:** each active visitor gets one 401 and silently re-issues
  a session.

### 7.2 Security log events

Every security-relevant deny decision emits exactly one structured event
through `deps.log(event, fields)` (`console.log` of JSON in production, kept by
Workers Logs: `[observability]` in `wrangler.toml`). Event names are stable;
log queries depend on them, so never rename one. No event ever carries a
session token, Turnstile token, raw licence or app key, Authorization header,
or secret: licence keys appear only as the 8-character hash prefix (`key`, or
`subject` with `subjectKind: license`), app keys only as the app id. `ip` is
`cf-connecting-ip`.

| Event | Fires when | Fields |
|---|---|---|
| `credential_invalid` | 401 for an unusable credential: unsupported scheme, malformed bearer value, Bearer licence without a valid `X-Instance-Id` (`license_required`), or an anonymous call to a protected route (`credential_required`) | `reason`, `ip`; `key` (hash prefix) for the instance case; `client`, `route` for `credential_required` |
| `license_rejected` / `license_not_found` / `license_service_unavailable` / `license_attempts_limited` | licence verdict refused, unknown, Polar unreachable, or per-IP attempt cap hit | `key` (hash prefix), `reason`/`detail`/`status`, `ip` |
| `license_polar_limited` | the global Polar budget (`RATE_LIMIT_POLAR`) is spent, so a validate, activate or deactivate call to Polar is skipped (a validate then falls back to grace or 503) | `op`, `key` (hash prefix) |
| `license_revoked_cached` | Polar answered 404 for a key that had a cached valid verdict; the shared copies are overwritten with the refusal | `key` (hash prefix) |
| `session_refused` | `POST /v1/session` refused: `origin_not_allowed`, `bad body`, `turnstile`, `hostname`, `action mismatch` | `reason`, `client` (except origin_not_allowed), `ip`, plus `origin` / `errorCodes` / `hostname` / `action` as relevant |
| `session_invalid` | session token bad signature, unknown client, origin mismatch, or signing key unset | `reason`, `ip` |
| `session_expired` | a correctly signed session token past its expiry | `client`, `ip` |
| `route_forbidden` | 403, the client's policy does not allow the route | `route`, `client` |
| `rate_limited` | per-minute refusal, from a rate-limit binding or the in-memory counter | `client`, `route`, `limiter` (binding name or `memory`), `subjectKind` (`ip`, `session`, `app`, `license`), `subject` (ip or IPv6 /64, session-token hash prefix, app id, or licence hash prefix), `ip` |
| `quota_exceeded` | daily quota refusal | `client`, `route`, `subjectKind`, `subject`, `ip` |
| `request_rejected` | 413: `reason` is `payload_too_large` (declared or, for a chunked body, counted while streaming) or `batch_too_large` | `reason`, `route`, `client`, `ip`; `count`, `max` for batches |
| `rate_limiter_unavailable`, `access_misconfigured`, `session_not_configured` | operational failures (fail open / 503) | `binding` or `reason`/`missing`, `error` |

Alerting on these events is a separate, deploy-gated task (#9); this section
only fixes the names and fields it will key on.

### 7.3 Alerts (2026-11-10)

All alerts email the owner (the account's existing notification email).

| Alert | How | State |
|---|---|---|
| Worker errors and 5xx (incl. `502 origin_unavailable`: pricing/catalog down or the Access lock misconfigured) | Workers Observability **Issues** (`[observability.issues]` in `wrangler.toml`) + notification policy "tcg-api-gateway: Worker issues" (`workers_observability_real_time_issue`) | **Live** (deployed script has `observability.issues.enabled`) |
| `license_service_unavailable` > 20 / 15 min | **Not built.** Workers Observability Monitors are not offered on Workers Free (no Monitors in the dashboard). Backlog: a scheduled GitHub Actions check querying the telemetry API (needs a token with Workers Observability: Read), or Workers Paid. Policy "tcg-api-gateway: Workers Observability alerts" (`workers_observability_alert`) exists for Monitors if the account upgrades | backlog (task #13) |
| `credential_invalid` + `license_invalid` > 200 / 15 min (key guessing) | same | backlog (task #13) |
| `rate_limited` > 500 / 15 min (abuse or a looping client) | same | backlog (task #13) |
| Access service token expiring or leaked | existing account policies "Expiring/Leaked Service Token Alert" | already on |
| Spend | existing "Default budget alert" ($10) | already on |

Not available: a Workers KV writes usage alert (`billing_usage_alert` is for pay-as-you-go
accounts and documents no KV product). If the account moves to Workers Paid, revisit.

## 8. Migration plan (in order; each step is shippable on its own)

| # | Step | Repo(s) | Done when |
|---|---|---|---|
| G0 | Bootstrap: copy `sourcery/gateway` (src, tests, wrangler) here with a provenance note; deploy as `tcg-api-gateway` on `*.workers.dev` only; same behaviour as today. | gateway | Test suite green; the `workers.dev` URL answers `/v1/health`. |
| G1 | Namespaced routing `/pricing/v1/*`, `/catalog/v1/*`; client/policy table; legacy aliases mapped. | gateway | Tests cover allow, deny, alias, header stripping, and forced fill policy. |
| G2 | `GET /pricing/v1/health` open through the gateway; pricing's freshness alert repointed to it. | gateway, pricing | Alert workflow green against the gateway URL. |
| G3 | Cut `api.dyzzyscards.com` over from `sourcery-gateway` to `tcg-api-gateway`, and serve `api.mintuition.app` from the same Worker (moved from `sourcery-gateway` if attached there, else attached fresh in its own zone; decision 28); push secrets. The custom-domain detach (old Worker) and reattach (new Worker) run as **one scripted step**; a gap of seconds to a minute is acceptable (Sourcery is the only live client and retries). The script ends by preparing G4: it creates the Access app and service token and pushes `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` as Worker secrets. **Build gate:** `POLAR_API_BASE` points at Polar production, not sandbox, before cut-over (sandbox licences can be obtained with test card numbers). **Stop at that step for the owner's go-ahead.** Scripted as `tools/cutover.py`. | gateway | Sourcery's deployed e2e passes 8/8 through the new Worker (`F:/claude_temp/poke-scans/sourcery-e2e-deployed.py`). |
| G4 | **Immediately after G3**, with no other step or work between them. Lock origins with Access (section 4). Until this lands, `pricing-origin.dyzzyscards.com` and `catalog-origin.dyzzyscards.com` are directly reachable and bypass every gateway check. The lock waits for the owner's go-ahead; the Access prep above has already run. | gateway (+ Cloudflare) | Direct origin curl is denied; e2e still 8/8; freshness alert still green. |
| G5 | Public sessions: Turnstile, per-IP limits, forced fill policy, batch cap. | gateway | Tests; a load test shows public traffic held to its per-IP and per-session limits. |
| G6 | poke-guide switches from R2 snapshots to the gateway (huddle with `_apps/poke_guide`). | poke_guide, gateway | poke-guide.com search and prices work with R2 unused. |
| G7 | Sourcery extension moves to the new paths; aliases removed once their hit counts reach zero; `sourcery/gateway` retired. | sourcery, gateway | No alias hits for 30 days. |
| G8 | Retire the R2 publisher (`pricing-publisher` and `tools/poke-guide/` in pricing) once nothing reads R2. **Decide first** whether R2 stays as the off-Droplet backup of `prices.db`/`history.db`, or is replaced by DigitalOcean volume snapshots. | pricing | No R2 reads in Cloudflare analytics for 14 days. |

Do G0–G4 before onboarding any new client: they move today's live traffic
safely, and the lock (G4) is the security win on its own.

**G4 done (2026-11-10).** Cloudflare Access apps lock `pricing-origin.dyzzyscards.com` and `catalog-origin.dyzzyscards.com` to the `tcg-api-gateway` service token. Verified: direct `/v1/health` on both origins returns 403; through both API hosts `/v1/health` 200 and `/pricing/v1/health` 200 (Access headers accepted); pricing's freshness alert, now polling the gateway (pricing `main` 470eacd), green. Not yet exercised: a credentialed catalog call through the lock (no open catalog route; the same service token and policy guard both apps).

**G3 done (2026-11-10).** `api.dyzzyscards.com` and `api.mintuition.app` are Custom Domains on `tcg-api-gateway`; `sourcery-gateway` serves nothing. Access service token `tcg-api-gateway` created, both halves in Bitwarden (`TCG_GATEWAY_ACCESS_CLIENT_ID` / `_SECRET`) and pushed. Incident: the first run read Cloudflare's empty 204 on the domain DELETE as a failure and left `api.dyzzyscards.com` on no Worker for about 20 minutes (no shipped clients affected); fixed in `tools/cloudflare_api.py` with a regression test, and the re-run attached both hosts. Smoke test on both hosts: health 200, pricing health 200, uncredentialed calls 401, fake licence 401, fake Turnstile 403. **G4 (the lock) is held** until pricing's freshness alert polls the gateway (section 4 knock-on change). The deployed-e2e script uses Polar sandbox keys, which production Polar refuses; licence e2e needs a production key.

**G0 deployed (2026-11-10).** `tcg-api-gateway` runs on `https://tcg-api-gateway.matthew-722.workers.dev` (wrangler 4, all six rate-limit bindings), from `dev` at that date. Worker secrets pushed: `PRICING_APP_TOKEN`, `CATALOG_APP_TOKEN`, `TURNSTILE_SECRET_KEY`, `SESSION_SIGNING_KEY` (Access pair waits for G3/G4). Smoke test: `/v1/health` both origins true; `/pricing/v1/health` 200 through the gateway; quote without credential 401; `/v1/session` fake token 403 `turnstile_failed`, foreign Origin 403 `origin_not_allowed`. `api.dyzzyscards.com` still on `sourcery-gateway`.

**Build gates (2026-11-09).** G0 and G1 are built and tested **offline
only**: no `wrangler deploy`, no secret push, no Cloudflare API call of any
kind until the owner confirms the Cloudflare API token has the Workers
permissions (section 7). G0's "workers.dev URL answers" check waits for that.

**Git.** One branch per step (`feature/g0-bootstrap`, `feature/g1-…`, …),
each branched from the previous, committed at the end of the step. Never
merged to `main` by Claude; there is no remote yet.

## 9. Testing

- Hand-rolled offline tests, mocked `fetch`, no network, like the sibling
  repos and `sourcery/gateway/test/run.js`. Every policy rule gets an
  allow-case and a deny-case.
- Each service's `INTEGRATION.md` is the contract. When a service adds or
  changes a route, the allow-list and its tests change in the same PR.
- Post-deploy: Sourcery's deployed e2e, plus a public-client smoke test
  (session, one quote, one artifact) once G5 lands.

## 10. Open questions

1. Binder mobile auth (section 5).
2. Whether R2 is kept as a backup target (G8).
3. Dedicated Cloudflare API token for the gateway versus extending the
   Sourcery one (section 7).
4. Final name: repo `tcg_api_gateway` and Worker `tcg-api-gateway` are working
   names.
5. Workers plan tier (free vs paid) is unconfirmed. The design does not
   depend on it (section 6.1 step 4).

## 11. Decisions log

**2026-11-09** (owner answers before building; already folded into the
sections above):

1. Scope: build G0 and G1 offline with tests passing, then stop. No deploy,
   secret push or Cloudflare API call until the token's Workers permissions
   are confirmed (section 8).
2. Licences and app keys share `Authorization: Bearer`; app-key hash lookup
   first, then licence if `X-Instance-Id` is present, else 401 (section 6.1).
3. A present-but-invalid credential is always a 401, never the `none`
   client (section 6.1). Sourcery's licence error codes are kept.
4. Public clients may call quote, forced to `fillPolicy: none`, max 100
   items per call (sections 5, 6.3).
5. Per-minute and per-IP limits use the rate-limiting binding on any plan;
   KV only for daily licence/app-key quotas (section 6.1).
6. G3 cut-over: brief gap acceptable; detach and reattach scripted as one
   step, stopping for the owner's go-ahead (section 8).
7. Public session tokens are not IP-bound (section 6.3).
8. Housekeeping: this repo gets `CLAUDE.md` and `INTEGRATION.md`, and is
   listed in `_services/CLAUDE.md`. Git: a branch per step, committed at the
   end of each step, never merged to `main`; step branches merge into `dev`.
14. G4 follows G3 immediately, with no other step or work between them. The
    G3 cut-over script ends by preparing G4: it creates the Access app and
    service token and pushes `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` as
    Worker secrets, so the lock is one owner go-ahead away. The owner's
    go-ahead is still required before the lock itself (section 8). G3 gains a
    build gate: `POLAR_API_BASE` must point at Polar production, not sandbox,
    before cut-over, because sandbox licences can be obtained with test card
    numbers (owner tracks this in their own task).
15. Rotating `SESSION_SIGNING_KEY` invalidates all live sessions; accepted,
    because tokens last 30 minutes and clients re-issue on 401. Documented as
    a runbook (section 7.1), not built as key ids.

**2026-11-09, implementation choices made while building** (owner may revise):

9. `x-fill-policy` goes on every pricing request, not only quotes (pricing
   treats an absent header as `default`).
10. CORS/session origins: a bare scheme entry (`chrome-extension://`) matches
    by prefix; a full origin matches **exactly**, so `https://poke-guide.com`
    never admits `https://poke-guide.com.evil.example`.
11. poke-guide's preview origin is `https://dyzfunkshin.github.io` (its
    preview build is GitHub Pages of `poke-guide-preview`). That origin is
    shared by every GitHub Pages site of that account; acceptable for a
    read-only, budget-free session.
12. Public sessions: per-IP limit via its own binding `RATE_LIMIT_SESSION`
    (300/min; a page loads many artifacts and images), anonymous callers via
    `RATE_LIMIT_PUBLIC` (60/min). A session token is bound to its origin and
    expires in `SESSION_TTL_SECONDS` (1800). Sending any `Authorization` to
    `POST /v1/session` is checked like everywhere else (decision 3), so sites
    must not send the old token there.
13. *(Superseded by decision 26.)* Edge cache TTLs: artifacts 1 year, images 1 day, manifest 60 s, all else
    1 hour. Only `fillPolicy: none` clients may use the shared edge cache
    (enforced by `assertValidClients`). Quote items are cached only when they
    carry nothing but `game`, exactly one of `productId`/`skuId`, `condition`,
    `printing`; absent selectors are not defaulted in the key.

**2026-11-09, security logging (task #5):**

16. Every deny decision logs exactly one stable-named event, and no event may
    contain a secret or raw credential (section 7.2). Existing event names are
    unchanged; new ones are `credential_invalid`, `rate_limited`,
    `quota_exceeded`, `session_expired` and `request_rejected`, plus `reason`
    fields on the previously silent `/v1/session` refusals. Workers Logs is
    enabled in `wrangler.toml`. Alerting is deferred to task #9.

**2026-11-09, security hardening (owner decisions, tasks #3 and #6):**

17. **Licence flood guard.** A licence lookup that may reach the edge cache,
    KV or Polar first spends one attempt from `RATE_LIMIT_LICENSE_ATTEMPTS`,
    keyed by IP, at **20 per IP per minute** (owner's choice). A verdict still
    fresh in isolate memory is free, so a real Sourcery user spends about one
    attempt per 10 minutes. Over the limit, the answer is
    `429 license_attempts_exceeded` with `Retry-After: 60`. The same guard
    covers `/v1/license/activate` and `/v1/license/deactivate`. Polar
    "not found" verdicts live in isolate memory only, so a random key never
    costs a KV write. The verdict memory is capped at 1000 entries. As with
    every other binding, the guard fails open if the limiter errors.
18. **Turnstile action.** Every public-session client names a
    `turnstileAction`; poke-guide's is `gateway-session`. `/v1/session`
    refuses a token whose siteverify `action` differs, with
    `403 turnstile_failed`, the same code as any other Turnstile failure.
    The action is a public label, not a secret. Tokens from other widgets
    are already rejected by siteverify, because each widget has its own
    secret key. This check only separates uses of **our own** widget: if the
    same widget is later reused on the site for something else (a contact
    form, say), that token cannot buy a session. poke-guide uses the widget
    only for sessions today, so this is cheap insurance for later, not a
    current defence. poke_guide was notified through the huddle's notices.

**2026-11-09, security review fixes (branch `fix/security-review-findings`):**

19. *(Superseded by decision 26.)* **Quote cache keys are exact.** Per-item quote cache entries are keyed
    on the exact `game` / `condition` / `printing` pricing receives (pricing
    matches `game` verbatim). An item whose selector is present but not
    canonical (`game` `^[a-z0-9-]{1,64}$`; condition/printing words of
    `[A-Za-z0-9-]` with single spaces, at most 64 chars) is forwarded but
    never cached, and an answer without a `market` price is never stored.
20. **Body cap on chunked bodies.** The 1 MB cap is enforced while the body
    streams in; past it the stream is cancelled and the answer is
    `413 payload_too_large`.
21. **Per-IP keys use the IPv6 /64.** Every per-IP limiter key goes through
    one helper (IPv4 unchanged, IPv6 keyed on its /64, mapped IPv4 as
    IPv4). Public sessions are also limited per token on
    `RATE_LIMIT_SESSION`, keyed `session:<sha256 prefix>`, never the token.
22. **Global Polar budget.** `RATE_LIMIT_POLAR` (one key, 120 a minute) sits
    in front of every Polar call. When it trips, a cached key still works
    (inside its grace window) and an uncached key gets
    `503 license_service_unavailable` with `Retry-After`.
23. **Revocations stick.** A Polar 404 for a key with a cached valid verdict
    overwrites the edge-cache and KV copies with the refusal for the grace
    window, so no grace path revives it. Isolates that still hold the valid
    verdict in memory keep it until it falls out of memory or the cache
    window ends and Polar answers again.
24. **Activate spends no KV writes.** Activate seeds its verdict in memory
    and the colo's edge cache only (each activate is a new activation id, so
    activate/deactivate cycling used to cost a KV write a round), and a
    deactivate deletes the KV copy only when one exists.
25. **Tag-write keys.** The `catalog:tags.write` segment allows the `<file>`
    characters plus percent-escapes that cannot decode to `/`, `\`, `.` or a
    control character, with no leading dot.

**2026-11-09, pass-through (owner decision):**

26. **The gateway is a gatekeeper, not a cache.** Owner: "You control access
    and throughput, everything else passes through to the proper service
    unadulterated." The gateway decides who gets in, which routes and how
    often (auth, policy, quotas, rate limits, body and batch caps, CORS,
    forced `x-fill-policy`), then forwards. It never caches, splits, merges
    or rewrites a service response body, and sets no `Cache-Control` or
    `X-Gateway-Cache` of its own. Two deliberate exceptions, both to avoid
    leaking origin internals: an origin 5xx becomes `502 origin_unavailable`,
    and only `content-type`, `etag` and `cache-control` headers are passed back.
    Otherwise: the edge cache, the per-item quote cache and
    the policy `cache` field are removed. Supersedes decisions 13 and 19. If
    origin load ever matters, the services set their own `Cache-Control` and
    Cloudflare caches on that; the gateway stays blind to it. Licence
    verdict caching is the gateway's own auth state and is unchanged.
27. **Polar production, three paid tiers** (owner, 2026-11-10). `POLAR_API_BASE`
    is `https://api.polar.sh`; organization `876bc883-f2c8-48a7-be15-ac1470d159ae`.
    Tiers by License Keys benefit id: collector `06d0e2f9-…`, trader
    `bae5bb05-…`, pro `c563b5ed-…` (full ids in `wrangler.toml`). All three are
    paid, so all three get `x-fill-policy: default` (may spend JustTCG budget);
    a benefit outside `POLAR_TIERS` is refused. Satisfies the G3 build gate.
    Sandbox licences cached in `LICENSES` KV carry the sandbox organization id
    and are refused by the organization check. Sourcery's checkout links must
    point at these production products (Sourcery repo, not this one).
28. **Two hostnames from G3** (owner, 2026-11-10). `tcg-api-gateway` serves both
    `api.dyzzyscards.com` and `api.mintuition.app` from the G3 cut-over, with
    identical behaviour (dyzzyscards for all clients, mintuition for the Mintuition
    extension). `tools/cutover.py` handles each host in turn (move, skip, or attach
    when unattached for mintuition only); any other Worker or a zone route stops it
    before a mutation, and a failed step rolls back both hosts. All Polar tiers keep
    fill policy `default` (decision 27).
29. **Deploy from GitHub on a version tag** (owner, 2026-11-11). Pushing a `v*` tag whose
    commit is on `main` runs `.github/workflows/deploy.yml`: offline tests, a check that
    `wrangler.toml` still lists both custom domains, `wrangler@4 deploy`, then a health
    check on both hostnames. A deploy-only Cloudflare token, `TCG_GATEWAY_CI_CLOUDFLARE_API_TOKEN`
    (Workers Scripts, Workers KV Storage, Account Settings read, Workers Routes on the two
    zones; no IP filter, because runner addresses vary; the operator token stays
    IP-restricted and is not used by CI), is read from Bitwarden at run time by
    the machine account `gateway-ci` (**Can read** on `api-gateway` only); GitHub holds
    only that account's access token, as the repository secret `BW_ACCESS_TOKEN`.
    `main` exists from this date and is GitHub's default branch. Deploying from the
    owner's PC as `gateway-deploy` remains the fallback.
