// Client policies: who may call what (docs/PLAN.md section 5).
//
// Every request is attributed to exactly one client and every client has one policy.
// This table is reviewed like code; credentials never live here (app keys appear only
// as their SHA-256). Fields:
//
//   id          stable name; appears in logs and quota keys
//   auth        'license' | 'app-key' | 'none'   ('public-session' arrives at G5)
//   routes      route ids from ./routes.js this client may call
//   fillPolicy  x-fill-policy sent to pricing: 'none' | 'default' | 'by-license-tier'.
//               Always set by the gateway; a client-sent value is never forwarded.
//   quota       { daily, perMinute, perMinuteBinding } — daily counts live in KV,
//               per-minute limits in the named Workers rate-limiting binding (whose
//               limit in wrangler.toml must equal perMinute). Licence limits can be
//               overridden by the DAILY_QUOTA / BURST_PER_MINUTE vars.
//   maxQuoteItems  cap on a pricing quote batch, or null for pricing's own cap (500)
//   origins     browser Origin prefixes that get CORS headers
//   cache       edge-cache rules, or null (edge caching arrives at G5)
import { ROUTE_IDS } from './routes.js';

// Routes every caller may reach, credential or not. pricing:health is open for
// pricing's tcgcsv freshness alert (PLAN.md section 4, step G2); pricing serves it
// without a token anyway, and it is read-only.
const OPEN_ROUTES = ['gateway:health', 'gateway:license.activate', 'pricing:health'];

// The client for a request with no Authorization header at all. Only ever the open
// routes; per-IP limited when the RATE_LIMIT_PUBLIC binding exists.
export const ANONYMOUS_CLIENT = Object.freeze({
  id: 'anonymous',
  auth: 'none',
  routes: Object.freeze(OPEN_ROUTES),
  fillPolicy: 'none',
  quota: Object.freeze({ daily: null, perMinute: null, perMinuteBinding: 'RATE_LIMIT_PUBLIC' }),
  maxQuoteItems: 0,
  origins: Object.freeze([]),
  cache: null,
});

// The Sourcery browser extension, authenticated by a Polar licence key + X-Instance-Id.
export const LICENSE_CLIENT = Object.freeze({
  id: 'sourcery',
  auth: 'license',
  routes: Object.freeze([
    ...OPEN_ROUTES,
    'gateway:license',
    'gateway:license.deactivate',
    'pricing:quote',
    'pricing:games',
    'catalog:products.lookup',
    'catalog:products.get',
    'catalog:games',
  ]),
  fillPolicy: 'by-license-tier', // basic:none, pro:default via FILL_POLICY_BY_TIER
  quota: Object.freeze({ daily: 20000, perMinute: 300, perMinuteBinding: 'RATE_LIMIT_LICENSE' }),
  maxQuoteItems: null,
  origins: Object.freeze(['chrome-extension://', 'moz-extension://']),
  cache: null,
});

// Server-side apps, one row per app, each with its own key (PLAN.md section 6.4).
// keySha256 = sha256 hex of the 32-byte key; the plaintext is only in Bitwarden
// (TCG_GATEWAY_APP_KEY_<APP>, project poke-scans) and the app's own secret store.
// Revoke by deleting the row and redeploying. None are onboarded yet.
export const APP_KEY_CLIENTS = Object.freeze([]);

// Throws on a malformed table, so a bad policy fails tests and deploys, never requests.
export function assertValidClients({ anonymous, license, appKeys }) {
  const ids = new Set();
  for (const client of [anonymous, license, ...appKeys]) {
    if (ids.has(client.id)) throw new Error(`duplicate client id ${client.id}`);
    ids.add(client.id);
    for (const routeId of client.routes) {
      if (!ROUTE_IDS.has(routeId)) throw new Error(`client ${client.id}: unknown route ${routeId}`);
    }
    if (!['none', 'default', 'by-license-tier'].includes(client.fillPolicy)) throw new Error(`client ${client.id}: bad fillPolicy`);
    if (client.fillPolicy === 'by-license-tier' && client.auth !== 'license') throw new Error(`client ${client.id}: by-license-tier needs licence auth`);
    if (client.auth !== 'license' && client.routes.some((id) => id === 'gateway:license' || id === 'gateway:license.deactivate')) {
      throw new Error(`client ${client.id}: licence routes need licence auth`);
    }
  }
  for (const client of appKeys) {
    if (client.auth !== 'app-key') throw new Error(`client ${client.id}: app-key rows need auth 'app-key'`);
    if (!/^[0-9a-f]{64}$/.test(client.keySha256 ?? '')) throw new Error(`client ${client.id}: keySha256 must be 64 lowercase hex`);
  }
  if (anonymous.routes.some((id) => !OPEN_ROUTES.includes(id))) throw new Error('the anonymous client may only have open routes');
}

export const DEFAULT_CLIENTS = Object.freeze({ anonymous: ANONYMOUS_CLIENT, license: LICENSE_CLIENT, appKeys: APP_KEY_CLIENTS });
assertValidClients(DEFAULT_CLIENTS);

export const isOpenRoute = (routeId) => OPEN_ROUTES.includes(routeId);
