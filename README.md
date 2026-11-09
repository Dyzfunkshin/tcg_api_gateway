# tcg_api_gateway

The single front door to the TCG services: one Cloudflare Worker at
`https://api.dyzzyscards.com` that every external client goes through, while
pricing and catalog stay private on the Droplet.

Nothing is built yet. The full plan (scope, routes, client policies, origin
lock, secrets, migration order) is in [docs/PLAN.md](docs/PLAN.md).
