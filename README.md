# tcg_api_gateway

The single front door to the TCG services: one Cloudflare Worker at
`https://api.dyzzyscards.com` that every external client goes through, while
pricing and catalog stay private on the Droplet.

The full plan (scope, routes, client policies, origin lock, secrets, migration
order) is in [docs/PLAN.md](docs/PLAN.md). The HTTP contract for consumers is
[INTEGRATION.md](INTEGRATION.md).

```
npm test          # offline, no dependencies, Node 22+
```

## Provenance

Bootstrapped (step G0) from `_apps/sourcery/gateway` at sourcery commit
`401b189` ("Gateway serves the pricing and catalog games lists"):
`src/worker.js`, `src/polar.js`, `src/kv.js`, `test/run.js` and
`wrangler.toml` were copied verbatim and then refactored here. That gateway's
README at the same commit is kept as
[docs/sourcery-gateway-README.md](docs/sourcery-gateway-README.md) for
reference. This repo is now the source of truth; `sourcery/gateway` is retired
at step G7.
