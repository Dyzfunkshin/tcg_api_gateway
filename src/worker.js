// TCG API gateway: the single front door to the private pricing and catalog services.
//
// Every request runs one pipeline (docs/PLAN.md section 6.1): match the route (404/405
// before any auth work), identify the client from its credential, check the client's
// policy allows the route, enforce its quota, then forward to the service with the
// service's own token and a policy-chosen x-fill-policy. Routes live in ./routes.js,
// client policies in ./clients.js, the Polar contract in ./polar.js.
import { getJson, putJson, deleteKey } from './kv.js';
import * as polar from './polar.js';
import { matchPath } from './routes.js';
import { DEFAULT_CLIENTS, isOpenRoute, originMatches } from './clients.js';
import { issueSessionToken, readSessionToken, verifyTurnstile } from './session.js';
import { cacheUrlForGet, cacheUrlForQuoteItem, cacheGet, cachePut, headersOf } from './edge-cache.js';

const MAX_BODY_BYTES = 1024 * 1024;
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

// Every Origin entry any client is allowed (CORS is decided before the caller is known:
// a preflight carries no credential). Entries match per clients.originMatches.
export const corsOriginsOf = (clients) =>
  [...new Set([clients.anonymous, clients.license, ...clients.appKeys, ...(clients.publicSessions ?? [])].flatMap((c) => c.origins))];

// CORS headers for an allowed Origin; {} for a missing or disallowed one.
export function corsHeaders(origin, allowedOrigins) {
  if (!origin) return {};
  if (!allowedOrigins.some((entry) => originMatches(origin, entry))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-instance-id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Quota-Remaining, Retry-After, ETag, X-Gateway-Cache',
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
const verdictMemory = new Map(); // cacheKey -> verdict, bounded (oldest evicted first)
const VERDICT_MEMORY_MAX_ENTRIES = 1000;
function memoryRememberVerdict(cacheKey, verdict) {
  verdictMemory.delete(cacheKey); // re-insert so the entry counts as newest
  verdictMemory.set(cacheKey, verdict);
  while (verdictMemory.size > VERDICT_MEMORY_MAX_ENTRIES) verdictMemory.delete(verdictMemory.keys().next().value);
}

// Per-IP cap on licence checks that could reach Polar or KV (a flood of random keys).
// Returns a 429 response when over the limit, else null. Binding absent = allowed;
// a binding error fails open (bindingAllows logs it).
async function licenseAttemptBlocked(ip, logTag, env, deps) {
  const allowed = await bindingAllows(env, 'RATE_LIMIT_LICENSE_ATTEMPTS', 'ip:' + ip, deps);
  if (allowed !== false) return null;
  deps.log('license_attempts_limited', { ip, key: logTag });
  return errorResponse(429, 'license_attempts_exceeded', {}, { 'Retry-After': '60' });
}
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
      if (hit) { const verdict = await hit.json(); memoryRememberVerdict(cacheKey, verdict); return verdict; }
    } catch (error) { /* fall through to KV */ }
  }
  const stored = await getJson(env.LICENSES, cacheKey);
  if (stored) memoryRememberVerdict(cacheKey, stored);
  return stored;
}
async function forgetVerdict(env, cacheKey) {
  verdictMemory.delete(cacheKey);
  const cache = edgeCache();
  if (cache) { try { await cache.delete(VERDICT_CACHE_URL + cacheKey); } catch (error) { /* best effort */ } }
  await deleteKey(env.LICENSES, cacheKey);
}

// Resolves { verdict, ... } for a valid licence or { response } to return.
async function authenticateLicense(key, instanceId, ip, env, deps) {
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

  // A verdict still fresh in this isolate's memory costs nothing. Anything else may reach the
  // edge cache, KV and Polar, so it spends one per-IP attempt first (flood guard).
  const inMemory = verdictMemory.get(cacheKey);
  if (!(inMemory && now - inMemory.checkedAt < cacheMs)) {
    const blocked = await licenseAttemptBlocked(ip, logTag, env, deps);
    if (blocked) return { response: blocked };
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
      // Not-found verdicts stay in isolate memory only: a random key must never cost a KV write.
      memoryRememberVerdict(cacheKey, verdict);
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
// The per-minute verdict from a Workers rate-limiting binding: true (allowed), false
// (over), or null when the binding is not configured. A binding error fails open: a
// rate limiter is never the reason a legitimate caller sees nothing.
async function bindingAllows(env, bindingName, key, deps) {
  const binding = bindingName ? env[bindingName] : null;
  if (!binding || typeof binding.limit !== 'function') return null;
  try {
    const { success } = await binding.limit({ key });
    return Boolean(success);
  } catch (error) {
    deps.log('rate_limiter_unavailable', { binding: bindingName, error: String(error && error.message) });
    return true;
  }
}

// Logs the refusal (rate_limited) and builds the 429. `limiter` is the binding name, or 'memory'.
// `subject` is already safe to log: an ip, an app id, or a licence key hash prefix.
function minuteExceeded(now, retryAfterSeconds, deps, context) {
  deps.log('rate_limited', { client: context.client, route: context.route, limiter: context.limiter, subjectKind: context.subjectKind, subject: context.subject, ip: context.ip });
  return minuteResponse(now, retryAfterSeconds);
}
const minuteResponse = (now, retryAfterSeconds) =>
  errorResponse(429, 'quota_exceeded', { scope: 'minute' }, { 'Retry-After': String(retryAfterSeconds ?? Math.ceil((Math.floor(now / 60000) * 60000 + 60000 - now) / 1000)) });

// The quota limits for a client: its policy, with the licence client's overridable by
// DAILY_QUOTA / BURST_PER_MINUTE (the vars sourcery-gateway already used).
function quotaLimitsFor(client, env) {
  const { daily, perMinute, perMinuteBinding } = client.quota;
  if (client.auth !== 'license') return { daily, perMinute, perMinuteBinding };
  return { daily: toInt(env.DAILY_QUOTA, daily), perMinute: toInt(env.BURST_PER_MINUTE, perMinute), perMinuteBinding };
}

// Per-minute limits come from the client's rate-limiting binding (PLAN.md 6.1 step 4);
// without one (local dev, tests) an in-isolate counter stands in. Daily limits are KV
// counters, buffered in memory. `subject` is what the quota is keyed on: the licence
// key hash, or "app:<client id>".
async function applyQuota(subject, limits, env, deps, context = {}) {
  const now = deps.now();
  const dailyLimit = limits.daily;
  const keys = quotaKeys(subject, now);

  let mem = quotaMemory.get(subject);
  if (mem && mem.dayKey !== keys.day) { await flushQuota(mem, env, deps); mem = null; } // yesterday's tail goes to its own key
  if (!mem) {
    mem = { dayKey: keys.day, base: await readCount(env.LICENSES, keys.day, deps), pending: 0, minuteKey: keys.minute, minuteCount: 0 };
    quotaMemory.set(subject, mem);
  }
  const allowed = await bindingAllows(env, limits.perMinuteBinding, subject, deps);
  if (allowed === false) return { response: minuteExceeded(now, 60, deps, { ...context, limiter: limits.perMinuteBinding }) };
  if (allowed === null && limits.perMinute !== null) {
    if (mem.minuteKey !== keys.minute) { mem.minuteKey = keys.minute; mem.minuteCount = 0; }
    mem.minuteCount += 1;
    if (mem.minuteCount > limits.perMinute) return { response: minuteExceeded(now, undefined, deps, { ...context, limiter: 'memory' }) };
  }
  mem.pending += 1;
  const dayCount = mem.base + mem.pending;
  if (mem.pending >= QUOTA_FLUSH_EVERY || dayCount === dailyLimit + 1) await flushQuota(mem, env, deps);
  if (dayCount > dailyLimit) {
    deps.log('quota_exceeded', { client: context.client, route: context.route, subjectKind: context.subjectKind, subject: context.subject, ip: context.ip });
    const nextMidnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    return { response: errorResponse(429, 'quota_exceeded', { scope: 'day' }, { 'Retry-After': String(Math.ceil((nextMidnight - now) / 1000)) }) };
  }
  return { remaining: Math.max(0, dailyLimit - dayCount) };
}

// A license verdict is cached to spare Polar, not to decide anything: a failed write is logged
// and the request carries on with the verdict it already has.
async function rememberVerdict(env, cacheKey, verdict, ttlSeconds, deps) {
  memoryRememberVerdict(cacheKey, verdict);
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

// The Cloudflare Access service-token headers every forwarded request carries once the
// origins are locked (PLAN.md section 4, step G4). Both secrets unset = no headers (before
// the lock); exactly one set is a misconfiguration and returns null, so the request fails
// loudly here instead of as an Access denial at the origin.
function accessHeaders(env) {
  const id = String(env.ACCESS_CLIENT_ID ?? '');
  const secret = String(env.ACCESS_CLIENT_SECRET ?? '');
  if (!id && !secret) return {};
  if (!id || !secret) return null;
  return { 'cf-access-client-id': id, 'cf-access-client-secret': secret };
}

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
  // GETs are streamed through (a catalog artifact is ~50 MB: never held whole in the isolate).
  // Other methods stay buffered: their bodies are small JSON that callers parse.
  const streams = request.method === 'GET' && !hasNoBody;
  const responseBody = hasNoBody ? null : streams ? upstream.body : await upstream.arrayBuffer();
  return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
}

// ---------- route handlers ----------

function health(env) {
  return jsonResponse(200, { ok: true, origins: { pricing: Boolean(originConfig(env, 'PRICING')), catalog: Boolean(originConfig(env, 'CATALOG')) } });
}

async function activateRoute(request, env, deps) {
  const body = await readBodyText(request);
  if (body.tooLarge) {
    deps.log('request_rejected', { reason: 'payload_too_large', route: 'gateway:license.activate', client: deps.clients.anonymous.id, ip: callerIp(request) });
    return errorResponse(413, 'payload_too_large');
  }
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
  const blocked = await licenseAttemptBlocked(callerIp(request), logTag, env, deps);
  if (blocked) return blocked;
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

// The x-fill-policy a client's requests to pricing carry. Never the client's own header.
function fillPolicyOf(caller, env) {
  if (caller.client.fillPolicy === 'by-license-tier') return fillPolicyFor(caller.license.verdict.tier, env);
  return caller.client.fillPolicy;
}

// The games lists change rarely, so a response without its own cache header is kept an hour.
const DEFAULT_CACHE_CONTROL = { 'pricing:games': 'private, max-age=3600' };

// Forwards an allowed service route: path verbatim, query string preserved, only the
// gateway's own headers added (PLAN.md 6.1 steps 6-7).
async function serviceRoute(request, url, route, upstreamPath, caller, env, deps) {
  const config = originConfig(env, route.service.toUpperCase());
  if (!config) return errorResponse(503, 'origin_not_configured');

  let body;
  if (request.method === 'POST') {
    const read = await readBodyText(request);
    if (read.tooLarge) {
      deps.log('request_rejected', { reason: 'payload_too_large', route: route.id, client: caller.client.id, ip: callerIp(request) });
      return errorResponse(413, 'payload_too_large');
    }
    body = read.text;
  }
  let quoteItems = null;
  if (route.id === 'pricing:quote') {
    try {
      quoteItems = JSON.parse(body);
    } catch {
      quoteItems = null;
    }
    if (!Array.isArray(quoteItems)) return errorResponse(400, 'invalid_body');
    const max = caller.client.maxQuoteItems;
    if (max !== null && quoteItems.length > max) {
      deps.log('request_rejected', { reason: 'batch_too_large', route: route.id, client: caller.client.id, count: quoteItems.length, max, ip: callerIp(request) });
      return errorResponse(413, 'batch_too_large', { max });
    }
  }

  const access = accessHeaders(env);
  if (!access) {
    deps.log('access_misconfigured', { reason: 'only one of ACCESS_CLIENT_ID / ACCESS_CLIENT_SECRET is set' });
    return errorResponse(503, 'origin_not_configured');
  }
  const headers = { ...access, 'x-app-token': config.token };
  if (route.service === 'pricing') headers['x-fill-policy'] = fillPolicyOf(caller, env);
  const target = config.origin + upstreamPath + url.search;

  // 5. Edge cache, for policies that allow it on this route (PLAN.md 6.3 point 5).
  const ttlSeconds = caller.client.cache ? caller.client.cache[route.id] : undefined;
  if (ttlSeconds && quoteItems) return cachedQuote(request, target, headers, quoteItems, ttlSeconds, deps);
  if (ttlSeconds && request.method === 'GET') return cachedGet(request, target, headers, cacheUrlForGet(route.service, upstreamPath, url.search), ttlSeconds, deps);

  const response = await forward(request, target, headers, body, deps);
  const fallbackCacheControl = DEFAULT_CACHE_CONTROL[route.id];
  if (fallbackCacheControl && response.ok && !response.headers.get('cache-control')) response.headers.set('cache-control', fallbackCacheControl);
  return response;
}

// A GET answered from the edge cache, or forwarded and (on a 200) stored for ttlSeconds.
async function cachedGet(request, target, headers, cacheUrl, ttlSeconds, deps) {
  const hit = await cacheGet(deps.cache, cacheUrl, deps.log);
  if (hit) {
    return new Response(hit.body, { status: 200, headers: { ...headersOf(hit), 'cache-control': `public, max-age=${ttlSeconds}`, 'x-gateway-cache': 'hit' } });
  }
  const response = await forward(request, target, headers, undefined, deps);
  if (response.status !== 200) return response;
  const kept = headersOf(response);
  // One branch to the client, one to the cache. The write is handed to waitUntil, not awaited:
  // an unread tee branch would otherwise buffer the whole body in memory.
  const [toClient, toCache] = response.body ? response.body.tee() : [null, null];
  if (toCache) deps.waitUntil(cachePut(deps.cache, cacheUrl, toCache, kept, ttlSeconds, deps.log));
  return new Response(toClient, { status: 200, headers: { ...kept, 'cache-control': `public, max-age=${ttlSeconds}`, 'x-gateway-cache': 'miss' } });
}

// A quote batch split per item: cached items are answered from the edge, only the misses
// go to pricing (in order), and the answers are merged back into request order. Relies on
// pricing's contract that `data` has the same order and length as the request.
async function cachedQuote(request, target, headers, items, ttlSeconds, deps) {
  const cacheUrls = items.map(cacheUrlForQuoteItem);
  const answers = await Promise.all(
    cacheUrls.map(async (cacheUrl) => {
      if (!cacheUrl) return undefined;
      const hit = await cacheGet(deps.cache, cacheUrl, deps.log);
      if (!hit) return undefined;
      try {
        return await hit.json();
      } catch {
        return undefined;
      }
    }),
  );
  const missIndexes = answers.flatMap((answer, index) => (answer === undefined ? [index] : []));
  const respond = (state) => jsonResponse(200, { data: answers }, { 'cache-control': 'no-store', 'x-gateway-cache': state });
  if (missIndexes.length === 0) return respond(items.length === 0 ? 'miss' : 'hit');

  const upstream = await forward(request, target, headers, JSON.stringify(missIndexes.map((index) => items[index])), deps);
  if (upstream.status !== 200) return upstream;
  let data = null;
  try {
    data = (await upstream.json()).data;
  } catch {
    data = null;
  }
  if (!Array.isArray(data) || data.length !== missIndexes.length) {
    deps.log('quote_shape_mismatch', { sent: missIndexes.length, got: Array.isArray(data) ? data.length : null });
    return errorResponse(502, 'origin_unavailable');
  }
  await Promise.all(
    missIndexes.map((index, position) => {
      answers[index] = data[position];
      const cacheUrl = cacheUrls[index];
      return cacheUrl ? cachePut(deps.cache, cacheUrl, JSON.stringify(data[position]), { 'content-type': 'application/json' }, ttlSeconds, deps.log) : null;
    }),
  );
  return respond(missIndexes.length === items.length ? 'miss' : 'partial');
}

// ---------- public sessions ----------

const DEFAULT_SESSION_TTL_SECONDS = 1800;

// POST /v1/session: exchanges a Turnstile widget token for a session token (PLAN.md 6.3).
// The Origin must be exactly one of a public client's origins, and Turnstile must report
// that origin's hostname.
async function sessionRoute(request, env, deps) {
  const origin = request.headers.get('origin') || '';
  const client = (deps.clients.publicSessions ?? []).find((c) => c.origins.includes(origin));
  if (!client) {
    deps.log('session_refused', { reason: 'origin_not_allowed', origin: origin.slice(0, 200), ip: callerIp(request) });
    return errorResponse(403, 'origin_not_allowed');
  }
  if (!env.TURNSTILE_SECRET_KEY || !env.SESSION_SIGNING_KEY) {
    deps.log('session_not_configured', { missing: [!env.TURNSTILE_SECRET_KEY && 'TURNSTILE_SECRET_KEY', !env.SESSION_SIGNING_KEY && 'SESSION_SIGNING_KEY'].filter(Boolean) });
    return errorResponse(503, 'session_not_configured');
  }
  const read = await readBodyText(request);
  if (read.tooLarge) {
    deps.log('request_rejected', { reason: 'payload_too_large', route: 'gateway:session', client: client.id, ip: callerIp(request) });
    return errorResponse(413, 'payload_too_large');
  }
  let widgetToken = null;
  try {
    widgetToken = JSON.parse(read.text).turnstileToken;
  } catch {
    widgetToken = null;
  }
  if (typeof widgetToken !== 'string' || widgetToken.length < 1 || widgetToken.length > 2048) {
    deps.log('session_refused', { client: client.id, reason: 'bad body', ip: callerIp(request) });
    return errorResponse(400, 'invalid_body');
  }

  const verdict = await verifyTurnstile(widgetToken, request.headers.get('cf-connecting-ip'), env.TURNSTILE_SECRET_KEY, deps.fetch);
  if (verdict.unavailable) return errorResponse(503, 'turnstile_unavailable', {}, { 'Retry-After': '5' });
  if (!verdict.ok) {
    deps.log('session_refused', { client: client.id, reason: 'turnstile', errorCodes: verdict.errorCodes, ip: callerIp(request) });
    return errorResponse(403, 'turnstile_failed');
  }
  if (verdict.hostname !== new URL(origin).hostname) {
    deps.log('session_refused', { client: client.id, reason: 'hostname', hostname: verdict.hostname, ip: callerIp(request) });
    return errorResponse(403, 'turnstile_failed');
  }
  // a token from our widget used for another purpose on the site must not buy a session
  if (verdict.action !== client.turnstileAction) {
    deps.log('session_refused', { client: client.id, reason: 'action mismatch', action: verdict.action, ip: callerIp(request) });
    return errorResponse(403, 'turnstile_failed');
  }
  const ttlSeconds = toInt(env.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS) || DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = deps.now() + ttlSeconds * 1000;
  const token = await issueSessionToken({ clientId: client.id, origin, expiresAt }, env.SESSION_SIGNING_KEY);
  return jsonResponse(200, { token, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds }, { 'cache-control': 'no-store' });
}

// "Authorization: Session <token>" -> { client, subject } or { response }. The token must
// be correctly signed, unexpired, name a public client, and be used from its own Origin.
async function identifySession(token, request, env, deps) {
  const invalid = (reason) => {
    deps.log('session_invalid', { reason, ip: callerIp(request) });
    return { response: errorResponse(401, 'session_invalid') };
  };
  if (!env.SESSION_SIGNING_KEY) return invalid('SESSION_SIGNING_KEY is not configured');
  const session = await readSessionToken(token, env.SESSION_SIGNING_KEY);
  if (!session) return invalid('bad signature or format');
  if (session.expiresAt <= deps.now()) {
    deps.log('session_expired', { client: session.clientId, ip: callerIp(request) });
    return { response: errorResponse(401, 'session_expired') };
  }
  const client = (deps.clients.publicSessions ?? []).find((c) => c.id === session.clientId);
  if (!client) return invalid('unknown client ' + session.clientId);
  const origin = request.headers.get('origin');
  if (origin !== session.origin || !client.origins.includes(origin)) return invalid('origin mismatch');
  return { client, subject: null };
}

// ---------- callers ----------

// Identifies the caller (PLAN.md 6.1 step 2): { client, license?, subject } or { response }.
// No Authorization header at all is the anonymous client. Any credential that is present
// but invalid is refused here and never falls back to anonymous.
async function identifyCaller(request, env, deps) {
  const { clients } = deps;
  const header = (request.headers.get('authorization') || '').trim();
  if (!header) return { client: clients.anonymous, subject: null };
  const session = /^Session\s+(\S+)$/i.exec(header);
  if (session) return identifySession(session[1], request, env, deps);
  const credentialInvalid = (reason) => {
    deps.log('credential_invalid', { reason, ip: callerIp(request) });
    return { response: errorResponse(401, 'credential_invalid') };
  };
  if (!/^Bearer\s/i.test(header)) return credentialInvalid('unsupported scheme');
  const key = licenseKeyFrom(request);
  if (!key) return credentialInvalid('malformed bearer value');

  // 1. App keys first: an exact hash match. A licence key never matches an app-key hash.
  const keyHash = await sha256Hex(key);
  const app = clients.appKeys.find((client) => client.keySha256 === keyHash);
  if (app) return { client: app, subject: 'app:' + app.id };

  // 2. Otherwise a licence, which needs its activation id. 3. Otherwise 401.
  const instanceId = instanceIdFrom(request);
  if (!instanceId) {
    deps.log('credential_invalid', { reason: 'license_required: missing or malformed X-Instance-Id', key: keyHash.slice(0, 8), ip: callerIp(request) });
    return { response: errorResponse(401, 'license_required') };
  }
  const license = await authenticateLicense(key, instanceId, callerIp(request), env, deps);
  if (license.response) return { response: license.response };
  return { client: clients.license, license, subject: license.keyHash };
}

const callerIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

// ---------- routing ----------

async function route(request, env, deps) {
  const url = new URL(request.url);
  // 1. Match the route: 404 / 405 before any auth work.
  const matched = matchPath(url.pathname);
  if (!matched) return errorResponse(404, 'not_found');
  const route = matched.routes.find((r) => r.method === request.method);
  if (!route) {
    const methods = [...new Set(matched.routes.map((r) => r.method))];
    return errorResponse(405, 'method_not_allowed', {}, { Allow: methods.join(', ') + ', OPTIONS' });
  }

  // 2. Identify the client.
  const caller = await identifyCaller(request, env, deps);
  if (caller.response) return caller.response;
  const { client } = caller;
  if (matched.aliasOf) deps.log('legacy_alias', { path: matched.aliasOf, route: route.id, client: client.id });

  // 3. The client's policy must allow the route. Open routes are allowed to everyone.
  if (!isOpenRoute(route.id) && !client.routes.includes(route.id)) {
    if (client.auth === 'none') {
      deps.log('credential_invalid', { reason: 'credential_required', route: route.id, client: client.id, ip: callerIp(request) });
      return errorResponse(401, 'credential_required');
    }
    deps.log('route_forbidden', { route: route.id, client: client.id });
    return errorResponse(403, 'forbidden');
  }

  // 4. Quota. Anonymous and public-session callers are limited per IP (binding only);
  // licences and app keys per credential, with a daily KV quota.
  let quota = null;
  if (client.auth === 'none' || client.auth === 'public-session') {
    const allowed = await bindingAllows(env, client.quota.perMinuteBinding, 'ip:' + callerIp(request), deps);
    if (allowed === false) return minuteExceeded(deps.now(), 60, deps, { client: client.id, route: route.id, limiter: client.quota.perMinuteBinding, subjectKind: 'ip', subject: callerIp(request), ip: callerIp(request) });
  } else {
    const isApp = String(caller.subject).startsWith('app:');
    quota = await applyQuota(caller.subject, quotaLimitsFor(client, env), env, deps, {
      client: client.id, route: route.id, ip: callerIp(request),
      subjectKind: isApp ? 'app' : 'license',
      subject: isApp ? String(caller.subject).slice(4) : String(caller.subject).slice(0, 8),
    });
    if (quota.response) return quota.response;
  }

  // 5-7. Answer, or serve from the edge cache / forward (serviceRoute).
  let response;
  switch (route.id) {
    case 'gateway:health':
      response = health(env);
      break;
    case 'gateway:session':
      response = await sessionRoute(request, env, deps);
      break;
    case 'gateway:license.activate':
      response = await activateRoute(request, env, deps);
      break;
    case 'gateway:license.deactivate':
      response = await deactivateRoute(caller.license, env, deps);
      break;
    case 'gateway:license':
      response = licenseRoute(caller.license);
      break;
    default:
      response = await serviceRoute(request, url, route, matched.upstreamPath, caller, env, deps);
  }
  if (quota) response.headers.set('X-Quota-Remaining', String(quota.remaining));
  return response;
}

// deps: { fetch, now, log, clients, cache } are injectable for tests.
export async function handle(request, env, deps = {}) {
  const resolved = {
    // The runtime fetch must not be called as a method of this object (Workers throws
    // "Illegal invocation" when `this` is not the global), so wrap it instead of storing it.
    fetch: deps.fetch || ((url, init) => fetch(url, init)),
    now: deps.now || Date.now,
    log: deps.log || ((event, fields) => console.log(JSON.stringify({ event, ...fields }))),
    clients: deps.clients || DEFAULT_CLIENTS,
    cache: deps.cache !== undefined ? deps.cache : edgeCache(),
    // Background work that outlives the response (cache writes). Errors are logged, never thrown.
    waitUntil: deps.waitUntil || ((promise) => { Promise.resolve(promise).catch((error) => (deps.log || console.log)('background_failed', { error: String(error && error.message) })); }),
  };
  const cors = corsHeaders(request.headers.get('origin'), corsOriginsOf(resolved.clients));

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
    return handle(request, env, ctx && typeof ctx.waitUntil === 'function' ? { waitUntil: ctx.waitUntil.bind(ctx) } : {});
  },
};
