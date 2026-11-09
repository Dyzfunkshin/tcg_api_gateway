// TCG API gateway (G0: still behaves exactly like sourcery/gateway at 401b189).
//
// Validates a Polar license key, enforces per-key quotas, and forwards
// allow-listed routes to two private origins (pricing, catalog), injecting each
// origin's service token. See ../docs/PLAN.md for where this is going and
// ../docs/sourcery-gateway-README.md for today's routes and env (the Polar
// contract itself is documented in ./polar.js).
import { getJson, putJson, deleteKey } from './kv.js';
import * as polar from './polar.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_CORS_PREFIXES = 'chrome-extension://,moz-extension://';
const INACTIVE_STATUSES = new Set(['expired', 'revoked', 'disabled']);
const INACTIVE_DETAIL = /expired|revoked|disabled/i;

// ---------- small helpers ----------

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const toList = (value) =>
  String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const errorResponse = (status, error, extra = {}, headers = {}) => jsonResponse(status, { error, ...extra }, headers);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------- exported pure helpers ----------

// "Authorization: Bearer <key>" -> key, or null when absent or malformed.
export function licenseKeyFrom(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  return /^[A-Za-z0-9_-]{8,128}$/.test(match[1]) ? match[1] : null;
}

function instanceIdFrom(request) {
  const value = (request.headers.get('x-instance-id') || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

// CORS headers for an allowed Origin; {} for a missing or disallowed one.
export function corsHeaders(origin, env) {
  if (!origin) return {};
  const prefixes = toList(env.ALLOWED_ORIGIN_PREFIXES ?? DEFAULT_CORS_PREFIXES);
  if (!prefixes.some((prefix) => origin.startsWith(prefix))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-instance-id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Quota-Remaining, Retry-After, ETag',
  };
}

// KV keys for the daily and per-minute counters of one license key hash.
export function quotaKeys(keyHash, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return { day: `q:${keyHash}:${day}`, minute: `b:${keyHash}:${Math.floor(now / 60000)}` };
}

// "<left>:<right>,<left>:<right>" -> Map(left -> right). Splits at the last colon; malformed pairs are skipped.
function toPairMap(value) {
  const pairs = new Map();
  for (const part of toList(value)) {
    const split = part.lastIndexOf(':');
    const left = part.slice(0, split).trim();
    const right = part.slice(split + 1).trim();
    if (split > 0 && left && right) pairs.set(left, right);
  }
  return pairs;
}

// ---------- tiers ----------

const DEFAULT_FILL_POLICY_BY_TIER = 'basic:none,pro:default';

// The tier a benefit id maps to through POLAR_TIERS, else null.
const tierForBenefit = (benefitId, env) => toPairMap(env.POLAR_TIERS).get(String(benefitId)) ?? null;

// The x-fill-policy for a tier: FILL_POLICY_BY_TIER, else FILL_POLICY (default "none") for a tier-less key.
function fillPolicyFor(tier, env) {
  const byTier = toPairMap(env.FILL_POLICY_BY_TIER ?? DEFAULT_FILL_POLICY_BY_TIER);
  return (tier && byTier.get(tier)) || String(env.FILL_POLICY ?? 'none');
}

// ---------- license verdicts ----------

// A Polar license key object (validate's body, or activate's `license_key`) that
// Polar answered 200 for. Polar does not report activation usage on validate or
// activate, so activationUsage stays null.
function verdictFromLicenseKey(licenseKey, activationId, now, env) {
  return {
    valid: true,
    status: licenseKey.status ?? null,
    expiresAt: licenseKey.expires_at ?? null,
    activationLimit: licenseKey.limit_activations ?? null,
    activationUsage: null,
    organizationId: licenseKey.organization_id ?? null,
    benefitId: licenseKey.benefit_id ?? null,
    tier: tierForBenefit(licenseKey.benefit_id, env),
    activationId: activationId ?? null,
    checkedAt: now,
  };
}

// A key Polar refused (404). `status` is the matched inactive word, else null.
function invalidVerdict(status, now) {
  return {
    valid: false,
    status,
    expiresAt: null,
    activationLimit: null,
    activationUsage: null,
    organizationId: null,
    benefitId: null,
    tier: null,
    activationId: null,
    checkedAt: now,
  };
}

// The inactive word ("expired", "revoked", "disabled") in a Polar error detail, else null.
const inactiveWordIn = (detail) => {
  const match = INACTIVE_DETAIL.exec(String(detail ?? ''));
  return match ? match[0].toLowerCase() : null;
};

const inactiveResponse = (status) => errorResponse(402, 'license_inactive', { status });

// null when the verdict grants access, else { response, reason }.
function judge(verdict, env, now) {
  const invalid = (reason) => ({ response: errorResponse(401, 'license_invalid'), reason });
  if (!verdict.valid) {
    if (INACTIVE_STATUSES.has(verdict.status)) return { response: inactiveResponse(verdict.status), reason: 'license is ' + verdict.status };
    return invalid('Polar reports the key as not found');
  }
  if (!env.POLAR_ORGANIZATION_ID) return invalid('POLAR_ORGANIZATION_ID is not configured; rejecting every key');
  if (String(verdict.organizationId) !== String(env.POLAR_ORGANIZATION_ID)) return invalid('license belongs to a different organization');
  // POLAR_BENEFIT_IDS is the allow-list; when it is empty the POLAR_TIERS benefit ids are.
  const explicitBenefits = toList(env.POLAR_BENEFIT_IDS);
  const benefits = explicitBenefits.length > 0 ? explicitBenefits : [...toPairMap(env.POLAR_TIERS).keys()];
  if (benefits.length > 0 && !benefits.includes(String(verdict.benefitId))) {
    return invalid(explicitBenefits.length > 0 ? 'benefit not in POLAR_BENEFIT_IDS' : 'benefit not in POLAR_TIERS');
  }
  const expiresAtMs = verdict.expiresAt ? Date.parse(verdict.expiresAt) : NaN;
  const pastExpiry = Number.isFinite(expiresAtMs) && expiresAtMs <= now;
  if (INACTIVE_STATUSES.has(verdict.status) || pastExpiry) {
    const status = INACTIVE_STATUSES.has(verdict.status) ? verdict.status : 'expired';
    return { response: inactiveResponse(status), reason: 'license is ' + status };
  }
  return null;
}

// Polar answered but not usefully: 5xx, rate limited, or not JSON.
const isUnavailable = (result) => result.status >= 500 || result.status === 429 || result.body === null || typeof result.body !== 'object';

// Polar's own Retry-After (its license endpoints allow 3 requests a second) travels with the 503
// so the extension can wait exactly that long instead of guessing.
// Always carries Retry-After: the extension shows a 503 with one as "API busy, retrying in N s"
// and one without as "API unreachable", and a Polar hiccup is the former.
const unavailableResponse = (result) =>
  errorResponse(503, 'license_service_unavailable', {}, { 'Retry-After': String(result && result.retryAfter ? result.retryAfter : 30) });

// Verdicts are held in the isolate's memory ahead of KV (owner 2026-11-07): when KV refused
// writes for a day, nothing was cached, every request went to Polar, Polar's rate limit
// turned every answer into a 503 and the extension read "API unreachable". Memory serves the
// cache window on its own; KV only lets other isolates skip their first Polar call.
const verdictMemory = new Map(); // cacheKey -> verdict
// Second layer (2026-11-07): the colo's edge cache (Cache API), which has no daily write limit,
// so a fresh isolate in the same colo finds the verdict without a Polar call even while KV
// refuses writes. Keyed by a synthetic URL; absent in node (tests) and on error.
const VERDICT_CACHE_URL = 'https://verdicts.sourcery.invalid/';
function edgeCache() {
  try { return typeof caches !== 'undefined' && caches.default ? caches.default : null; } catch (error) { return null; }
}
async function cachedVerdict(env, cacheKey) {
  if (verdictMemory.has(cacheKey)) return verdictMemory.get(cacheKey);
  const cache = edgeCache();
  if (cache) {
    try {
      const hit = await cache.match(VERDICT_CACHE_URL + cacheKey);
      if (hit) { const verdict = await hit.json(); verdictMemory.set(cacheKey, verdict); return verdict; }
    } catch (error) { /* fall through to KV */ }
  }
  const stored = await getJson(env.LICENSES, cacheKey);
  if (stored) verdictMemory.set(cacheKey, stored);
  return stored;
}
async function forgetVerdict(env, cacheKey) {
  verdictMemory.delete(cacheKey);
  const cache = edgeCache();
  if (cache) { try { await cache.delete(VERDICT_CACHE_URL + cacheKey); } catch (error) { /* best effort */ } }
  await deleteKey(env.LICENSES, cacheKey);
}

// Resolves { verdict, ... } for an authed request or { response } to return.
async function authenticate(request, env, deps) {
  const key = licenseKeyFrom(request);
  const instanceId = instanceIdFrom(request);
  if (!key || !instanceId) return { response: errorResponse(401, 'license_required') };

  const now = deps.now();
  const cacheMs = toInt(env.LICENSE_CACHE_SECONDS, 600) * 1000;
  const graceSeconds = toInt(env.LICENSE_GRACE_SECONDS, 86400);
  const keyHash = await sha256Hex(key);
  const licenseHash = await sha256Hex(`${key}|${instanceId}`);
  const cacheKey = 'lic:' + licenseHash;
  const logTag = keyHash.slice(0, 8);

  if (!env.POLAR_ORGANIZATION_ID) {
    deps.log('license_rejected', { key: logTag, reason: 'POLAR_ORGANIZATION_ID is not configured; rejecting every key' });
    return { response: errorResponse(401, 'license_invalid') };
  }

  const cached = await cachedVerdict(env, cacheKey);
  let verdict = cached && now - cached.checkedAt < cacheMs ? cached : null;

  if (!verdict) {
    let result = null;
    try {
      result = await polar.validate(key, instanceId, env, deps.fetch);
    } catch (error) {
      deps.log('license_validate_failed', { key: logTag, error: String(error && error.message) });
    }
    if (!result || isUnavailable(result) || ![200, 400, 404, 422].includes(result.status)) {
      if (cached && cached.valid && now - cached.checkedAt < graceSeconds * 1000) {
        deps.log('license_grace_reuse', { key: logTag });
        verdict = cached;
      } else {
        deps.log('license_service_unavailable', { key: logTag, status: result ? result.status : null });
        return { response: unavailableResponse(result) };
      }
    } else if (result.status === 200) {
      verdict = verdictFromLicenseKey(result.body, result.body.activation?.id, now, env);
      await rememberVerdict(env, cacheKey, verdict, graceSeconds, deps);
    } else if (result.status === 404) {
      const detail = String(result.body.detail ?? '');
      deps.log('license_not_found', { key: logTag, detail });
      verdict = invalidVerdict(inactiveWordIn(detail), now);
      await rememberVerdict(env, cacheKey, verdict, cacheMs / 1000, deps);
    } else {
      // 400 / 422: Polar rejected the request itself. Not an outage and not worth caching.
      deps.log('license_rejected', { key: logTag, reason: 'Polar answered ' + result.status });
      return { response: errorResponse(401, 'license_invalid') };
    }
  }

  const rejection = judge(verdict, env, now);
  if (rejection) {
    deps.log('license_rejected', { key: logTag, reason: rejection.reason });
    return { response: rejection.response };
  }
  return { key, instanceId, keyHash, licenseHash, cacheKey, verdict };
}

// Quota accounting (owner 2026-11-06). The free Workers plan allows 1,000 KV writes a day for
// the whole account, and two writes per priced request used that up mid-scan, after which every
// request died with 500 ("KV put() limit exceeded for the day"). So counts live in the isolate's
// memory: the per-minute burst never touches KV; the day count is read from KV once per isolate
// and written back every QUOTA_FLUSH_EVERY requests, when the limit is first crossed, and when
// the day turns. Counts stay approximate (several isolates each hold their own share), which is
// fine for abuse protection. A KV write that fails is logged and the request still goes through:
// a quota is never the reason a licensed user sees nothing.
const QUOTA_FLUSH_EVERY = 20;
const DAY_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;
const quotaMemory = new Map(); // keyHash -> { dayKey, base, pending, minuteKey, minuteCount }
export function resetQuotaMemory() { quotaMemory.clear(); verdictMemory.clear(); }

async function readCount(kv, key, deps) {
  try {
    const n = Number.parseInt((await kv.get(key)) ?? '0', 10);
    return Number.isFinite(n) ? n : 0;
  } catch (error) {
    deps.log('quota_store_unavailable', { op: 'get', error: String(error && error.message) });
    return 0;
  }
}
async function flushQuota(mem, env, deps) {
  if (!mem.pending) return;
  try {
    // another isolate may have written its share since this one read: build on the larger view
    const stored = await readCount(env.LICENSES, mem.dayKey, deps);
    const next = Math.max(stored, mem.base) + mem.pending;
    await env.LICENSES.put(mem.dayKey, String(next), { expirationTtl: DAY_KEY_TTL_SECONDS });
    mem.base = next;
    mem.pending = 0;
  } catch (error) {
    deps.log('quota_store_unavailable', { op: 'put', error: String(error && error.message) });
  }
}
async function applyQuota(keyHash, env, deps) {
  const now = deps.now();
  const dailyLimit = toInt(env.DAILY_QUOTA, 2000);
  const burstLimit = toInt(env.BURST_PER_MINUTE, 60);
  const keys = quotaKeys(keyHash, now);

  let mem = quotaMemory.get(keyHash);
  if (mem && mem.dayKey !== keys.day) { await flushQuota(mem, env, deps); mem = null; } // yesterday's tail goes to its own key
  if (!mem) {
    mem = { dayKey: keys.day, base: await readCount(env.LICENSES, keys.day, deps), pending: 0, minuteKey: keys.minute, minuteCount: 0 };
    quotaMemory.set(keyHash, mem);
  }
  if (mem.minuteKey !== keys.minute) { mem.minuteKey = keys.minute; mem.minuteCount = 0; }
  mem.minuteCount += 1;
  if (mem.minuteCount > burstLimit) {
    const retryAfter = Math.ceil((Math.floor(now / 60000) * 60000 + 60000 - now) / 1000);
    return { response: errorResponse(429, 'quota_exceeded', { scope: 'minute' }, { 'Retry-After': String(retryAfter) }) };
  }
  mem.pending += 1;
  const dayCount = mem.base + mem.pending;
  if (mem.pending >= QUOTA_FLUSH_EVERY || dayCount === dailyLimit + 1) await flushQuota(mem, env, deps);
  if (dayCount > dailyLimit) {
    const nextMidnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    return { response: errorResponse(429, 'quota_exceeded', { scope: 'day' }, { 'Retry-After': String(Math.ceil((nextMidnight - now) / 1000)) }) };
  }
  return { remaining: Math.max(0, dailyLimit - dayCount) };
}

// A license verdict is cached to spare Polar, not to decide anything: a failed write is logged
// and the request carries on with the verdict it already has.
async function rememberVerdict(env, cacheKey, verdict, ttlSeconds, deps) {
  verdictMemory.set(cacheKey, verdict);
  const cache = edgeCache();
  if (cache) {
    try {
      await cache.put(VERDICT_CACHE_URL + cacheKey, new Response(JSON.stringify(verdict), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + Math.max(60, Math.ceil(ttlSeconds)) } }));
    } catch (error) {
      deps.log('license_edge_cache_unavailable', { error: String(error && error.message) });
    }
  }
  try {
    await putJson(env.LICENSES, cacheKey, verdict, ttlSeconds);
  } catch (error) {
    deps.log('license_cache_unavailable', { error: String(error && error.message) });
  }
}

// ---------- forwarding ----------

const originConfig = (env, name) => {
  const origin = String(env[name + '_ORIGIN'] ?? '').replace(/\/+$/, '');
  const token = String(env[name + '_APP_TOKEN'] ?? '');
  return origin && token ? { origin, token } : null;
};

async function readBodyText(request) {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { tooLarge: true };
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) return { tooLarge: true };
  return { text: new TextDecoder().decode(buffer) };
}

async function forward(request, target, extraHeaders, body, deps) {
  const headers = { ...extraHeaders };
  const accept = request.headers.get('accept');
  if (accept) headers.accept = accept;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let upstream;
  try {
    upstream = await deps.fetch(target, { method: request.method, headers, body });
  } catch (error) {
    deps.log('origin_failed', { error: String(error && error.message) });
    return errorResponse(502, 'origin_unavailable');
  }
  if (upstream.status >= 500) {
    deps.log('origin_error', { status: upstream.status });
    return errorResponse(502, 'origin_unavailable');
  }
  const responseHeaders = {};
  for (const name of ['content-type', 'etag', 'cache-control']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  const hasNoBody = [204, 205, 304].includes(upstream.status);
  return new Response(hasNoBody ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders });
}

// ---------- route handlers ----------

function health(env) {
  return jsonResponse(200, { ok: true, origins: { pricing: Boolean(originConfig(env, 'PRICING')), catalog: Boolean(originConfig(env, 'CATALOG')) } });
}

async function activateRoute(request, env, deps) {
  const body = await readBodyText(request);
  if (body.tooLarge) return errorResponse(413, 'payload_too_large');
  let parsed = null;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    parsed = null;
  }
  const licenseKey = parsed && typeof parsed.licenseKey === 'string' ? parsed.licenseKey.trim() : '';
  const instanceName = parsed && typeof parsed.instanceName === 'string' ? parsed.instanceName.trim() : '';
  if (!licenseKey || !instanceName || licenseKey.length > 128 || instanceName.length > 200) return errorResponse(400, 'invalid_body');

  const now = deps.now();
  const logTag = (await sha256Hex(licenseKey)).slice(0, 8);
  if (!env.POLAR_ORGANIZATION_ID) {
    deps.log('license_activate_rejected', { key: logTag, reason: 'POLAR_ORGANIZATION_ID is not configured; rejecting every key' });
    return errorResponse(401, 'license_invalid');
  }
  let result = null;
  try {
    result = await polar.activate(licenseKey, instanceName, env, deps.fetch);
  } catch (error) {
    deps.log('license_activate_failed', { key: logTag, error: String(error && error.message) });
  }
  if (!result || isUnavailable(result)) return unavailableResponse(result);

  if (result.status !== 200) {
    const detail = String(result.body.detail ?? '');
    deps.log('license_activate_rejected', { key: logTag, reason: 'Polar answered ' + result.status, detail });
    if (result.status === 403) {
      // Polar has no separate code for these; the detail string is the only hint.
      if (/limit/i.test(detail)) return errorResponse(409, 'activation_limit');
      const word = inactiveWordIn(detail);
      if (word) return inactiveResponse(word);
    }
    return errorResponse(401, 'license_invalid');
  }

  const activationId = typeof result.body.id === 'string' ? result.body.id : null;
  const verdict = verdictFromLicenseKey(result.body.license_key || {}, activationId, now, env);
  const rejection = activationId ? judge(verdict, env, now) : { response: errorResponse(401, 'license_invalid'), reason: 'Polar returned no activation id' };
  if (rejection) {
    deps.log('license_activate_rejected', { key: logTag, reason: rejection.reason });
    return rejection.response;
  }
  // Seed the verdict so the first authed request does not need another validate call.
  const cacheKey = 'lic:' + (await sha256Hex(`${licenseKey}|${activationId}`));
  await rememberVerdict(env, cacheKey, verdict, toInt(env.LICENSE_GRACE_SECONDS, 86400), deps);
  return jsonResponse(200, {
    instanceId: activationId,
    status: verdict.status,
    expiresAt: verdict.expiresAt,
    activationLimit: verdict.activationLimit,
    activationUsage: verdict.activationUsage,
    tier: verdict.tier ?? null,
  });
}

async function deactivateRoute(auth, env, deps) {
  let result = null;
  try {
    result = await polar.deactivate(auth.key, auth.instanceId, env, deps.fetch);
  } catch (error) {
    deps.log('license_deactivate_failed', { key: auth.keyHash.slice(0, 8), error: String(error && error.message) });
  }
  if (!result || result.status >= 500 || result.status === 429) return unavailableResponse(result);
  // 204 = deactivated; 404 = the activation is already gone. Either way no verdict should outlive it.
  if (result.status === 204 || result.status === 404) {
    await forgetVerdict(env, auth.cacheKey);
    return jsonResponse(200, { deactivated: true });
  }
  return errorResponse(400, 'deactivation_failed');
}

function licenseRoute(auth) {
  const { verdict } = auth;
  return jsonResponse(200, {
    status: verdict.status,
    expiresAt: verdict.expiresAt,
    activationLimit: verdict.activationLimit,
    activationUsage: verdict.activationUsage,
    benefitId: verdict.benefitId,
    tier: verdict.tier ?? null,
  });
}

async function quoteRoute(request, auth, env, deps) {
  const config = originConfig(env, 'PRICING');
  if (!config) return errorResponse(503, 'origin_not_configured');
  const body = await readBodyText(request);
  if (body.tooLarge) return errorResponse(413, 'payload_too_large');
  let parsed = null;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) return errorResponse(400, 'invalid_body');
  return forward(
    request,
    config.origin + '/v1/prices/quote',
    { 'x-app-token': config.token, 'x-fill-policy': fillPolicyFor(auth.verdict.tier, env) },
    body.text,
    deps,
  );
}

async function catalogRoute(request, url, env, deps) {
  const config = originConfig(env, 'CATALOG');
  if (!config) return errorResponse(503, 'origin_not_configured');
  let body;
  if (request.method === 'POST') {
    const read = await readBodyText(request);
    if (read.tooLarge) return errorResponse(413, 'payload_too_large');
    body = read.text;
  }
  const search = request.method === 'GET' ? url.search : '';
  return forward(request, config.origin + url.pathname + search, { 'x-app-token': config.token }, body, deps);
}

// Each service serves its own games list at /v1/games (owner 2026-11-08); the gateway names
// them apart. The lists change rarely, so a response without its own cache header is kept an hour.
const GAMES_ORIGIN = { '/v1/prices/games': 'PRICING', '/v1/catalog/games': 'CATALOG' };

async function gamesRoute(request, url, env, deps) {
  const config = originConfig(env, GAMES_ORIGIN[url.pathname]);
  if (!config) return errorResponse(503, 'origin_not_configured');
  const response = await forward(request, config.origin + '/v1/games', { 'x-app-token': config.token }, undefined, deps);
  if (response.ok && !response.headers.get('cache-control')) response.headers.set('cache-control', 'private, max-age=3600');
  return response;
}

// ---------- routing ----------

const PRODUCT_PATH = /^\/v1\/products\/\d+$/;

// Returns { methods, auth, run } for a known path, or null.
function matchRoute(pathname) {
  switch (pathname) {
    case '/v1/health':
      return { methods: ['GET'], auth: false, name: 'health' };
    case '/v1/license/activate':
      return { methods: ['POST'], auth: false, name: 'activate' };
    case '/v1/license/deactivate':
      return { methods: ['POST'], auth: true, name: 'deactivate' };
    case '/v1/license':
      return { methods: ['GET'], auth: true, name: 'license' };
    case '/v1/prices/quote':
      return { methods: ['POST'], auth: true, name: 'quote' };
    case '/v1/products:lookup':
      return { methods: ['POST'], auth: true, name: 'catalog' };
    case '/v1/prices/games':
    case '/v1/catalog/games':
      return { methods: ['GET'], auth: true, name: 'games' };
    default:
      return PRODUCT_PATH.test(pathname) ? { methods: ['GET'], auth: true, name: 'catalog' } : null;
  }
}

async function route(request, env, deps) {
  const url = new URL(request.url);
  const matched = matchRoute(url.pathname);
  if (!matched) return errorResponse(404, 'not_found');
  if (!matched.methods.includes(request.method)) {
    return errorResponse(405, 'method_not_allowed', {}, { Allow: matched.methods.join(', ') + ', OPTIONS' });
  }

  if (matched.name === 'health') return health(env);
  if (matched.name === 'activate') return activateRoute(request, env, deps);

  const auth = await authenticate(request, env, deps);
  if (auth.response) return auth.response;
  const quota = await applyQuota(auth.keyHash, env, deps);
  if (quota.response) return quota.response;

  let response;
  switch (matched.name) {
    case 'deactivate':
      response = await deactivateRoute(auth, env, deps);
      break;
    case 'license':
      response = licenseRoute(auth);
      break;
    case 'quote':
      response = await quoteRoute(request, auth, env, deps);
      break;
    case 'games':
      response = await gamesRoute(request, url, env, deps);
      break;
    default:
      response = await catalogRoute(request, url, env, deps);
  }
  response.headers.set('X-Quota-Remaining', String(quota.remaining));
  return response;
}

// deps: { fetch, now, log } are injectable for tests.
export async function handle(request, env, deps = {}) {
  const resolved = {
    // The runtime fetch must not be called as a method of this object (Workers throws
    // "Illegal invocation" when `this` is not the global), so wrap it instead of storing it.
    fetch: deps.fetch || ((url, init) => fetch(url, init)),
    now: deps.now || Date.now,
    log: deps.log || ((event, fields) => console.log(JSON.stringify({ event, ...fields }))),
  };
  const cors = corsHeaders(request.headers.get('origin'), env);

  let response;
  if (request.method === 'OPTIONS') {
    response = new Response(null, { status: 204 });
  } else {
    try {
      response = await route(request, env, resolved);
    } catch (error) {
      resolved.log('unhandled_error', { error: String(error && error.message) });
      response = errorResponse(500, 'internal_error');
    }
  }
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  return response;
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, {});
  },
};
