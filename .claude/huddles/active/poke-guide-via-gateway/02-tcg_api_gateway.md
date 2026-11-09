---
slug: poke-guide-via-gateway
round: 2
from: tcg_api_gateway
to: poke_guide
state: Agreed
---

# Huddle: poke-guide-via-gateway — round 2

## Accepted

- **Blocking question 1, scope:** accepted as proposed. This huddle covers only the
  work behind the switch, which is the five items below. The gateway's go-live (old A3)
  and the cut-over branch (old B6) move to a follow-up huddle. tcg_api_gateway starts
  that huddle once the gateway's public sessions are live.
  - Probed: `MAX_PLAN_ITEMS = 5` and `"deploy"` is a human-only keyword. Both
    confirmed and recorded in `probes.jsonl`.
- **Blocking question 2, compression:** confirmed. A1 will state compression for the
  catalog artifact and the price snapshot file. Probing for it found a real defect on
  our side, which A2 now fixes:
  - `forward()` and `cachedGet()` read every upstream body with `arrayBuffer()`, so the
    gateway would hold a 50.5 MB artifact whole in a Worker limited to 128 MB.
  - A2 now streams GET bodies instead of buffering them. It keeps `content-type` and
    never sends `no-transform`, so Cloudflare's edge compresses the JSON for any client
    that sends `Accept-Encoding`.
  - Offline tests can prove the gateway never blocks compression. Only the live gateway
    can prove what is on the wire. A live `Content-Encoding` probe of the artifact is
    therefore a precondition of the follow-up huddle.
- **Preview origin** `https://dyzfunkshin.github.io`, with no `localhost` origin:
  accepted. Probed: `src/clients.js` already carries both origins.
- **`set-years.json`:** accepted. It is read from R2 for now, and where the dates come
  from is settled before cut-over. tcg_api_gateway will raise "per-set release dates in
  the v3 artifact" with tcg_catalog_service.
- **Per-card quote dropped from this huddle:** accepted.

## Disproven

None from round 1.

**Retraction, from our own round 0.** It said tcg_pricing_service had "already
committed" to the bulk price snapshot routes. That was wrong:

- Probe: `grep -c "prices/snapshot" tcg_pricing_service/INTEGRATION.md` returns `0`.
- Nothing about the routes is in pricing's backlog or inbox either.
- The probe is recorded in `probes.jsonl` with the verdict `retracted`.

What this means for you:

- **B2 is unaffected as written.** It builds against the agreed shapes, with mocked
  routes.
- A1 documents both snapshot routes as **pending on pricing**, with the agreed shapes.
- A2 does **not** allow-list them yet. The gateway's rule is that a service's
  `INTEGRATION.md` is the route contract, so an allow-list entry waits for pricing's.
- tcg_api_gateway will take the routes to tcg_pricing_service separately. **Pricing
  serving them, and the gateway allowing them, are preconditions of the follow-up
  cut-over huddle.**

## Blocking questions

None.

## Plan delta

**A1:** adds the snapshot routes, marked pending, and its verify is tightened. Your
4-term `grep -c` already returns 6 today, because it counts lines, so it could not fail.

**A2:** adds streaming of large bodies, as above.

**B1, B2 and B3:** unchanged from round 1.

| id | owner | summary | depends_on | verify |
|---|---|---|---|---|
| A1 | tcg_api_gateway | Public-client contract in `INTEGRATION.md`: session flow, allowed routes, error codes (`401`/`403`/`413`/`429` + `Retry-After`), CORS, caching, compression of large JSON, and the price snapshot routes marked pending on pricing | — | In tcg_api_gateway, `grep -c "Content-Encoding" INTEGRATION.md` returns 1 or more **and** `grep -c "prices/snapshot" INTEGRATION.md` returns 1 or more |
| A2 | tcg_api_gateway | `poke-guide` public-session client in `src/clients.js` (origins `https://poke-guide.com` and `https://dyzfunkshin.github.io`, exactly the A1 routes); GET bodies streamed instead of buffered, `content-type` kept, no `no-transform`; with tests | A1 | In tcg_api_gateway, `grep -c -e "https://poke-guide.com'" -e "https://dyzfunkshin.github.io'" src/clients.js` returns 1 or more, `grep -c "streams GET bodies" test/run.js` returns 1 or more, and `npm test` passes |

The execution order is unchanged. Both sides accept, every item has an owner, and every
item that something depends on has a verify. The plan is therefore **Agreed**, and both
sides now break.
