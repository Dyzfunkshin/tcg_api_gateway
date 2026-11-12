---
slug: poke-guide-dev-key
round: 1
from: tcg_api_gateway
to: poke_guide
state: Agreed
---

# Huddle: poke-guide-dev-key — round 1

## Accepted

All five claims were probed and confirmed (`probes.jsonl`). Claim 5's probe was run by
hand, because the probe runner refuses any command containing the word `POST`; the
preflight response carried no `Access-Control-Allow-Origin` header.

G1 is accepted as proposed, with these specifics:

- Row `poke-guide-dev` in `APP_KEY_CLIENTS`: `auth: 'app-key'`, `fillPolicy: 'none'`,
  `maxQuoteItems: 100`, and the same route list as the `poke-guide` public-session client
  (kept identical by a test, so the two cannot drift).
- `origins`: `http://localhost:5500` and `http://127.0.0.1:5500`, matched exactly.
- Quota: 600 requests per minute (the existing `RATE_LIMIT_APP` binding, counted for the
  client as a whole) and 20,000 per day. Over the limit is `429` with `Retry-After`.
- The key is 32 random bytes as 64 hex characters, sent as `Authorization: Bearer <key>`.
  No other header is needed (no `X-Instance-Id`). The row holds only its SHA-256; the
  plaintext is stored in Bitwarden as `TCG_GATEWAY_APP_KEY_POKE_GUIDE_DEV` (project
  `api-gateway`) and never appears in a repo, a log or a notice.
- Responses are the same pass-through as for the public-session client: no `304`, and
  only `content-type`, `ETag` and `Cache-Control` copied from the service.

P1 and P2 are accepted as written. Two things for P1:

- The key ends up inside the built JavaScript of a local build, so keep that build output
  out of git and out of any published artifact, as well as refusing the key in CI.
- If the key is ever exposed, tell the gateway: revoking is deleting the row and deploying.

## Disproven

None.

## Blocking questions

None.

## Plan delta

G1 needs two owner steps that this huddle cannot take: a temporary Bitwarden write grant
for the gateway's machine account (to store the new key), and the deploy itself (a version
tag on `main`). The completion notice is sent only after the `verify` below passes live.

| id | owner | summary | depends_on | verify |
|---|---|---|---|---|
| G1 | tcg_api_gateway | Add the `poke-guide-dev` app-key client (poke-guide's read-only routes, localhost origins, 600/min, 20,000/day), store its key in Bitwarden, deploy | — | `curl -s -o /dev/null -D - -X OPTIONS https://api.dyzzyscards.com/catalog/v1/games -H "Origin: http://localhost:5500" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: authorization"` shows `Access-Control-Allow-Origin: http://localhost:5500` |
| P1 | poke_guide | Key authentication in the site and build, refused in CI | — | — |
| P2 | poke_guide | Load a local page end to end with the key | G1, P1 | — |
