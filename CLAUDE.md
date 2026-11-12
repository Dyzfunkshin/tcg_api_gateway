# CLAUDE.md — tcg_api_gateway

The platform's single front door: one Cloudflare Worker (`tcg-api-gateway`) in
front of the private pricing and catalog services. **[docs/PLAN.md](docs/PLAN.md)
is the authority** for scope, routes, client policies, secrets and the migration
order (G0–G8); its section 11 logs owner decisions. Read it before changing
behaviour, and fold any new owner decision back into it.

## Layout

- `src/worker.js` — the request pipeline: match route, identify client, check
  policy, quota, forward (`handle(request, env, deps)`; `deps.fetch/now/log/clients`
  are injectable for tests).
- `src/routes.js` — every known path (gateway, pricing, catalog) and the legacy
  aliases. Mirrors the services' `INTEGRATION.md`.
- `src/clients.js` — the client policy table (routes, fill policy, quota, origins);
  validated at import by `assertValidClients`.
- `src/polar.js` — Polar licence-key API client (contract documented in the file).
- `src/kv.js` — tiny KV JSON helpers.
- `test/run.js` — hand-rolled offline tests (`node:assert`, fake KV, mocked fetch).
- `wrangler.toml` — Worker config; non-secret `[vars]` only.

## Commands

```
npm test        # offline; must stay offline and dependency-free
python tools/test_tools.py   # offline tests of the operator tools below
```

Operator tools (Python 3.11+, stdlib + `bitwarden-sdk`; run via the `gateway-deploy` Bitwarden machine account).
Each prints its plan and contacts nothing unless given `--apply`:

```
python tools/check_cloudflare_token.py          # read-only token permission check
python tools/push_secrets.py [--only NAME] [--generate-session-key] [--apply]
python tools/cutover.py [--preflight | --apply] # G3 cut-over + G4 Access lock; stops for typed go-aheads
```

`wrangler` is not a dependency of this repo; use `npx wrangler@4` when deploying.
**Never deploy with wrangler 3:** it silently ignores the `[[ratelimits]]` bindings
(only a warning) and the Worker then runs with no per-minute limits. Check the
binding list in `npx wrangler@4 deploy --dry-run` output before any real deploy.

**Deploying:** push a version tag on a commit that is on `main` (`git tag v1.2.3 && git push
origin v1.2.3`). `.github/workflows/deploy.yml` runs the tests, reads the Cloudflare token
from Bitwarden (machine account `gateway-ci`, GitHub secret `BW_ACCESS_TOKEN`) and runs
`wrangler@4 deploy`. Only the owner creates tags; a deploy from a PC is the fallback.

## Rules

- **Zero runtime dependencies.** Worker code uses only platform APIs.
- **Tests stay offline**; set `process.exitCode`, never `process.exit()`.
- **Every policy rule gets an allow-case and a deny-case test.**
- **The services' `INTEGRATION.md` files are the route contract.** When pricing
  or catalog changes a route, the allow-list and its tests change together.
  When the gateway's own HTTP surface changes, update this repo's
  `INTEGRATION.md`.
- **Rate-limit bindings in `wrangler.toml` must match the `perMinute` of the
  policies that name them** (a binding's limit is fixed at deploy).
- **Never take `x-fill-policy` from a client**; the gateway sets it from policy.
- **Secrets never appear in code, logs, or output.** Bitwarden (project
  `api-gateway`) is the source of truth; see PLAN.md section 7. Licence keys are
  logged only as a hash prefix.
- **No deploy, version tag, secret push, or mutating Cloudflare API call** without the
  owner's go-ahead for that action. A `v*` tag on `main` is a production deploy.
- **Git:** one branch per piece of work, committed at the end of it; merge to `dev` or
  `main` only when the owner asks.
