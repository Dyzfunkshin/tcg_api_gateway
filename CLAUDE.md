# CLAUDE.md — tcg_api_gateway

The platform's single front door: one Cloudflare Worker (`tcg-api-gateway`) in
front of the private pricing and catalog services. **[docs/PLAN.md](docs/PLAN.md)
is the authority** for scope, routes, client policies, secrets and the migration
order (G0–G8); its section 11 logs owner decisions. Read it before changing
behaviour, and fold any new owner decision back into it.

## Layout

- `src/worker.js` — routing, auth, quotas, forwarding (`handle(request, env, deps)`;
  `deps.fetch/now/log` are injectable for tests).
- `src/polar.js` — Polar licence-key API client (contract documented in the file).
- `src/kv.js` — tiny KV JSON helpers.
- `test/run.js` — hand-rolled offline tests (`node:assert`, fake KV, mocked fetch).
- `wrangler.toml` — Worker config; non-secret `[vars]` only.

## Commands

```
npm test        # offline; must stay offline and dependency-free
```

`wrangler` is not a dependency of this repo; use `npx wrangler` when deploying.

## Rules

- **Zero runtime dependencies.** Worker code uses only platform APIs.
- **Tests stay offline**; set `process.exitCode`, never `process.exit()`.
- **Every policy rule gets an allow-case and a deny-case test.**
- **The services' `INTEGRATION.md` files are the route contract.** When pricing
  or catalog changes a route, the allow-list and its tests change together.
- **Never take `x-fill-policy` from a client**; the gateway sets it from policy.
- **Secrets never appear in code, logs, or output.** Bitwarden (project
  `poke-scans`) is the source of truth; see PLAN.md section 7. Licence keys are
  logged only as a hash prefix.
- **No deploy, secret push, or Cloudflare API call** until the owner confirms
  the Cloudflare token's Workers permissions (PLAN.md section 8, build gates).
- **Git:** one branch per migration step (`feature/g0-bootstrap`, `feature/g1-…`),
  committed at the end of the step; never merge to `main`.
