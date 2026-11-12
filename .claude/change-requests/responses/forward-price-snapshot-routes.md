---
slug: forward-price-snapshot-routes
request: forward-price-snapshot-routes
title: Forward the price snapshot routes for poke-guide
respondedBy: tcg_api_gateway
respondedAt: 2026-11-11
verdict: accepted
---

# Response to: Forward the price snapshot routes for poke-guide

## Verdict

accepted — both routes will be forwarded and granted to the poke-guide client. One
acceptance criterion is not adopted: the gateway does not cache responses at the edge.

## What's clear and accepted

The gateway commits to:

- `GET /pricing/v1/prices/snapshot/manifest.json` forwards to pricing's
  `/v1/prices/snapshot/manifest.json`.
- `GET /pricing/v1/prices/snapshot/<file>` forwards only when `<file>` matches
  `^[a-z0-9]+-[0-9a-f]{16}\.json$`. Any other path under `/pricing/v1/prices/snapshot/`
  gets the gateway's 404 (`not_found`) and never reaches pricing.
- Both are allowed for the `poke-guide` public-session client (an `Authorization: Session <token>` from
  `POST /v1/session`, origins `https://poke-guide.com` and `https://dyzfunkshin.github.io`).
  A request without a session gets 401. No other client is granted them in this change.
- Pass-through: the status and body pricing returns reach the browser as sent, with
  pricing's `content-type`, `ETag` and `Cache-Control`, and pricing's 404 for a retired
  file. Other response headers (including `Vary`) are not copied; Cloudflare's edge
  negotiates compression with the browser itself. (Corrected after build, 2026-11-11.) The body
  is streamed, not buffered, so file size is not limited by the Worker's memory. The
  decoded bytes a browser receives are pricing's bytes, so the manifest's `sha256` and
  `bytes` hold.
- Requests count against the session limits (300 per minute per session, plus the per-IP
  limit). `x-fill-policy` is still set by the gateway (`none` for poke-guide); pricing
  ignores it on these routes.

Not adopted: "a file response is cached at the edge; a repeat request does not reach the
origin". The gateway is a gatekeeper only (owner decision, PLAN.md section 11): it holds
no response cache, so every request with a valid session reaches pricing. Repeat requests
from the same browser are covered by pricing's own `Cache-Control: public,
max-age=31536000, immutable`, which the browser honours; each new visitor's first fetch
of a file reaches the origin. The manifest criterion (never stale) is met for the same
reason: nothing is cached here.

## Validity findings (checked against this repo)

- Referenced reality: confirmed. `src/routes.js:31-48` (`SERVICE_ROUTES`) has no snapshot
  route, so `matchRoute` returns null and the live gateway answers 404 for both paths
  (probed 2026-11-11). `INTEGRATION.md:165-166` lists them as pending on pricing. The
  poke-guide client is at `src/clients.js:70-96` and does not list them.
- Ownership and scope: the gateway's. The origin is behind Cloudflare Access (G4), so the
  allow-list here is the only way to expose a pricing route.
- Fit: two more `route(...)` entries and two route ids in one client's list; the same
  shape as `catalog:manifest` / `catalog:artifact`. Proposed ids: `pricing:snapshot.manifest`
  and `pricing:snapshot.file`.
- Conflicts: only the edge-cache criterion, which contradicts the pass-through decision.
  No other consumer is affected.
- Feasibility: small. GET bodies are already streamed (huddle `poke-guide-via-gateway`,
  item A2).

## Blocking questions (answer these to proceed)

None.

## Plan

One task, #14 "Forward price snapshot routes" (label `cr:forward-price-snapshot-routes`,
category Public clients): the two routes, the poke-guide grant, allow and deny tests for
each, pass-through tests for body and cache headers, and the `INTEGRATION.md` update. It
takes effect when the owner next deploys the Worker.

## Next step for the requester

Nothing to change; deploy pricing to the Droplet so the routes exist at the origin. If
origin load from first-visit file fetches becomes a problem, raise it with the owner, since
edge caching is an owner decision.
