// Client policies: who may call what (docs/PLAN.md section 5).
//
// Every request is attributed to exactly one client and every client has one policy.
// This table is reviewed like code; credentials never live here (app keys appear only
// as their SHA-256). Fields:
//
//   id          stable name; appears in logs and quota keys
//   auth        'license' | 'app-key' | 'public-session' | 'none'
//   routes      route ids from ./routes.js this client may call
//   fillPolicy  x-fill-policy sent to pricing: 'none' | 'default' | 'by-license-tier'.
//               Always set by the gateway; a client-sent value is never forwarded.
//   quota       { daily, perMinute, perMinuteBinding } — daily counts live in KV,
//               per-minute limits in the named Workers rate-limiting binding (whose
//               limit in wrangler.toml must equal perMinute). Licence limits can be
//               overridden by the DAILY_QUOTA / BURST_PER_MINUTE vars.
//   maxQuoteItems  cap on a pricing quote batch, or null for pricing's own cap (500)
//   origins     browser origins that get CORS headers: a bare scheme ("chrome-extension://")
//               matches by prefix, a full origin ("https://poke-guide.com") exactly
//   cache       { routeId: edge TTL seconds } or null; only fillPolicy 'none' clients may cache
import { ROUTE_IDS } from './routes.js';

// Routes every caller may reach, credential or not. pricing:health is open for
// pricing's tcgcsv freshness alert (PLAN.md section 4, step G2); pricing serves it
// without a token anyway, and it is read-only.
// gateway:session is where a public site exchanges a Turnstile proof for a session.
const OPEN_ROUTES = ['gateway:health', 'gateway:license.activate', 'gateway:session', 'pricing:health'];

const HOUR_SECONDS = 60 * 60;
const YEAR_SECONDS = 365 * 24 * HOUR_SECONDS;

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
// (TCG_GATEWAY_APP_KEY_<APP>, project api-gateway) and the app's own secret store.
// Revoke by deleting the row and redeploying. None are onboarded yet.
export const APP_KEY_CLIENTS = Object.freeze([]);

// Public browser clients (PLAN.md section 6.3): a Turnstile-proven, short-lived session
// token, read-only routes, fill policy forced to none, per-IP limits, edge-cached.
// Origins here are matched EXACTLY (a site origin is never a prefix match).
// `cache` maps route id -> edge TTL seconds; pricing:quote is cached per item.
export const PUBLIC_SESSION_CLIENTS = Object.freeze([
  Object.freeze({
    id: 'poke-guide',
    auth: 'public-session',
    routes: Object.freeze([
      'pricing:quote',
      'pricing:product',
      'pricing:history',
      'pricing:history.printings',
      'pricing:history.coverage',
      'pricing:games',
      'catalog:manifest',
      'catalog:artifact',
      'catalog:image',
      'catalog:products.get',
      'catalog:games',
    ]),
    fillPolicy: 'none',
    quota: Object.freeze({ daily: null, perMinute: 300, perMinuteBinding: 'RATE_LIMIT_SESSION' }),
    maxQuoteItems: 100,
    // the Turnstile widget on the site must be rendered with this action (a public label,
    // echoed back by siteverify). Other widgets' tokens already fail siteverify (each widget
    // has its own secret); this only stops our own widget, reused elsewhere on the site, from
    // buying a session.
    turnstileAction: 'gateway-session',
    // production (GitHub Pages, CNAME poke-guide.com) and the preview build
    // (GitHub Pages of <owner>/poke-guide-preview, served from the owner's github.io origin)
    origins: Object.freeze(['https://poke-guide.com', 'https://dyzfunkshin.github.io']),
    cache: Object.freeze({
      'catalog:artifact': YEAR_SECONDS, // content-hashed, immutable
      'catalog:image': 24 * HOUR_SECONDS,
      'catalog:manifest': 60, // names the current artifacts: keep it short
      'catalog:products.get': HOUR_SECONDS,
      'catalog:games': HOUR_SECONDS,
      'pricing:quote': HOUR_SECONDS, // per item
      'pricing:product': HOUR_SECONDS,
      'pricing:history': HOUR_SECONDS,
      'pricing:history.printings': HOUR_SECONDS,
      'pricing:history.coverage': HOUR_SECONDS,
      'pricing:games': HOUR_SECONDS,
    }),
  }),
]);

const isSchemePrefix = (entry) => entry.endsWith('://');

// Whether a browser Origin matches a client origin entry: an entry that is only a scheme
// ("chrome-extension://") matches by prefix, anything else must be exactly equal, so
// "https://poke-guide.com" never admits "https://poke-guide.com.evil.example".
export const originMatches = (origin, entry) => (isSchemePrefix(entry) ? origin.startsWith(entry) : origin === entry);

// Throws on a malformed table, so a bad policy fails tests and deploys, never requests.
export function assertValidClients({ anonymous, license, appKeys, publicSessions = [] }) {
  const ids = new Set();
  for (const client of [anonymous, license, ...appKeys, ...publicSessions]) {
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
  for (const client of publicSessions) {
    if (client.auth !== 'public-session') throw new Error(`client ${client.id}: public rows need auth 'public-session'`);
    // public traffic can never spend JustTCG budget or write anything (PLAN.md 6.3 point 4)
    if (client.fillPolicy !== 'none') throw new Error(`client ${client.id}: public clients must use fillPolicy none`);
    if (client.routes.includes('catalog:tags.write')) throw new Error(`client ${client.id}: public clients may not write`);
    if (!Number.isInteger(client.maxQuoteItems) || client.maxQuoteItems < 1) throw new Error(`client ${client.id}: public clients need a quote batch cap`);
    if (!client.quota.perMinuteBinding) throw new Error(`client ${client.id}: public clients need a per-IP rate-limit binding`);
    if (typeof client.turnstileAction !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(client.turnstileAction)) {
      throw new Error(`client ${client.id}: public clients need a turnstileAction of 1-32 chars [A-Za-z0-9_-]`);
    }
    for (const origin of client.origins) {
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) throw new Error(`client ${client.id}: origin ${origin} must be an exact https origin`);
    }
  }
  for (const client of [anonymous, license, ...appKeys, ...publicSessions]) {
    if (!client.cache) continue;
    // the edge cache is shared across callers, so only budget-free responses may land in it
    if (client.fillPolicy !== 'none') throw new Error(`client ${client.id}: edge caching needs fillPolicy none`);
    for (const [routeId, ttl] of Object.entries(client.cache)) {
      if (!client.routes.includes(routeId)) throw new Error(`client ${client.id}: caches route ${routeId} it is not granted`);
      if (!Number.isInteger(ttl) || ttl < 1) throw new Error(`client ${client.id}: bad TTL for ${routeId}`);
    }
  }
  if (anonymous.routes.some((id) => !OPEN_ROUTES.includes(id))) throw new Error('the anonymous client may only have open routes');
}

export const DEFAULT_CLIENTS = Object.freeze({
  anonymous: ANONYMOUS_CLIENT,
  license: LICENSE_CLIENT,
  appKeys: APP_KEY_CLIENTS,
  publicSessions: PUBLIC_SESSION_CLIENTS,
});
assertValidClients(DEFAULT_CLIENTS);

export const isOpenRoute = (routeId) => OPEN_ROUTES.includes(routeId);
