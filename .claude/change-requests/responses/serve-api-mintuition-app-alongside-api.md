---
slug: serve-api-mintuition-app-alongside-api
request: serve-api-mintuition-app-alongside-api
title: Serve api.mintuition.app alongside api.dyzzyscards.com
respondedBy: tcg_api_gateway
respondedAt: 2026-11-10
verdict: accepted
---

# Response to: Serve api.mintuition.app alongside api.dyzzyscards.com

## Verdict

accepted: both hostnames serve this Worker from the cut-over. Owner decision
(2026-11-10): **every tier keeps `x-fill-policy: default`**, not the
collector/trader `none` you proposed.

## What's clear and accepted

- **Hostnames.** From the G3 cut-over, `api.mintuition.app` and
  `api.dyzzyscards.com` both reach `tcg-api-gateway` with identical behaviour:
  - the same routes, legacy aliases included;
  - the same licence auth;
  - the same CORS for `chrome-extension://` and `moz-extension://`;
  - the same `/v1/health` body.
  `api.dyzzyscards.com` keeps serving every other client.
- **Polar production.** This is already on the gateway's `dev` (PLAN decision 27):
  - `POLAR_API_BASE = https://api.polar.sh`;
  - organization `876bc883-f2c8-48a7-be15-ac1470d159ae`;
  - `POLAR_TIERS` maps exactly your three benefit ids to `collector`, `trader`
    and `pro`.
  A key from any other benefit is refused, as today. It goes live with the
  first deploy, after the owner cleared the sandbox build gate.
- **Fill policy, which differs from your proposal.**
  `FILL_POLICY_BY_TIER = collector:default,trader:default,pro:default`. The owner
  decided all three paid tiers may let pricing fetch missing prices from JustTCG.
  "Near Mint only" vs "per-condition" is therefore **your** feature gate, not the
  gateway's: use the tier below to decide what to show.
  - If the owner ever wants a tier to be cache-only, that changes this one var.
    The extension's contract does not change.
- **Tier in licence status.** It is unchanged and already present. `GET
  /v1/license` (and the activate response) returns `tier` (`collector` |
  `trader` | `pro`, or `null` for an unmapped benefit), cached with the verdict.

## Validity findings (checked against this repo)

- **Cloudflare (read-only API, 2026-11-10):**
  - zone `mintuition.app` is active in the same account as `dyzzyscards.com`;
  - `api.mintuition.app` is attached to **no** Worker yet (your branch's
    `wrangler.toml` routes are not deployed);
  - `api.dyzzyscards.com` is a Custom Domain on `sourcery-gateway`.
  At cut-over the first is simply attached, and the second moves as planned.
- **Cut-over tooling:** `tools/cutover.py` handles a single hostname
  (`CUSTOM_DOMAIN`) and needs a list. `tools/check_cloudflare_token.py` checks
  only the `dyzzyscards.com` zone.
- **Licence status already carries `tier`** (`src/worker.js`, licence status and
  activate responses; covered by tests).
- **Scope:** routing both hostnames is the gateway's job; what each tier unlocks
  in the UI is the extension's.
- **Conflicts:** the only one is fill policy, settled by the owner as above.
- **Constraint check:** you asked us not to deploy production Polar until the
  owner switched off the sandbox. The owner did that on 2026-11-10.

## Blocking questions (answer these to proceed)

None.

## Plan

Filed as task #11 (`cr:serve-api-mintuition-app-alongside-api`, ready). It
covers:
- `tools/cutover.py` moving or attaching both hostnames, with preflight,
  rollback and re-run per host;
- token-check coverage for the `mintuition.app` zone;
- tests and docs.

The `wrangler.toml` route lines for both hosts are added after the cut-over
(owner step), so a later deploy keeps both domains.

## Next step for the requester

Gate collector/trader vs pro features in the extension on `tier` from
`GET /v1/license`. Before the cut-over, make sure your branch's `sourcery-gateway`
deploy does not attach `api.mintuition.app`, or tell the gateway owner if it
does: the cut-over then moves it like `api.dyzzyscards.com`.
