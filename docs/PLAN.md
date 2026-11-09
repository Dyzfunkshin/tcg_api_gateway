# TCG API gateway — the single front door

**Status:** plan, agreed in principle 2026-11-08; open points settled
2026-11-09 (section 11). Built and tested offline, nothing deployed: G0, G1,
the gateway half of G2 (`/pricing/v1/health` open), the Worker half of G4
(Access service-token headers) and the Worker half of G5 (sessions, edge cache,
per-item quote cache), each on its own `feature/g<n>-…` branch, all merged
into `dev`. The Cloudflare token `tcg-api-gateway` has its permissions and is
in Bitwarden (`api-gateway`); deploys need the `owner-ops` machine token on the
PC. Still outside code: G2's alert repoint (after deploy), G4's Zero Trust
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
| **poke-guide website** (poke-guide.com) | Reads static snapshots from R2 (`data.poke-guide.com`) | Public static site | `public-session` (section 6.3) | Reads only: `POST pricing/v1/prices/quote` (fill policy forced to `none`, **max 100 items per call**), and GET `pricing/v1/prices/product/:id`, `pricing/v1/history*`, `pricing/v1/games`; `catalog/v1/manifest.json`, `catalog/v1/artifacts/*`, `catalog/v1/images/*`, `catalog/v1/products/*`, `catalog/v1/games` | **`none`, forced** | Origins `https://poke-guide.com` (+ preview origin). Per-IP limits. Edge-cached. Migration is the poke_guide huddle. |
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
5. Serve from the edge cache if the policy allows it and there is a fresh hit.
6. Forward: strip **every** client header except `content-type` and `accept`
   (as today), then add `CF-Access-Client-Id`, `CF-Access-Client-Secret`,
   `x-app-token` for that service, and, on **every** pricing request (not
   only quotes, since pricing treats an absent header as `default`),
   `x-fill-policy` from the policy. Body size cap of 1 MB (as today). The
   Access headers are added at G4.
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
only, never values. Run it after creating or rotating a secret. It follows the
pattern already used for `sourcery-gateway`:
`F:/claude_temp/tcg_pricing_service/bw_secret_ops.py push-worker`, run inside
the pricing image's `/opt/publisher/bin/python`, which has `bitwarden_sdk`.
That script is a throwaway; promote a cleaned-up version into this repo. Pushes
run as the owner, so use the `owner-ops` machine token (read/write on every
project; Windows Credential Manager entry `owner-ops/bitwarden-machine-token`,
read with `tcg_catalog_service/tools/machine_token.py --target
owner-ops/bitwarden-machine-token`), never a token mounted into a service.

| Worker secret | Purpose | Bitwarden secret (project) | Exists? |
|---|---|---|---|
| `PRICING_APP_TOKEN` | `x-app-token` to pricing | `PRICING_APP_TOKEN`, id `6f7c5b06-131c-4e77-9e93-bebcadfc5e9d` (`hosted-api`) | **Yes** (already pushed to `sourcery-gateway`) |
| `CATALOG_APP_TOKEN` | `x-app-token` to catalog | `CATALOG_APP_TOKEN`, id `cc0ded80-9afc-471a-903c-9a139e17e777` (`hosted-api`) | **Yes** (already pushed to `sourcery-gateway`) |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | Cloudflare Access service token (section 4) | to create in `api-gateway`: `TCG_GATEWAY_ACCESS_CLIENT_ID`, `TCG_GATEWAY_ACCESS_CLIENT_SECRET` | **No.** Create the service token in Zero Trust, then store both halves. |
| `TURNSTILE_SECRET_KEY` | verify Turnstile (section 6.3) | to create in `api-gateway`: `TCG_GATEWAY_TURNSTILE_SECRET` | **No.** Create a Turnstile widget for poke-guide.com (+ preview host). Its **site key is public** and goes in poke_guide's code, not Bitwarden. |
| `SESSION_SIGNING_KEY` | HMAC for public session tokens | to create in `api-gateway`: `TCG_GATEWAY_SESSION_SIGNING_KEY` | **No.** 32 random bytes; generate it inside the push tool so it is never displayed. |
| App keys (one per server-side app) | `app-key` clients (section 6.4) | to create in `api-gateway`: `TCG_GATEWAY_APP_KEY_<APP>` | **No.** Create one per app when that app onboards. Only the hash goes in `src/clients.js`. |

Deployment credentials (used by `wrangler deploy` / `push_secrets.py`, not by
the Worker):

| Credential | Bitwarden | Exists? |
|---|---|---|
| Cloudflare API token | `sourcery_cloudflare_api_token`, id `fae6f4f6-ca7b-401d-a71d-090af6411149` (`owner-ops`) | **Yes, but permissions are incomplete.** It has *Cloudflare Tunnel: Edit* (added 2026-11-08). It also needs *Workers Scripts: Edit*, *Workers KV Storage: Edit*, *Workers Routes: Edit* (zone `dyzzyscards.com`), *Access: Apps and Policies: Edit*, *Access: Service Tokens: Edit*, and *Turnstile: Edit*. Check what it already has before adding, under dash → Manage Account → Account API Tokens. Alternatively create a dedicated `tcg_gateway_cloudflare_api_token` and keep the Sourcery one tunnel-only. |
| Bitwarden machine token (PC) | n/a (`owner-ops`, Credential Manager, above) | **Yes.** `owner-ops` is already **Can read, write** on every project, so creating the `api-gateway` secrets needs no temporary permission change. |

Unchanged and not the gateway's concern: `JUSTTCG_API_KEY`
(`139c13f6-…`, project `pricing-runtime`), used only by pricing;
`sourcery_tunnel` (`b7dac9bb-…`, project `hosted-api`), the Droplet's tunnel token.

Non-secret configuration (`wrangler.toml` `[vars]`): `PRICING_ORIGIN`,
`CATALOG_ORIGIN`, `POLAR_*`, `ALLOWED_ORIGIN_PREFIXES` per client (or folded
into `src/clients.js`), quota defaults, cache TTLs, Turnstile **site** keys.
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
  the Worker secret `SESSION_SIGNING_KEY` with `tools/push_secrets.py`, as
  owner via `owner-ops` (as above).
- **Expected effect:** each active visitor gets one 401 and silently re-issues
  a session.

## 8. Migration plan (in order; each step is shippable on its own)

| # | Step | Repo(s) | Done when |
|---|---|---|---|
| G0 | Bootstrap: copy `sourcery/gateway` (src, tests, wrangler) here with a provenance note; deploy as `tcg-api-gateway` on `*.workers.dev` only; same behaviour as today. | gateway | Test suite green; the `workers.dev` URL answers `/v1/health`. |
| G1 | Namespaced routing `/pricing/v1/*`, `/catalog/v1/*`; client/policy table; legacy aliases mapped. | gateway | Tests cover allow, deny, alias, header stripping, and forced fill policy. |
| G2 | `GET /pricing/v1/health` open through the gateway; pricing's freshness alert repointed to it. | gateway, pricing | Alert workflow green against the gateway URL. |
| G3 | Cut `api.dyzzyscards.com` over from `sourcery-gateway` to `tcg-api-gateway`; push secrets. The custom-domain detach (old Worker) and reattach (new Worker) run as **one scripted step**; a gap of seconds to a minute is acceptable (Sourcery is the only live client and retries). The script ends by preparing G4: it creates the Access app and service token and pushes `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` as Worker secrets. **Build gate:** `POLAR_API_BASE` points at Polar production, not sandbox, before cut-over (sandbox licences can be obtained with test card numbers). **Stop at that step for the owner's go-ahead.** | gateway | Sourcery's deployed e2e passes 8/8 through the new Worker (`F:/claude_temp/poke-scans/sourcery-e2e-deployed.py`). |
| G4 | **Immediately after G3**, with no other step or work between them. Lock origins with Access (section 4). Until this lands, `pricing-origin.dyzzyscards.com` and `catalog-origin.dyzzyscards.com` are directly reachable and bypass every gateway check. The lock waits for the owner's go-ahead; the Access prep above has already run. | gateway (+ Cloudflare) | Direct origin curl is denied; e2e still 8/8; freshness alert still green. |
| G5 | Public sessions: Turnstile, per-IP limits, edge cache, per-item quote cache. | gateway | Tests; a load test shows cached hits never reaching the origin. |
| G6 | poke-guide switches from R2 snapshots to the gateway (huddle with `_apps/poke_guide`). | poke_guide, gateway | poke-guide.com search and prices work with R2 unused. |
| G7 | Sourcery extension moves to the new paths; aliases removed once their hit counts reach zero; `sourcery/gateway` retired. | sourcery, gateway | No alias hits for 30 days. |
| G8 | Retire the R2 publisher (`pricing-publisher` and `tools/poke-guide/` in pricing) once nothing reads R2. **Decide first** whether R2 stays as the off-Droplet backup of `prices.db`/`history.db`, or is replaced by DigitalOcean volume snapshots. | pricing | No R2 reads in Cloudflare analytics for 14 days. |

Do G0–G4 before onboarding any new client: they move today's live traffic
safely, and the lock (G4) is the security win on its own.

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
13. Edge cache TTLs: artifacts 1 year, images 1 day, manifest 60 s, all else
    1 hour. Only `fillPolicy: none` clients may use the shared edge cache
    (enforced by `assertValidClients`). Quote items are cached only when they
    carry nothing but `game`, exactly one of `productId`/`skuId`, `condition`,
    `printing`; absent selectors are not defaulted in the key.
