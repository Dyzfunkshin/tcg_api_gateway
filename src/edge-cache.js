// Edge caching for public clients (docs/PLAN.md section 6.3 point 5, step G5).
//
// Uses the colo's Cache API (caches.default). Entries are keyed by synthetic URLs on an
// .invalid host so they can never collide with a real request. Only clients whose
// policy forces fillPolicy "none" may cache (enforced in clients.js), so a cached answer
// is always one that spent no JustTCG budget, and it is safe to share between callers.
//
// Note: the Cache API is a no-op on *.workers.dev; caching only takes effect on a
// custom domain (api.dyzzyscards.com, from G3).

const CACHE_HOST = 'https://edge-cache.tcg-api-gateway.invalid';

// Response headers kept on a cached GET.
const KEPT_HEADERS = ['content-type', 'etag'];

export const cacheUrlForGet = (service, upstreamPath, search) => `${CACHE_HOST}/${service}${upstreamPath}${search}`;

// The cache URL for one quote item, or null when the item is not safely cacheable.
// Only the identity fields pricing documents are allowed; any other field could change
// the answer, so such an item always goes to the origin. Absent selectors stay absent
// (no defaults): a SKU-only item lets pricing recover selectors from the SKU, which is a
// different question from one that names them.
//
// The key is the exact values pricing receives, never a normalised form: pricing matches
// game verbatim (String(game), case-sensitive) and echoes the selectors back, so " " or
// "POKEMON" is a different question from "pokemon" (2026-11-09 security review). A selector
// that is present but not in canonical form is not cached at all, only forwarded.
const QUOTE_FIELDS = new Set(['game', 'productId', 'skuId', 'condition', 'printing']);
const CANONICAL = {
  game: /^[a-z0-9-]{1,64}$/, // pricing's game ids: "pokemon", "pokemon-japan", "onepiececardgame"
  // pricing's selector vocabulary is words with single spaces: "Near Mint", "Reverse Holofoil"
  condition: /^(?=.{1,64}$)[A-Za-z0-9-]+(?: [A-Za-z0-9-]+)*$/,
  printing: /^(?=.{1,64}$)[A-Za-z0-9-]+(?: [A-Za-z0-9-]+)*$/,
};
export function cacheUrlForQuoteItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (Object.keys(item).some((field) => !QUOTE_FIELDS.has(field))) return null;
  const hasProduct = Number.isSafeInteger(item.productId) && item.productId > 0;
  const hasSku = Number.isSafeInteger(item.skuId) && item.skuId > 0;
  if (hasProduct === hasSku) return null; // exactly one identifier
  const params = new URLSearchParams({ id: hasProduct ? 'p' + item.productId : 's' + item.skuId });
  for (const [field, param] of [['game', 'g'], ['condition', 'c'], ['printing', 'r']]) {
    if (item[field] === undefined) continue;
    if (typeof item[field] !== 'string' || !CANONICAL[field].test(item[field])) return null;
    params.set(param, item[field]);
  }
  return `${CACHE_HOST}/pricing/quote-item?${params}`;
}

// Only an answer that carries a price is shared: a null price may be a transient miss or
// the answer to an odd question, and must never be served to everyone for the TTL.
export const isCacheableQuoteAnswer = (answer) =>
  Boolean(answer) && typeof answer === 'object' && answer.market !== null && answer.market !== undefined;

// A cached Response, or null on a miss or any cache error.
export async function cacheGet(cache, url, log) {
  if (!cache) return null;
  try {
    return (await cache.match(url)) || null;
  } catch (error) {
    log('edge_cache_unavailable', { op: 'match', error: String(error && error.message) });
    return null;
  }
}

// Stores a body under `url` for ttlSeconds. Errors are logged, never thrown: the cache
// is an optimisation, not a dependency.
export async function cachePut(cache, url, body, headers, ttlSeconds, log) {
  if (!cache) return;
  const stored = { 'cache-control': `public, max-age=${ttlSeconds}` };
  for (const name of KEPT_HEADERS) if (headers[name]) stored[name] = headers[name];
  try {
    await cache.put(url, new Response(body, { status: 200, headers: stored }));
  } catch (error) {
    log('edge_cache_unavailable', { op: 'put', error: String(error && error.message) });
  }
}

export const headersOf = (response) => Object.fromEntries(KEPT_HEADERS.map((name) => [name, response.headers.get(name)]).filter(([, value]) => value));
