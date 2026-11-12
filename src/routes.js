// Every path the gateway knows (docs/PLAN.md sections 2-3).
//
// Routes are matched before any auth work: an unknown path is 404, a known path with
// the wrong method is 405. Whether a caller may use a route is the policy table's
// business (./clients.js), not this file's.
//
// Upstream routes mirror each service's INTEGRATION.md. When a service adds or changes
// a route, change it here, in the policies that grant it, and in the tests, together.

// One path segment naming a file: no slashes, no leading dot (so never "." or "..").
const FILE = '[A-Za-z0-9][A-Za-z0-9._-]{0,199}';
const DIGITS = '\\d{1,12}';
// One tag-key segment: the <file> characters plus percent-escapes, since catalog keys are
// "name|number" sent URL-encoded ("mew%7C25"). No leading dot, and no escape that decodes to
// "/", "\", "." or a control character, so it can never become a path or a traversal.
const TAG_KEY = '(?!\\.)(?:[A-Za-z0-9._-]|%(?!2[EeFf]|5[Cc]|[01][0-9A-Fa-f]|7[Ff])[0-9A-Fa-f]{2}){1,200}';

// Content-addressed file names: "<game>-<16 hex>.json" (pricing snapshots) and
// "catalog-<16 hex>.json" (catalog views). Anything else under those prefixes is unknown.
const SNAPSHOT_FILE = '[a-z0-9]+-[0-9a-f]{16}\\.json';
const CATALOG_VIEW_FILE = 'catalog-[0-9a-f]{16}\\.json';

const route = (id, method, service, pattern) => Object.freeze({ id, method, service, pattern: new RegExp('^' + pattern + '$') });

// The gateway's own routes, matched on the full request path.
export const GATEWAY_ROUTES = Object.freeze([
  route('gateway:health', 'GET', 'gateway', '/v1/health'),
  route('gateway:license.activate', 'POST', 'gateway', '/v1/license/activate'),
  route('gateway:license.deactivate', 'POST', 'gateway', '/v1/license/deactivate'),
  route('gateway:license', 'GET', 'gateway', '/v1/license'),
  route('gateway:session', 'POST', 'gateway', '/v1/session'),
]);

// Service routes, matched on the path after "/<service>" (so they start "/v1/").
export const SERVICE_ROUTES = Object.freeze([
  route('pricing:health', 'GET', 'pricing', '/v1/health'),
  route('pricing:quote', 'POST', 'pricing', '/v1/prices/quote'),
  route('pricing:product', 'GET', 'pricing', `/v1/prices/product/${DIGITS}`),
  route('pricing:history', 'GET', 'pricing', '/v1/history'),
  route('pricing:history.printings', 'GET', 'pricing', '/v1/history/printings'),
  route('pricing:history.coverage', 'GET', 'pricing', '/v1/history/coverage'),
  route('pricing:games', 'GET', 'pricing', '/v1/games'),
  route('pricing:snapshot.manifest', 'GET', 'pricing', '/v1/prices/snapshot/manifest\\.json'),
  route('pricing:snapshot.file', 'GET', 'pricing', `/v1/prices/snapshot/${SNAPSHOT_FILE}`),
  route('catalog:health', 'GET', 'catalog', '/v1/health'),
  route('catalog:manifest', 'GET', 'catalog', '/v1/manifest\\.json'),
  route('catalog:artifact', 'GET', 'catalog', `/v1/artifacts/${FILE}`),
  route('catalog:view', 'GET', 'catalog', `/v1/views/${CATALOG_VIEW_FILE}`),
  route('catalog:sets', 'GET', 'catalog', '/v1/sets'),
  route('catalog:image', 'GET', 'catalog', `/v1/images/${FILE}`),
  route('catalog:products.get', 'GET', 'catalog', `/v1/products/${DIGITS}`),
  route('catalog:products.lookup', 'POST', 'catalog', '/v1/products:lookup'),
  route('catalog:games', 'GET', 'catalog', '/v1/games'),
  route('catalog:tags', 'GET', 'catalog', '/v1/tags'),
  route('catalog:tags.write', 'POST', 'catalog', `/v1/tags/${TAG_KEY}`), // a write: granted to no client by default
]);

export const ROUTE_IDS = Object.freeze(new Set([...GATEWAY_ROUTES, ...SERVICE_ROUTES].map((r) => r.id)));

// Legacy aliases (PLAN.md section 3): the paths installed Mintuition extensions call today,
// rewritten onto the namespaced scheme. Removed at G7 once their logged hits reach zero.
const LEGACY_ALIASES = Object.freeze([
  [/^\/v1\/prices\/quote$/, () => '/pricing/v1/prices/quote'],
  [/^\/v1\/products:lookup$/, () => '/catalog/v1/products:lookup'],
  [new RegExp(`^/v1/products/(${DIGITS})$`), (m) => '/catalog/v1/products/' + m[1]],
  [/^\/v1\/prices\/games$/, () => '/pricing/v1/games'],
  [/^\/v1\/catalog\/games$/, () => '/catalog/v1/games'],
]);

const SERVICE_PREFIX = /^\/(pricing|catalog)(\/v1\/.*)$/;

// Resolves a request path to { routes, upstreamPath, aliasOf }, or null for an unknown path.
//   routes        every route on this path (one per method; the caller picks by method)
//   upstreamPath  the path to request from the service (null for gateway routes)
//   aliasOf       the legacy path the caller used, or null
export function matchPath(pathname) {
  const gatewayRoutes = GATEWAY_ROUTES.filter((r) => r.pattern.test(pathname));
  if (gatewayRoutes.length > 0) return { routes: gatewayRoutes, upstreamPath: null, aliasOf: null };

  let path = pathname;
  let aliasOf = null;
  for (const [pattern, rewrite] of LEGACY_ALIASES) {
    const match = pattern.exec(pathname);
    if (match) {
      path = rewrite(match);
      aliasOf = pathname;
      break;
    }
  }

  const service = SERVICE_PREFIX.exec(path);
  if (!service) return null;
  const [, serviceName, upstreamPath] = service;
  const routes = SERVICE_ROUTES.filter((r) => r.service === serviceName && r.pattern.test(upstreamPath));
  return routes.length > 0 ? { routes, upstreamPath, aliasOf } : null;
}
