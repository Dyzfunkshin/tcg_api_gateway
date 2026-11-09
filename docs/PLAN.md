# TCG API gateway — the single front door

**Status:** plan, agreed in principle 2026-11-08; nothing built yet.
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
- **Edge caching.** Cacheable reads are answered from Cloudflare's cache, so
  most public traffic never reaches the single small Droplet.
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
- `cache`: whether, and for how long, responses may be served from the edge cache

### Who needs access

| Client | Today | Kind | Auth | Allowed | Fill policy | Notes |
|---|---|---|---|---|---|---|
| **Sourcery extension** | Live, via `sourcery/gateway` | Browser extension, paid | `license`: Polar licence key + `X-Instance-Id`, verdict cached in KV (unchanged) | quote, products lookup/get, both games lists, licence routes | by tier: `basic:none`, `pro:default` (unchanged) | Origins `chrome-extension://`, `moz-extension://`. Quotas per key as today (`DAILY_QUOTA=20000`, `BURST_PER_MINUTE=300`). |
| **poke-guide website** (poke-guide.com) | Reads static snapshots from R2 (`data.poke-guide.com`) | Public static site | `public-session` (section 6.3) | GET only: `pricing/v1/prices/product/:id`, quote (read-only), `pricing/v1/history*`, `pricing/v1/games`; `catalog/v1/manifest.json`, `catalog/v1/artifacts/*`, `catalog/v1/images/*`, `catalog/v1/products/*`, `catalog/v1/games` | **`none`, forced** | Origins `https://poke-guide.com` (+ preview origin). Per-IP limits. Edge-cached. Migration is the poke_guide huddle. |
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
2. Identify the client from its credential (licence, app key, or session
   token). No credential, or an invalid one, means the `none` client, which
   may only reach the open routes.
3. Check the policy allows this route. If not -> 403 `{error:"forbidden"}`
   (or 401 when no credential was sent).
4. Enforce quota (KV counters, as `sourcery/gateway` does today, keyed per
   policy). Over quota -> 429 with `Retry-After`.
5. Serve from the edge cache if the policy allows it and there is a fresh hit.
6. Forward: strip **every** client header except `content-type` and `accept`
   (as today), then add `CF-Access-Client-Id`, `CF-Access-Client-Secret`,
   `x-app-token` for that service, and, for pricing quotes, `x-fill-policy`
   from the policy. Body size cap of 1 MB (as today).
7. Copy back only status, `content-type`, body, `ETag` and caching headers.
   Add CORS headers for an allowed `Origin`.

### 6.2 Licence keys (Sourcery)

Unchanged from `sourcery/gateway`: Polar `validate` / `activate` /
`deactivate`, verdicts cached in the `LICENSES` KV namespace for
`LICENSE_CACHE_SECONDS` with `LICENSE_GRACE_SECONDS` of grace when Polar is
down, `POLAR_TIERS` mapping benefit ids to tiers. Polar's licence endpoints
are public, so no Polar secret is needed. Note that `wrangler.toml` there
still points `POLAR_API_BASE` at the **sandbox**; switching to production is
a Sourcery launch decision, not this migration's.

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
   `{client, origin, ipPrefix, expiresAt}`, valid for about 30 minutes. The
   site sends it as `Authorization: Session <token>` and refreshes it before
   expiry. Scripted abuse then needs a solved Turnstile challenge every 30
   minutes per IP.
3. **Per-IP rate limits** on every public call: Workers rate-limiting binding
   or KV counters keyed by IP, plus one Cloudflare WAF rate-limiting rule as
   a coarse backstop (the free plan includes one rule).
4. **Harmless by construction.** Public policies are GET (and read-only
   quote) only, with `fillPolicy: none` forced, so public traffic can never
   spend JustTCG budget or write anything.
5. **Edge caching.** `catalog/v1/artifacts/*` are content-hashed and
   immutable, so cache them for a year. Cache `prices/product/:id`, games and
   history GETs for about 1 hour. Quote is a POST batch, so the Worker splits
   it and caches each item under a synthetic GET key
   `(game, productId|skuId, condition, printing)` for about 1 hour, forwarding
   only the misses.

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

Constraints (from the owner): the Bitwarden org is at its limit of **3
projects** (`poke-scans`, `poke-scans-test`, `tcg-tools`) and **3 machine
accounts**. No new ones can be created, so the gateway's secrets go into the
existing **`poke-scans`** project next to the service tokens it forwards.
Secret values are never printed or committed.

**How they reach the Worker.** Workers cannot run the Bitwarden SDK at
request time, and should not. `tools/push_secrets.py` reads each secret from
Bitwarden and writes it to the Worker's secrets through the Cloudflare API
(`PUT /accounts/{account}/workers/scripts/{script}/secrets`), printing names
only, never values. Run it after creating or rotating a secret. It follows the
pattern already used for `sourcery-gateway`:
`F:/claude_temp/tcg_pricing_service/bw_secret_ops.py push-worker`, run inside
the pricing image's `/opt/publisher/bin/python`, which has `bitwarden_sdk`.
That script is a throwaway; promote a cleaned-up version into this repo. Use
the PC's `tcg-tools` machine token
(`%LOCALAPPDATA%\tcg-pricing-secrets\bitwarden_access_token`), which reads the
`poke-scans` project.

| Worker secret | Purpose | Bitwarden secret (project `poke-scans`) | Exists? |
|---|---|---|---|
| `PRICING_APP_TOKEN` | `x-app-token` to pricing | `PRICING_APP_TOKEN`, id `98bcb930-145c-441f-b635-b4fc014312f9` | **Yes** (rotated 2026-11-08; already pushed to `sourcery-gateway`) |
| `CATALOG_APP_TOKEN` | `x-app-token` to catalog | `CATALOG_APP_TOKEN`, id `0aa37fc0-6ced-452d-9621-b4fc01675281` | **Yes** (rotated 2026-11-08; already pushed to `sourcery-gateway`) |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | Cloudflare Access service token (section 4) | to create: `TCG_GATEWAY_ACCESS_CLIENT_ID`, `TCG_GATEWAY_ACCESS_CLIENT_SECRET` | **No.** Create the service token in Zero Trust, then store both halves. |
| `TURNSTILE_SECRET_KEY` | verify Turnstile (section 6.3) | to create: `TCG_GATEWAY_TURNSTILE_SECRET` | **No.** Create a Turnstile widget for poke-guide.com (+ preview host). Its **site key is public** and goes in poke_guide's code, not Bitwarden. |
| `SESSION_SIGNING_KEY` | HMAC for public session tokens | to create: `TCG_GATEWAY_SESSION_SIGNING_KEY` | **No.** 32 random bytes; generate it inside the push tool so it is never displayed. |
| App keys (one per server-side app) | `app-key` clients (section 6.4) | to create: `TCG_GATEWAY_APP_KEY_<APP>` | **No.** Create one per app when that app onboards. Only the hash goes in `src/clients.js`. |

Deployment credentials (used by `wrangler deploy` / `push_secrets.py`, not by
the Worker):

| Credential | Bitwarden | Exists? |
|---|---|---|
| Cloudflare API token | `sourcery_cloudflare_api_token`, id `31101705-9fb0-4d5e-a0a0-b4fa0064a273` | **Yes, but permissions are incomplete.** It has *Cloudflare Tunnel: Edit* (added 2026-11-08). It also needs *Workers Scripts: Edit*, *Workers KV Storage: Edit*, *Workers Routes: Edit* (zone `dyzzyscards.com`), *Access: Apps and Policies: Edit*, *Access: Service Tokens: Edit*, and *Turnstile: Edit*. Check what it already has before adding, under dash → Manage Account → Account API Tokens. Alternatively create a dedicated `tcg_gateway_cloudflare_api_token` and keep the Sourcery one tunnel-only. |
| Bitwarden machine token (PC) | n/a (local file above) | **Yes.** Writing *new* secrets needs that machine account set to **Can read, write** on `poke-scans` temporarily; set it back to read afterwards. |

Unchanged and not the gateway's concern: `JUSTTCG_API_KEY`
(`a5ab198c-…`), used only by pricing; `sourcery_tunnel` (`91eab35c-…`), the
Droplet's tunnel token.

Non-secret configuration (`wrangler.toml` `[vars]`): `PRICING_ORIGIN`,
`CATALOG_ORIGIN`, `POLAR_*`, `ALLOWED_ORIGIN_PREFIXES` per client (or folded
into `src/clients.js`), quota defaults, cache TTLs, Turnstile **site** keys.
Cloudflare account `722b682d1c0bb958ea4d14b5bc6275d1`; KV namespace
`LICENSES` (`3216419ee1244988a05fc0bad9d7b17c`) carries over so cached
Sourcery verdicts survive the cut-over.

## 8. Migration plan (in order; each step is shippable on its own)

| # | Step | Repo(s) | Done when |
|---|---|---|---|
| G0 | Bootstrap: copy `sourcery/gateway` (src, tests, wrangler) here with a provenance note; deploy as `tcg-api-gateway` on `*.workers.dev` only; same behaviour as today. | gateway | Test suite green; the `workers.dev` URL answers `/v1/health`. |
| G1 | Namespaced routing `/pricing/v1/*`, `/catalog/v1/*`; client/policy table; legacy aliases mapped. | gateway | Tests cover allow, deny, alias, header stripping, and forced fill policy. |
| G2 | `GET /pricing/v1/health` open through the gateway; pricing's freshness alert repointed to it. | gateway, pricing | Alert workflow green against the gateway URL. |
| G3 | Cut `api.dyzzyscards.com` over from `sourcery-gateway` to `tcg-api-gateway`; push secrets. | gateway | Sourcery's deployed e2e passes 8/8 through the new Worker (`F:/claude_temp/poke-scans/sourcery-e2e-deployed.py`). |
| G4 | Lock origins with Access (section 4). | gateway (+ Cloudflare) | Direct origin curl is denied; e2e still 8/8; freshness alert still green. |
| G5 | Public sessions: Turnstile, per-IP limits, edge cache, per-item quote cache. | gateway | Tests; a load test shows cached hits never reaching the origin. |
| G6 | poke-guide switches from R2 snapshots to the gateway (huddle with `_apps/poke_guide`). | poke_guide, gateway | poke-guide.com search and prices work with R2 unused. |
| G7 | Sourcery extension moves to the new paths; aliases removed once their hit counts reach zero; `sourcery/gateway` retired. | sourcery, gateway | No alias hits for 30 days. |
| G8 | Retire the R2 publisher (`pricing-publisher` and `tools/poke-guide/` in pricing) once nothing reads R2. **Decide first** whether R2 stays as the off-Droplet backup of `prices.db`/`history.db`, or is replaced by DigitalOcean volume snapshots. | pricing | No R2 reads in Cloudflare analytics for 14 days. |

Do G0–G4 before onboarding any new client: they move today's live traffic
safely, and the lock (G4) is the security win on its own.

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
