---
slug: rename-the-sourcery-client-to-mintuition
request: rename-the-sourcery-client-to-mintuition
title: Rename the Sourcery client to Mintuition
respondedBy: tcg_api_gateway
respondedAt: 2026-11-10
verdict: accepted
---

# Response to: Rename the Sourcery client to Mintuition

## Verdict

accepted — a naming change inside the gateway with no wire-contract impact.

## What's clear and accepted

- The licence client's id becomes `'mintuition'` (`src/clients.js`), so structured
  log events carry `client: 'mintuition'`. Nothing is deployed yet, so there is no
  dashboard or log query to keep a transition period for.
- Current-state prose and comments in `src/`, `test/`, `wrangler.toml`,
  `INTEGRATION.md` and `README.md` say Mintuition.
- `VERDICT_CACHE_URL` moves to a `mintuition.invalid` host. Cached licence verdicts
  are dropped once and refill from Polar.
- **Unchanged wire contract:** the same paths (legacy aliases included), the same
  `Authorization: Bearer <licence key>` + `X-Instance-Id` auth, and the same error
  codes. The extension ships nothing for this.
- **Not renamed:** the live Worker `sourcery-gateway`, which `tools/cutover.py`
  must keep naming until the cut-over moves the domain off it. Also kept are the
  Bitwarden names, the Polar product names, the Docker network and historical
  provenance notes (`docs/sourcery-gateway-README.md`, the PLAN decision log).

## Validity findings (checked against this repo)

- Referenced reality: confirmed on `dev`:
  - `src/clients.js` licence client `id: 'sourcery'` and its comment;
  - `src/routes.js` legacy-alias comment;
  - `src/worker.js` `VERDICT_CACHE_URL` and a comment;
  - `test/run.js` asserts on the client id;
  - `wrangler.toml` comments.
  Since your grep, `tools/cutover.py` and `tools/test_tools.py` also name
  `sourcery-gateway`, the live Worker the cut-over detaches. Those stay.
- Ownership & scope: this repo's names; nobody else can change them.
- Naming fit: it is a plain identifier change and the client id is already a free
  string.
- Conflicts: none. No consumer reads the client id, which appears only in logs and
  quota keys. The daily-quota keys are keyed by subject, not client id, so no
  counts are lost.
- Feasibility: mechanical.

## Blocking questions (answer these to proceed)

None.

## Plan

Filed as task #10 (`cr:rename-the-sourcery-client-to-mintuition`, ready). It runs
via `/task execute`. Done when `grep -i sourcery` over `src/ test/ wrangler.toml
INTEGRATION.md` finds only references to the live `sourcery-gateway` Worker, and
`npm test` passes.

## Next step for the requester

Nothing — accepted; track via task #10 in tcg_api_gateway.
