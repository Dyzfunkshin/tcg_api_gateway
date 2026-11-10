// Sourcery gateway tests. Plain node:assert, no dependencies.
// Run: node gateway/test/run.js   (exits non-zero on any failure)
import assert from 'node:assert/strict';
import { handle, licenseKeyFrom, corsHeaders, corsOriginsOf, quotaKeys, resetQuotaMemory, ipLimiterKey } from '../src/worker.js';
import { DEFAULT_CLIENTS, LICENSE_CLIENT, ANONYMOUS_CLIENT, assertValidClients } from '../src/clients.js';
import { matchPath } from '../src/routes.js';

let checkCount = 0;
const eq = (actual, expected, message) => {
  checkCount += 1;
  assert.deepEqual(actual, expected, message);
};
const ok = (value, message) => {
  checkCount += 1;
  assert.ok(value, message);
};

const ORG_ID = 'org-111';
const BENEFIT_ID = 'benefit-222';
const KEY = '38b1460a-5104-4067-a91d-77b872934d51';
const INSTANCE = 'f90ec370-fd83-46a5-8bbd-44a241e78665';
const T0 = Date.UTC(2026, 10, 5, 12, 0, 30); // 2026-11-05 12:00:30 UTC
const POLAR_HOST = 'https://api.polar.sh';
const SANDBOX_HOST = 'https://sandbox-api.polar.sh';
const POLAR_PATH = '/v1/customer-portal/license-keys/';
const PRICING = 'https://pricing.test';
const CATALOG = 'https://catalog.test';
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop';

// ---------- fakes ----------

function createFakeKv(clock) {
  const store = new Map();
  const ttls = new Map();
  return {
    store,
    ttls,
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= clock.t) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options = {}) {
      const ttl = options.expirationTtl;
      ttls.set(key, ttl);
      store.set(key, { value: String(value), expiresAt: ttl ? clock.t + ttl * 1000 : null });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// The license key object Polar returns from validate (top level) and activate (`license_key`).
function licenseKeyBody(overrides = {}) {
  const o = { status: 'granted', organizationId: ORG_ID, benefitId: BENEFIT_ID, expiresAt: null, limit: 3, ...overrides };
  return {
    id: 'lk-1',
    organization_id: o.organizationId,
    customer_id: 'cust-1',
    benefit_id: o.benefitId,
    key: KEY,
    display_key: '****-d51',
    status: o.status,
    limit_activations: o.limit,
    usage: 0,
    limit_usage: null,
    validations: 4,
    last_validated_at: null,
    expires_at: o.expiresAt,
  };
}

function validateBody(overrides = {}) {
  return { ...licenseKeyBody(overrides), activation: { id: INSTANCE, label: 'laptop' } };
}

function activateBody(overrides = {}) {
  return {
    id: INSTANCE,
    license_key_id: 'lk-1',
    label: 'laptop',
    meta: {},
    created_at: '2026-11-05T12:00:00Z',
    modified_at: null,
    license_key: licenseKeyBody(overrides),
  };
}

const notFound = (detail) => ({ error: 'ResourceNotFound', detail });
const notPermitted = (detail) => ({ error: 'NotPermitted', detail });

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function createWorld(envOverrides = {}) {
  resetQuotaMemory(); // each world is a fresh isolate
  const clock = { t: T0 };
  const kv = createFakeKv(clock);
  const calls = [];
  const responders = {
    validate: () => jsonResponse(validateBody()),
    activate: () => jsonResponse(activateBody()),
    deactivate: () => new Response(null, { status: 204 }),
    pricing: () => jsonResponse([{ ok: 1 }], 200, { etag: '"abc"', 'cache-control': 'max-age=60', 'x-secret-origin': 'leak' }),
    catalog: () => jsonResponse({ product: 1 }, 200, { etag: '"cat"' }),
  };
  const fetchImpl = async (url, init = {}) => {
    const headers = {};
    for (const [k, v] of new Headers(init.headers || {})) headers[k] = v;
    const call = { url: String(url), method: init.method || 'GET', headers, body: init.body === undefined ? undefined : String(init.body) };
    calls.push(call);
    for (const host of [POLAR_HOST, SANDBOX_HOST]) {
      if (call.url.startsWith(host + POLAR_PATH)) return responders[call.url.slice((host + POLAR_PATH).length)](call);
    }
    if (call.url.startsWith(PRICING)) return responders.pricing(call);
    if (call.url.startsWith(CATALOG)) return responders.catalog(call);
    throw new Error('unexpected fetch ' + call.url);
  };
  const env = {
    LICENSES: kv,
    POLAR_ORGANIZATION_ID: ORG_ID,
    POLAR_BENEFIT_IDS: '',
    PRICING_ORIGIN: PRICING,
    PRICING_APP_TOKEN: 'pricing-secret',
    CATALOG_ORIGIN: CATALOG,
    CATALOG_APP_TOKEN: 'catalog-secret',
    FILL_POLICY: 'none',
    DAILY_QUOTA: '2000',
    BURST_PER_MINUTE: '60',
    LICENSE_CACHE_SECONDS: '600',
    LICENSE_GRACE_SECONDS: '86400',
    ...envOverrides,
  };
  const logs = [];
  const pending = []; // waitUntil promises: the runtime would keep the isolate alive for them
  const deps = { fetch: fetchImpl, now: () => clock.t, log: (...args) => logs.push(args), waitUntil: (promise) => pending.push(promise) };
  const send = async (path, options = {}) => {
    const res = await handle(makeRequest(path, options), env, deps);
    await Promise.all(pending.splice(0)); // background cache writes finish before the next call
    return res;
  };
  const polarCalls = (action) => calls.filter((c) => c.url === POLAR_HOST + POLAR_PATH + action);
  return { clock, kv, calls, responders, env, deps, logs, send, polarCalls };
}

function makeRequest(path, { method = 'GET', key = KEY, instance = INSTANCE, body, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h.authorization = 'Bearer ' + key;
  if (instance) h['x-instance-id'] = instance;
  if (origin) h.origin = origin;
  const init = { method, headers: h };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://gateway.test' + path, init);
}

const readJson = (response) => response.json();

// ---------- tests ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('health: ok without auth and reports configured origins, no upstream call', async () => {
  const w = createWorld({ CATALOG_ORIGIN: '' });
  const res = await w.send('/v1/health', { key: null, instance: null });
  eq(res.status, 200);
  eq(await readJson(res), { ok: true, origins: { pricing: true, catalog: false } });
  eq(w.calls.length, 0);
});

test('auth: 401 without key (credential_required), malformed header (credential_invalid), or missing instance (license_required)', async () => {
  const w = createWorld();
  let res = await w.send('/v1/license', { key: null });
  eq(res.status, 401);
  eq(await readJson(res), { error: 'credential_required' });
  res = await w.send('/v1/license', { key: null, headers: { authorization: 'Basic abc' } });
  eq(res.status, 401);
  eq(await readJson(res), { error: 'credential_invalid' });
  res = await w.send('/v1/license', { key: null, headers: { authorization: 'Bearer ' } });
  eq(res.status, 401);
  eq(await readJson(res), { error: 'credential_invalid' });
  res = await w.send('/v1/license', { instance: null });
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_required' });
  eq(w.calls.length, 0);
});

// Security log events: the structured events (name + fields) a deny decision emits.
function eventsNamed(world, name) {
  return world.logs.filter(([event]) => event === name).map(([, fields]) => fields);
}

test('log credential_invalid: unsupported scheme, malformed bearer, missing instance and anonymous-on-protected each log once', async () => {
  const w = createWorld();
  const ip = { 'cf-connecting-ip': '9.9.9.9' };
  await w.send('/v1/license', { key: null, headers: { authorization: 'Basic abc-secret-basic', ...ip } });
  let events = eventsNamed(w, 'credential_invalid');
  eq([events.length, events[0].reason, events[0].ip], [1, 'unsupported scheme', '9.9.9.9']);
  await w.send('/v1/license', { key: null, headers: { authorization: 'Bearer short', ...ip } });
  events = eventsNamed(w, 'credential_invalid');
  eq([events.length, events[1].reason], [2, 'malformed bearer value']);
  await w.send('/v1/license', { instance: null, headers: ip });
  events = eventsNamed(w, 'credential_invalid');
  eq(events.length, 3);
  ok(events[2].reason.startsWith('license_required'));
  eq(events[2].key.length, 8, 'a licence key is logged as its 8-char hash prefix only');
  await w.send('/v1/license', { key: null, instance: null, headers: ip });
  events = eventsNamed(w, 'credential_invalid');
  eq([events.length, events[3].reason, events[3].client], [4, 'credential_required', 'anonymous']);
  // allow case: a valid request logs no credential_invalid
  const good = createWorld();
  eq((await good.send('/v1/license')).status, 200);
  eq(eventsNamed(good, 'credential_invalid').length, 0);
});

test('licenseKeyFrom parses bearer keys only', async () => {
  const r = (value) => new Request('https://x.test/', { headers: value ? { authorization: value } : {} });
  eq(licenseKeyFrom(r('Bearer ' + KEY)), KEY);
  eq(licenseKeyFrom(r('bearer ' + KEY)), KEY);
  eq(licenseKeyFrom(r('Basic ' + KEY)), null);
  eq(licenseKeyFrom(r('Bearer a b c d e f g h')), null);
  eq(licenseKeyFrom(r(null)), null);
});

test('validate call shape and caching of the verdict', async () => {
  const w = createWorld();
  const first = await w.send('/v1/license');
  eq(first.status, 200);
  eq(w.polarCalls('validate').length, 1);
  const call = w.polarCalls('validate')[0];
  eq(call.method, 'POST');
  eq(call.headers.accept, 'application/json');
  ok(call.headers['content-type'].startsWith('application/json'));
  eq(JSON.parse(call.body), { key: KEY, organization_id: ORG_ID, activation_id: INSTANCE });
  eq(call.headers.authorization, undefined, 'the Polar endpoints are public: no auth header');
  const second = await w.send('/v1/license');
  eq(second.status, 200);
  eq(w.polarCalls('validate').length, 1, 'second request is served from the cache');
  const cacheKeys = [...w.kv.store.keys()].filter((k) => k.startsWith('lic:'));
  eq(cacheKeys.length, 1);
  eq(w.kv.ttls.get(cacheKeys[0]), 86400);
  ok(!cacheKeys[0].includes(KEY), 'cache key never contains the license key');
});

test('GET /v1/license returns the verdict fields', async () => {
  const w = createWorld();
  w.responders.validate = () => jsonResponse(validateBody({ expiresAt: '2027-01-01T00:00:00.000000Z', limit: 3 }));
  const res = await w.send('/v1/license');
  eq(await readJson(res), {
    status: 'granted',
    expiresAt: '2027-01-01T00:00:00.000000Z',
    activationLimit: 3,
    activationUsage: null,
    benefitId: BENEFIT_ID,
    tier: null,
  });
});

test('cache expires after LICENSE_CACHE_SECONDS and revalidates', async () => {
  const w = createWorld();
  await w.send('/v1/license');
  w.clock.t += 599 * 1000;
  await w.send('/v1/license');
  eq(w.polarCalls('validate').length, 1);
  w.clock.t += 2 * 1000;
  await w.send('/v1/license');
  eq(w.polarCalls('validate').length, 2);
});

test('grace: cached valid verdict reused when Polar answers 500, 429 or non-JSON', async () => {
  const w = createWorld();
  await w.send('/v1/license');
  w.clock.t += 700 * 1000;
  w.responders.validate = () => jsonResponse({ error: 'boom' }, 500);
  let res = await w.send('/v1/license');
  eq(res.status, 200);
  eq(w.polarCalls('validate').length, 2);
  w.responders.validate = () => jsonResponse({ error: 'RateLimited' }, 429, { 'retry-after': '5' });
  res = await w.send('/v1/license');
  eq(res.status, 200);
  eq(w.polarCalls('validate').length, 3);
  w.responders.validate = () => new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  res = await w.send('/v1/license');
  eq(res.status, 200);
  eq(w.polarCalls('validate').length, 4);
});

test('grace: cached verdict reused when Polar is unreachable', async () => {
  const w = createWorld();
  await w.send('/v1/license');
  w.clock.t += 700 * 1000;
  w.responders.validate = () => {
    throw new Error('network down');
  };
  const res = await w.send('/v1/license');
  eq(res.status, 200);
});

test('grace: not reused once older than LICENSE_GRACE_SECONDS', async () => {
  const w = createWorld({ LICENSE_GRACE_SECONDS: '1000' });
  await w.send('/v1/license');
  w.clock.t += 1001 * 1000;
  w.responders.validate = () => jsonResponse({}, 500);
  const res = await w.send('/v1/license');
  eq(res.status, 503);
});

test('503 license_service_unavailable when Polar fails and nothing is cached', async () => {
  const w = createWorld();
  w.responders.validate = () => jsonResponse({}, 500);
  let res = await w.send('/v1/license');
  eq(res.status, 503);
  eq(await readJson(res), { error: 'license_service_unavailable' });
  w.responders.validate = () => jsonResponse({}, 429, { 'Retry-After': '38' });
  res = await w.send('/v1/license');
  eq([res.status, res.headers.get('Retry-After')], [503, '38'], 'a Polar 429 becomes a 503 that carries its Retry-After');
  w.responders.validate = () => jsonResponse({}, 500);
  eq((await w.send('/v1/license')).headers.get('Retry-After'), '30', 'a 500 with no Retry-After gets the default, so the extension shows "busy, retrying" rather than "unreachable"');
  w.responders.validate = () => new Response('nope', { status: 200 });
  eq((await w.send('/v1/license')).status, 503);
  w.responders.validate = () => {
    throw new Error('network down');
  };
  res = await w.send('/v1/license');
  eq(res.status, 503);
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 0, 'an outage verdict is never cached');
});

test('organization mismatch and empty POLAR_ORGANIZATION_ID are 401 license_invalid', async () => {
  let w = createWorld({ POLAR_ORGANIZATION_ID: 'org-other' });
  w.responders.validate = () => jsonResponse(validateBody({ organizationId: ORG_ID }));
  let res = await w.send('/v1/license');
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  w = createWorld();
  w.responders.validate = () => jsonResponse(validateBody({ organizationId: 'org-foreign' }));
  res = await w.send('/v1/license');
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  w = createWorld({ POLAR_ORGANIZATION_ID: '' });
  res = await w.send('/v1/license');
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  ok(w.logs.length > 0, 'the reason is logged');
  eq(w.polarCalls('validate').length, 0, 'no key is sent to Polar without an organization id');
});

test('validate 404 plain is 401 license_invalid and the verdict is cached in memory (never KV) for LICENSE_CACHE_SECONDS', async () => {
  const w = createWorld();
  w.responders.validate = () => jsonResponse(notFound('License key not found'), 404);
  const res = await w.send('/v1/license');
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  // changed with the licence flood guard: this used to assert a KV write (ttl 600) for the 404 verdict
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 0);
  eq((await w.send('/v1/license')).status, 401);
  eq(w.polarCalls('validate').length, 1, 'the invalid verdict is served from the cache');
  w.clock.t += 601 * 1000;
  w.responders.validate = () => jsonResponse(validateBody());
  eq((await w.send('/v1/license')).status, 200, 'revalidates once the cached invalid verdict expires');
  eq(w.polarCalls('validate').length, 2);
});

test('validate 404 with an expired, revoked or disabled detail is 402 license_inactive', async () => {
  for (const [detail, status] of [
    ['License key is expired', 'expired'],
    ['License key has been Revoked', 'revoked'],
    ['License key is disabled', 'disabled'],
  ]) {
    const w = createWorld();
    w.responders.validate = () => jsonResponse(notFound(detail), 404);
    const res = await w.send('/v1/license');
    eq(res.status, 402);
    eq(await readJson(res), { error: 'license_inactive', status });
    eq((await w.send('/v1/license')).status, 402, 'cached');
    eq(w.polarCalls('validate').length, 1);
  }
});

test('validate 400 and 422 are 401 license_invalid and not cached', async () => {
  for (const status of [400, 422]) {
    const w = createWorld();
    w.responders.validate = () => jsonResponse({ error: status === 400 ? 'BadRequest' : 'HTTPValidationError', detail: 'x' }, status);
    const res = await w.send('/v1/license');
    eq(res.status, 401);
    eq(await readJson(res), { error: 'license_invalid' });
    eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 0);
  }
});

test('the 404 detail is logged with the key-hash prefix only', async () => {
  const w = createWorld();
  w.responders.validate = () => jsonResponse(notFound('License key not found'), 404);
  await w.send('/v1/license');
  const entry = w.logs.find(([event]) => event === 'license_not_found');
  ok(entry, 'a license_not_found event is logged');
  eq(entry[1].detail, 'License key not found');
  eq(entry[1].key.length, 8);
});

// Licence flood guard: per-IP RATE_LIMIT_LICENSE_ATTEMPTS before any KV read or Polar call.
function countKvOps(w) {
  const ops = { gets: 0, puts: 0 };
  const { get, put } = w.kv;
  w.kv.get = async (...args) => { ops.gets += 1; return get(...args); };
  w.kv.put = async (...args) => { ops.puts += 1; return put(...args); };
  return ops;
}
const ATTEMPT_IP = { 'cf-connecting-ip': '9.9.9.9' };

test('licence flood guard: within the limit the request proceeds, keyed by ip', async () => {
  const limiter = fakeRateLimiter(2);
  const w = createWorld({ RATE_LIMIT_LICENSE_ATTEMPTS: limiter });
  eq((await w.send('/v1/license', { headers: ATTEMPT_IP })).status, 200);
  eq(w.polarCalls('validate').length, 1);
  eq(limiter.keys, ['ip:9.9.9.9']);
});

test('licence flood guard: over the limit is 429 license_attempts_exceeded with no Polar call and no KV access', async () => {
  const limiter = fakeRateLimiter(0);
  const w = createWorld({ RATE_LIMIT_LICENSE_ATTEMPTS: limiter });
  const ops = countKvOps(w);
  const res = await w.send('/v1/license', { key: 'random-key-1', headers: ATTEMPT_IP });
  eq([res.status, res.headers.get('retry-after'), await readJson(res)], [429, '60', { error: 'license_attempts_exceeded' }]);
  eq(w.calls.length, 0);
  eq([ops.gets, ops.puts], [0, 0]);
  const entry = w.logs.find(([event]) => event === 'license_attempts_limited');
  ok(entry, 'the limit is logged');
  eq(entry[1].key.length, 8);
  ok(!JSON.stringify(w.logs).includes('random-key-1'), 'the raw key is never logged');
});

test('licence flood guard: a verdict held in memory does not spend an attempt', async () => {
  const limiter = fakeRateLimiter(1);
  const w = createWorld({ RATE_LIMIT_LICENSE_ATTEMPTS: limiter });
  eq((await w.send('/v1/license')).status, 200);
  eq((await w.send('/v1/license')).status, 200);
  eq((await w.send('/v1/license')).status, 200);
  eq(limiter.keys.length, 1, 'only the first, uncached lookup consulted the binding');
  w.clock.t += 601 * 1000;
  eq((await w.send('/v1/license')).status, 429, 'an expired verdict needs an attempt again, and the budget is spent');
});

test('licence flood guard: a Polar 404 key causes zero KV puts, a valid key is still put to KV', async () => {
  let w = createWorld();
  let ops = countKvOps(w);
  w.responders.validate = () => jsonResponse(notFound('License key not found'), 404);
  eq((await w.send('/v1/license', { key: 'random-key-2' })).status, 401);
  eq(ops.puts, 0);
  w = createWorld();
  ops = countKvOps(w);
  eq((await w.send('/v1/license')).status, 200);
  ok([...w.kv.store.keys()].some((k) => k.startsWith('lic:')), 'valid verdict is in KV');
});

test('licence flood guard: binding absent is allowed; a binding error fails open and is logged', async () => {
  let w = createWorld();
  eq((await w.send('/v1/license')).status, 200);
  w = createWorld({ RATE_LIMIT_LICENSE_ATTEMPTS: { limit: async () => { throw new Error('down'); } } });
  eq((await w.send('/v1/license')).status, 200);
  ok(w.logs.some(([event, fields]) => event === 'rate_limiter_unavailable' && fields.binding === 'RATE_LIMIT_LICENSE_ATTEMPTS'));
});

test('licence flood guard: activate is guarded (allow and deny)', async () => {
  let w = createWorld({ RATE_LIMIT_LICENSE_ATTEMPTS: fakeRateLimiter(1) });
  const post = () => w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: { licenseKey: KEY, instanceName: 'laptop' }, headers: ATTEMPT_IP });
  eq((await post()).status, 200);
  eq(w.polarCalls('activate').length, 1);
  const res = await post();
  eq([res.status, res.headers.get('retry-after'), await readJson(res)], [429, '60', { error: 'license_attempts_exceeded' }]);
  eq(w.polarCalls('activate').length, 1, 'no second Polar call');
});

test('licence flood guard: deactivate is guarded (allow and deny)', async () => {
  const limiter = fakeRateLimiter(1);
  const w = createWorld({ RATE_LIMIT_LICENSE_ATTEMPTS: limiter });
  eq((await w.send('/v1/license/deactivate', { method: 'POST', headers: ATTEMPT_IP })).status, 200);
  eq(w.polarCalls('deactivate').length, 1);
  // the deactivate cleared the verdict, so the next lookup needs an attempt, and the budget is spent
  const res = await w.send('/v1/license/deactivate', { method: 'POST', headers: ATTEMPT_IP });
  eq([res.status, await readJson(res)], [429, { error: 'license_attempts_exceeded' }]);
  eq(w.polarCalls('deactivate').length, 1);
});

// Global Polar budget: RATE_LIMIT_POLAR, one key for every caller, in front of each Polar call.
test('polar budget: within it Polar is called (allow, keyed "polar"); a fresh cached verdict never spends it', async () => {
  const limiter = fakeRateLimiter(1);
  const w = createWorld({ RATE_LIMIT_POLAR: limiter });
  eq((await w.send('/v1/license')).status, 200);
  eq((await w.send('/v1/license')).status, 200);
  eq([w.polarCalls('validate').length, limiter.keys], [1, ['polar']]);
});

test('polar budget: exhausted, an uncached key is 503 with Retry-After and logged (deny); a cached key rides its grace (allow)', async () => {
  const limiter = fakeRateLimiter(1);
  const w = createWorld({ RATE_LIMIT_POLAR: limiter });
  eq((await w.send('/v1/license')).status, 200, 'spends the one call');
  let res = await w.send('/v1/license', { key: 'random-flood-key-1' });
  eq([res.status, res.headers.get('retry-after'), await readJson(res)], [503, '30', { error: 'license_service_unavailable' }]);
  eq(w.polarCalls('validate').length, 1, 'no Polar call once the budget is spent');
  const entry = eventsNamed(w, 'license_polar_limited')[0];
  eq([entry.op, entry.key.length], ['validate', 8]);
  ok(!JSON.stringify(w.logs).includes('random-flood-key-1'));
  w.clock.t += 601 * 1000; // past the cache window, inside the grace window
  res = await w.send('/v1/license');
  eq(res.status, 200, 'the cached valid verdict is reused');
  ok(eventsNamed(w, 'license_grace_reuse').length === 1);
  res = await w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: { licenseKey: KEY, instanceName: 'x' } });
  eq([res.status, res.headers.get('retry-after')], [503, '30'], 'activate is refused too');
  res = await w.send('/v1/license/deactivate', { method: 'POST' });
  eq(res.status, 503, 'deactivate is refused too');
  eq(w.polarCalls('activate').length + w.polarCalls('deactivate').length, 0);
  eq(eventsNamed(w, 'license_polar_limited').map((e) => e.op), ['validate', 'validate', 'activate', 'validate', 'deactivate'], 'each grace reuse also logs the skipped validate');
});

test('revocation: a Polar 404 for a key with a cached valid verdict replaces the shared copy, so no isolate\'s grace path revives it (deny)', async () => {
  const w = createWorld();
  const ops = countKvOps(w);
  eq((await w.send('/v1/license')).status, 200);
  eq(ops.puts, 1);
  w.clock.t += 601 * 1000;
  w.responders.validate = () => jsonResponse(notFound('License key not found'), 404);
  eq((await w.send('/v1/license')).status, 401);
  eq(ops.puts, 2, 'one bounded write records the refusal');
  ok(eventsNamed(w, 'license_revoked_cached').length === 1);
  const stored = JSON.parse([...w.kv.store.entries()].find(([k]) => k.startsWith('lic:'))[1].value);
  eq(stored.valid, false);
  resetQuotaMemory(); // another isolate, with Polar down
  w.clock.t += 601 * 1000;
  w.responders.validate = () => jsonResponse({}, 500);
  const res = await w.send('/v1/license');
  eq(res.status, 503, 'the grace path refuses the revoked key');
  eq(eventsNamed(w, 'license_grace_reuse').length, 0);
  w.clock.t += 601 * 1000;
  w.responders.validate = () => jsonResponse(notFound('License key not found'), 404);
  eq((await w.send('/v1/license')).status, 401);
  eq(ops.puts, 2, 'a key already recorded as refused costs no further write');
});

test('benefit filter: listed benefit allowed, unlisted rejected', async () => {
  let w = createWorld({ POLAR_BENEFIT_IDS: 'benefit-100, ' + BENEFIT_ID });
  eq((await w.send('/v1/license')).status, 200);
  w = createWorld({ POLAR_BENEFIT_IDS: 'benefit-100,benefit-300' });
  const res = await w.send('/v1/license');
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
});

test('revoked or disabled status and a past expires_at are 402 license_inactive', async () => {
  let w = createWorld();
  w.responders.validate = () => jsonResponse(validateBody({ status: 'revoked' }));
  let res = await w.send('/v1/license');
  eq(res.status, 402);
  eq(await readJson(res), { error: 'license_inactive', status: 'revoked' });
  w = createWorld();
  w.responders.validate = () => jsonResponse(validateBody({ status: 'disabled' }));
  res = await w.send('/v1/license');
  eq(res.status, 402);
  eq((await readJson(res)).status, 'disabled');
  w = createWorld();
  w.responders.validate = () => jsonResponse(validateBody({ expiresAt: '2026-11-01T00:00:00.000000Z' }));
  res = await w.send('/v1/license');
  eq(res.status, 402);
  eq(await readJson(res), { error: 'license_inactive', status: 'expired' });
  w = createWorld();
  w.responders.validate = () => jsonResponse(validateBody({ expiresAt: '2027-01-01T00:00:00.000000Z' }));
  eq((await w.send('/v1/license')).status, 200, 'a future expires_at is allowed');
});

test('POLAR_API_BASE override reaches the sandbox host for every action', async () => {
  const w = createWorld({ POLAR_API_BASE: SANDBOX_HOST + '/' });
  eq((await w.send('/v1/license')).status, 200);
  await w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: { licenseKey: KEY, instanceName: 'laptop' } });
  await w.send('/v1/license/deactivate', { method: 'POST' });
  const polarUrls = w.calls.map((c) => c.url).filter((u) => u.includes(POLAR_PATH));
  eq(polarUrls, [SANDBOX_HOST + POLAR_PATH + 'validate', SANDBOX_HOST + POLAR_PATH + 'activate', SANDBOX_HOST + POLAR_PATH + 'deactivate']);
  const production = createWorld();
  await production.send('/v1/license');
  eq(production.calls[0].url, POLAR_HOST + POLAR_PATH + 'validate', 'the default base is the production host');
});

test('quotaKeys format', async () => {
  const keys = quotaKeys('abc123', T0);
  eq(keys.day, 'q:abc123:2026-11-05');
  eq(keys.minute, 'b:abc123:' + Math.floor(T0 / 60000));
});

test('daily quota: 429 with scope day and Retry-After; remaining header counts down', async () => {
  const w = createWorld({ DAILY_QUOTA: '2' });
  const first = await w.send('/v1/license');
  eq(first.headers.get('x-quota-remaining'), '1');
  const second = await w.send('/v1/license');
  eq(second.headers.get('x-quota-remaining'), '0');
  const third = await w.send('/v1/license');
  eq(third.status, 429);
  eq(await readJson(third), { error: 'quota_exceeded', scope: 'day' });
  eq(third.headers.get('retry-after'), '43170');
  const dayKey = [...w.kv.store.keys()].find((k) => k.startsWith('q:'));
  ok(dayKey.endsWith(':2026-11-05'));
  eq(w.kv.ttls.get(dayKey), 172800);
});

test('log quota_exceeded: a daily refusal logs once with the key hash prefix, never the key', async () => {
  const w = createWorld({ DAILY_QUOTA: '1' });
  eq((await w.send('/v1/license', { headers: { 'cf-connecting-ip': '5.5.5.5' } })).status, 200);
  eq(eventsNamed(w, 'quota_exceeded').length, 0, 'an allowed request logs nothing');
  eq((await w.send('/v1/license', { headers: { 'cf-connecting-ip': '5.5.5.5' } })).status, 429);
  const events = eventsNamed(w, 'quota_exceeded');
  eq(events.length, 1);
  eq([events[0].client, events[0].subjectKind, events[0].subject.length, events[0].ip], ['sourcery', 'license', 8, '5.5.5.5']);
  ok(!JSON.stringify(w.logs).includes(KEY));
});

test('minute quota: 429 with scope minute and Retry-After', async () => {
  const w = createWorld({ BURST_PER_MINUTE: '2' });
  eq((await w.send('/v1/license')).status, 200);
  eq((await w.send('/v1/license')).status, 200);
  const third = await w.send('/v1/license');
  eq(third.status, 429);
  eq(await readJson(third), { error: 'quota_exceeded', scope: 'minute' });
  eq(third.headers.get('retry-after'), '30');
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('b:')), [], 'the burst counter lives in memory, never in KV');
  w.clock.t += 60 * 1000;
  eq((await w.send('/v1/license')).status, 200, 'a new minute resets the burst counter');
});

// The free plan's 1,000 KV writes a day ran out mid-scan on 2026-11-06 (two writes per request);
// every request then failed with 500. Day counts are now batched and a refused write never fails a request.
test('quota writes are batched: one KV write per 20 requests, the stored count picked up by a fresh isolate', async () => {
  const w = createWorld();
  const puts = [];
  const put = w.kv.put.bind(w.kv);
  w.kv.put = async (key, value, options) => { if (key.startsWith('q:')) puts.push(Number(value)); return put(key, value, options); };
  for (let i = 0; i < 19; i++) eq((await w.send('/v1/license')).status, 200);
  eq(puts, [], 'nineteen requests write nothing');
  eq((await w.send('/v1/license')).headers.get('x-quota-remaining'), '1980');
  eq(puts, [20], 'the twentieth request writes the batch');
  const dayKey = [...w.kv.store.keys()].find((k) => k.startsWith('q:'));
  eq(w.kv.ttls.get(dayKey), 172800);
  for (let i = 0; i < 25; i++) await w.send('/v1/license');
  eq(puts, [20, 40], 'the next batch lands at forty; five more wait in memory');
  // a new isolate starts from what KV holds and adds its own share
  resetQuotaMemory();
  eq((await w.send('/v1/license')).headers.get('x-quota-remaining'), '1959', 'a fresh isolate reads 40 from KV (the five unflushed are lost, by design)');
  // another isolate flushed meanwhile: this one builds on the larger stored count
  await put(dayKey, '100', { expirationTtl: 172800 });
  for (let i = 0; i < 19; i++) await w.send('/v1/license');
  eq(puts[puts.length - 1], 120, 'a flush adds its pending share to the count another isolate stored');
});

test('a refused KV write never fails the request: quota and license cache fail open with a log line', async () => {
  const w = createWorld({ DAILY_QUOTA: '2' });
  w.kv.put = async () => { throw new Error('KV put() limit exceeded for the day.'); };
  const first = await w.send('/v1/license');
  eq(first.status, 200, 'the verdict cache write failed but the request went through');
  eq(w.logs.filter((l) => l[0] === 'license_cache_unavailable').length, 1);
  eq((await w.send('/v1/license')).status, 200);
  const third = await w.send('/v1/license');
  eq(third.status, 429, 'the in-memory day count still enforces the quota');
  eq(w.logs.filter((l) => l[0] === 'quota_store_unavailable').length, 1, 'the flush at the limit failed and was logged, nothing else was written');
  const activate = await w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: { licenseKey: KEY, instanceName: 'browser' }, headers: { 'content-type': 'application/json' } });
  eq(activate.status, 200, 'activation succeeds even when its verdict cannot be cached');
});

// 2026-11-07: with KV refusing writes, every request re-validated at Polar, Polar rate-limited
// it, and the extension read "API unreachable". Verdicts now live in isolate memory first.
test('verdicts are cached in memory ahead of KV: Polar is asked once per cache window even when KV cannot be written', async () => {
  const w = createWorld();
  w.kv.put = async () => { throw new Error('KV put() limit exceeded for the day.'); };
  for (let i = 0; i < 5; i++) eq((await w.send('/v1/license')).status, 200);
  eq(w.polarCalls('validate').length, 1, 'five requests, one Polar validate');
  w.clock.t += 601 * 1000;
  eq((await w.send('/v1/license')).status, 200);
  eq(w.polarCalls('validate').length, 2, 'past the cache window Polar is asked again');
  // deactivation drops the memory verdict too, so the next request re-validates
  eq((await w.send('/v1/license/deactivate', { method: 'POST', body: {}, headers: { 'content-type': 'application/json' } })).status, 200);
  await w.send('/v1/license');
  eq(w.polarCalls('validate').length, 3, 'after deactivate the verdict is gone from memory as well as KV');
  // the colo's edge cache (Cache API) is the second layer: a fresh isolate finds the verdict there with KV unwritable
  const edge = new Map();
  globalThis.caches = { default: {
    match: async (url) => (edge.has(url) ? new Response(edge.get(url), { headers: { 'Content-Type': 'application/json' } }) : undefined),
    put: async (url, res) => { edge.set(url, await res.text()); },
    delete: async (url) => edge.delete(url),
  } };
  try {
    const e = createWorld();
    e.kv.put = async () => { throw new Error('KV put() limit exceeded for the day.'); };
    eq((await e.send('/v1/license')).status, 200);
    eq([e.polarCalls('validate').length, edge.size], [1, 1], 'the first request validates at Polar and writes the verdict to the edge cache');
    resetQuotaMemory(); // a fresh isolate, same colo
    eq((await e.send('/v1/license')).status, 200);
    eq(e.polarCalls('validate').length, 1, 'the fresh isolate reads the edge cache instead of asking Polar');
    eq((await e.send('/v1/license/deactivate', { method: 'POST', body: {}, headers: { 'content-type': 'application/json' } })).status, 200);
    eq(edge.size, 0, 'deactivation drops the edge-cached verdict too');
  } finally {
    delete globalThis.caches;
  }
  // a Polar outage with no cached verdict is a 503 that always carries Retry-After
  const dark = createWorld();
  dark.responders.validate = () => new Response('busy', { status: 429 });
  const res = await dark.send('/v1/license');
  eq([res.status, res.headers.get('retry-after')], [503, '30'], 'a rate-limited Polar with nothing cached answers 503 with a default Retry-After');
});

test('quota is per license key, shared across instances', async () => {
  const w = createWorld({ DAILY_QUOTA: '1' });
  eq((await w.send('/v1/license')).status, 200);
  eq((await w.send('/v1/license', { instance: 'another-instance-id' })).status, 429);
});

test('quote forwarding: headers, body passthrough, response headers', async () => {
  const w = createWorld({ FILL_POLICY: 'cheapest' });
  const body = [{ name: 'Charizard', set: 'Base' }];
  const res = await w.send('/v1/prices/quote', {
    method: 'POST',
    body,
    origin: EXT_ORIGIN,
    headers: { 'content-type': 'application/json', accept: 'application/json', cookie: 'sid=1', 'x-forwarded-for': '1.2.3.4' },
  });
  eq(res.status, 200);
  eq(await readJson(res), [{ ok: 1 }]);
  eq(res.headers.get('etag'), '"abc"');
  eq(res.headers.get('cache-control'), 'max-age=60');
  eq(res.headers.get('content-type'), 'application/json');
  eq(res.headers.get('x-secret-origin'), null);
  ok(res.headers.get('x-quota-remaining') !== null);
  const call = w.calls.find((c) => c.url.startsWith(PRICING));
  eq(call.url, PRICING + '/v1/prices/quote');
  eq(call.method, 'POST');
  eq(call.body, JSON.stringify(body));
  eq(call.headers['x-app-token'], 'pricing-secret');
  eq(call.headers['x-fill-policy'], 'cheapest');
  eq(call.headers['content-type'], 'application/json');
  eq(call.headers.accept, 'application/json');
  eq(call.headers.authorization, undefined);
  eq(call.headers.cookie, undefined);
  eq(call.headers['x-forwarded-for'], undefined);
  eq(call.headers['x-instance-id'], undefined);
  eq(call.headers.origin, undefined);
});

test('quote: 413 over 1 MB, 400 for non-array or invalid JSON', async () => {
  const w = createWorld();
  const big = JSON.stringify(['x'.repeat(1024 * 1024 + 10)]);
  let res = await w.send('/v1/prices/quote', { method: 'POST', body: big });
  eq(res.status, 413);
  eq(await readJson(res), { error: 'payload_too_large' });
  res = await w.send('/v1/prices/quote', { method: 'POST', body: { not: 'an array' } });
  eq(res.status, 400);
  eq(await readJson(res), { error: 'invalid_body' });
  res = await w.send('/v1/prices/quote', { method: 'POST', body: 'not json' });
  eq(res.status, 400);
  eq(w.calls.filter((c) => c.url.startsWith(PRICING)).length, 0);
});

// A chunked body (no content-length) delivered as 64 KB pieces; `total` chunks, or endless.
function chunkedQuoteRequest(total = Infinity) {
  const stats = { pulled: 0, cancelled: false };
  const piece = new TextEncoder().encode(' '.repeat(64 * 1024));
  const body = new ReadableStream({
    pull(controller) {
      if (stats.pulled === 0) controller.enqueue(new TextEncoder().encode('[{"productId":1}'));
      if (stats.pulled >= total) { controller.enqueue(new TextEncoder().encode(']')); controller.close(); return; }
      stats.pulled += 1;
      controller.enqueue(piece);
    },
    cancel() { stats.cancelled = true; },
  });
  const request = new Request('https://gateway.test/pricing/v1/prices/quote', {
    method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'x-instance-id': INSTANCE, 'content-type': 'application/json' }, body, duplex: 'half',
  });
  return { request, stats };
}

test('chunked bodies: under the cap are forwarded whole (allow); over it are 413 without being read to the end (deny)', async () => {
  const w = createWorld();
  const small = chunkedQuoteRequest(3);
  eq(small.request.headers.get('content-length'), null, 'no declared length');
  let res = await handle(small.request, w.env, w.deps);
  eq(res.status, 200);
  eq(JSON.parse(lastUpstream(w, PRICING).body), [{ productId: 1 }]);
  const endless = chunkedQuoteRequest();
  res = await handle(endless.request, w.env, w.deps);
  eq([res.status, await readJson(res)], [413, { error: 'payload_too_large' }]);
  ok(endless.stats.pulled <= 18, 'stopped just past 1 MB, pulled ' + endless.stats.pulled);
  eq(endless.stats.cancelled, true, 'the rest of the stream was cancelled');
  ok(w.logs.some(([event, fields]) => event === 'request_rejected' && fields.reason === 'payload_too_large'));
});

test('products: GET preserves the query string and uses the catalog token', async () => {
  const w = createWorld();
  const res = await w.send('/v1/products/12345?include=prices&lang=en', { headers: { accept: 'application/json' } });
  eq(res.status, 200);
  eq(res.headers.get('etag'), '"cat"');
  const call = w.calls.find((c) => c.url.startsWith(CATALOG));
  eq(call.url, CATALOG + '/v1/products/12345?include=prices&lang=en');
  eq(call.method, 'GET');
  eq(call.headers['x-app-token'], 'catalog-secret');
  eq(call.headers['x-fill-policy'], undefined);
  eq(call.body, undefined);
});

test('products:lookup forwards the POST body', async () => {
  const w = createWorld();
  const body = { name: 'Pikachu', number: '58' };
  const res = await w.send('/v1/products:lookup', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  eq(res.status, 200);
  const call = w.calls.find((c) => c.url.startsWith(CATALOG));
  eq(call.url, CATALOG + '/v1/products:lookup');
  eq(call.method, 'POST');
  eq(call.body, JSON.stringify(body));
  eq(call.headers['x-app-token'], 'catalog-secret');
});

// The services each serve their games list (owner 2026-11-08; huddles pricing-games-list, catalog-games-list).
test('games lists: /v1/prices/games and /v1/catalog/games reach each origin\'s /v1/games with its token, cached an hour', async () => {
  const w = createWorld();
  const pricingGames = { games: [{ id: 'pokemon', name: 'Pokémon', categories: [3, 85] }] };
  const catalogGames = { catalogVersion: 'v1', games: [{ id: 'pokemon', name: 'Pokemon', categories: [3], products: 33076 }] };
  w.responders.pricing = () => jsonResponse(pricingGames);
  w.responders.catalog = () => jsonResponse(catalogGames, 200, { etag: '"g1"', 'cache-control': 'public, max-age=3600' });
  let res = await w.send('/v1/prices/games');
  eq(res.status, 200);
  eq(await readJson(res), pricingGames);
  eq(res.headers.get('cache-control'), 'private, max-age=3600', 'an origin that sends no cache header gets the hour');
  let call = w.calls.find((c) => c.url.startsWith(PRICING));
  // every pricing request carries the policy's fill policy (pricing treats an absent header as "default")
  eq([call.url, call.method, call.headers['x-app-token'], call.headers['x-fill-policy']], [PRICING + '/v1/games', 'GET', 'pricing-secret', 'none']);
  res = await w.send('/v1/catalog/games');
  eq(res.status, 200);
  eq(await readJson(res), catalogGames);
  eq([res.headers.get('etag'), res.headers.get('cache-control')], ['"g1"', 'public, max-age=3600'], 'the origin\'s own cache header and ETag pass through');
  call = w.calls.find((c) => c.url.startsWith(CATALOG));
  eq([call.url, call.headers['x-app-token']], [CATALOG + '/v1/games', 'catalog-secret']);
  eq((await w.send('/v1/prices/games', { method: 'POST', body: {} })).status, 405);
  eq((await w.send('/v1/catalog/games', { key: null })).status, 401, 'the lists need a license like every other data route');
});

test('products: only digit ids are routed', async () => {
  const w = createWorld();
  eq((await w.send('/v1/products/abc')).status, 404);
  eq((await w.send('/v1/products/12/extra')).status, 404);
  eq((await w.send('/v1/products/')).status, 404);
});

test('origin 5xx and network failure are 502 origin_unavailable; 4xx passes through', async () => {
  const w = createWorld();
  w.responders.pricing = () => jsonResponse({ detail: 'oops' }, 500);
  let res = await w.send('/v1/prices/quote', { method: 'POST', body: [] });
  eq(res.status, 502);
  eq(await readJson(res), { error: 'origin_unavailable' });
  w.responders.catalog = () => {
    throw new Error('connect refused');
  };
  res = await w.send('/v1/products/1');
  eq(res.status, 502);
  w.responders.catalog = () => jsonResponse({ error: 'nope' }, 404);
  res = await w.send('/v1/products/1');
  eq(res.status, 404);
  eq(await readJson(res), { error: 'nope' });
});

test('503 origin_not_configured when an origin or its token is missing', async () => {
  let w = createWorld({ PRICING_ORIGIN: '' });
  let res = await w.send('/v1/prices/quote', { method: 'POST', body: [] });
  eq(res.status, 503);
  eq(await readJson(res), { error: 'origin_not_configured' });
  w = createWorld({ CATALOG_ORIGIN: '' });
  res = await w.send('/v1/products/1');
  eq(res.status, 503);
  res = await w.send('/v1/products:lookup', { method: 'POST', body: {} });
  eq(res.status, 503);
  w = createWorld({ CATALOG_APP_TOKEN: '' });
  eq((await w.send('/v1/products/1')).status, 503);
});

test('CORS: allowed extension origin gets headers on normal and error responses', async () => {
  const w = createWorld();
  let res = await w.send('/v1/health', { key: null, instance: null, origin: EXT_ORIGIN });
  eq(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
  eq(res.headers.get('vary'), 'Origin');
  eq(res.headers.get('access-control-allow-headers'), 'authorization, content-type, x-instance-id');
  eq(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  eq(res.headers.get('access-control-expose-headers'), 'X-Quota-Remaining, Retry-After, ETag, X-Gateway-Cache');
  res = await w.send('/v1/license', { key: null, origin: 'moz-extension://xyz' });
  eq(res.status, 401);
  eq(res.headers.get('access-control-allow-origin'), 'moz-extension://xyz');
  res = await w.send('/v1/nothing', { origin: EXT_ORIGIN });
  eq(res.status, 404);
  eq(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
});

test('CORS: disallowed origin gets no CORS headers but is still processed', async () => {
  const w = createWorld();
  const res = await w.send('/v1/health', { key: null, instance: null, origin: 'https://evil.example' });
  eq(res.status, 200);
  eq(res.headers.get('access-control-allow-origin'), null);
  eq(res.headers.get('access-control-allow-methods'), null);
  const prefixes = corsOriginsOf(DEFAULT_CLIENTS);
  eq(corsHeaders('https://evil.example', prefixes), {});
  eq(corsHeaders(null, prefixes), {});
  eq(corsHeaders(EXT_ORIGIN, prefixes)['Access-Control-Allow-Origin'], EXT_ORIGIN);
});

test('CORS: clients.js is the only source of allowed origins; the old env var is ignored', async () => {
  const w = createWorld({ ALLOWED_ORIGIN_PREFIXES: 'https://evil.example' });
  let res = await w.send('/v1/health', { key: null, instance: null, origin: 'https://evil.example' });
  eq(res.headers.get('access-control-allow-origin'), null, 'an origin only the env var allows gets no CORS');
  res = await w.send('/v1/health', { key: null, instance: null, origin: EXT_ORIGIN });
  eq(res.headers.get('access-control-allow-origin'), EXT_ORIGIN, 'a clients.js origin does, with the env var unset or wrong');
});

test('CORS: preflight is 204 without auth or upstream calls', async () => {
  const w = createWorld();
  const res = await handle(
    new Request('https://gateway.test/v1/prices/quote', {
      method: 'OPTIONS',
      headers: { origin: EXT_ORIGIN, 'access-control-request-method': 'POST' },
    }),
    w.env,
    w.deps,
  );
  eq(res.status, 204);
  eq(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
  eq(w.calls.length, 0);
});

test('activate: success returns instance details and seeds the verdict cache (memory and edge, never KV)', async () => {
  const w = createWorld();
  const edge = createFakeCache(w.clock);
  globalThis.caches = { default: edge };
  try {
  w.responders.activate = () => jsonResponse(activateBody({ limit: 3, expiresAt: '2027-01-01T00:00:00.000000Z' }));
  const res = await w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: { licenseKey: KEY, instanceName: 'laptop' } });
  eq(res.status, 200);
  eq(await readJson(res), {
    instanceId: INSTANCE,
    status: 'granted',
    expiresAt: '2027-01-01T00:00:00.000000Z',
    activationLimit: 3,
    activationUsage: null,
    tier: null,
  });
  const call = w.polarCalls('activate')[0];
  eq(call.method, 'POST');
  eq(call.headers.accept, 'application/json');
  ok(call.headers['content-type'].startsWith('application/json'));
  eq(JSON.parse(call.body), { key: KEY, organization_id: ORG_ID, label: 'laptop' });
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 0, 'activate spends no KV write');
  const seeded = [...edge.store.keys()].filter((k) => k.includes('lic:'));
  eq(seeded.length, 1);
  ok(!seeded[0].includes(KEY), 'cache key never contains the license key');
  eq(edge.store.get(seeded[0]).expiresAt, w.clock.t + 86400 * 1000);
  eq((await w.send('/v1/license')).status, 200);
  eq(w.polarCalls('validate').length, 0, 'first authed request uses the seeded verdict');
  resetQuotaMemory(); // a fresh isolate in the same colo finds it in the edge cache
  eq((await w.send('/v1/license')).status, 200);
  eq(w.polarCalls('validate').length, 0, 'a fresh isolate uses the edge copy');
  } finally {
    delete globalThis.caches;
  }
});

test('activate/deactivate cycling by a valid key spends no KV writes (deny), while a validate still persists to KV (allow)', async () => {
  const w = createWorld();
  const ops = countKvOps(w);
  let deletes = 0;
  const del = w.kv.delete;
  w.kv.delete = async (...args) => { deletes += 1; return del(...args); };
  for (let i = 0; i < 5; i += 1) {
    eq((await w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: { licenseKey: KEY, instanceName: 'laptop' } })).status, 200);
    eq((await w.send('/v1/license/deactivate', { method: 'POST' })).status, 200);
  }
  eq([ops.puts, deletes], [0, 0], 'no KV write or delete across five cycles');
  resetQuotaMemory();
  eq((await w.send('/v1/license')).status, 200);
  eq(ops.puts, 1, 'an uncached validate writes its verdict to KV');
  eq((await w.send('/v1/license/deactivate', { method: 'POST' })).status, 200);
  eq(deletes, 1, 'deactivate deletes the KV copy only when one exists');
});

test('activate: 403 limit is 409, revoked 402, other 403 and 404 are 401, bad body 400, outage 503', async () => {
  const w = createWorld();
  const post = (body) => w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body });
  w.responders.activate = () => jsonResponse(notPermitted('License key activation limit already reached. Deactivate an existing instance to create a new one.'), 403);
  let res = await post({ licenseKey: KEY, instanceName: 'laptop' });
  eq(res.status, 409);
  eq(await readJson(res), { error: 'activation_limit' });
  w.responders.activate = () => jsonResponse(notPermitted('License key is revoked'), 403);
  res = await post({ licenseKey: KEY, instanceName: 'laptop' });
  eq(res.status, 402);
  eq(await readJson(res), { error: 'license_inactive', status: 'revoked' });
  w.responders.activate = () => jsonResponse(notPermitted('License key is expired'), 403);
  res = await post({ licenseKey: KEY, instanceName: 'laptop' });
  eq(res.status, 402);
  eq(await readJson(res), { error: 'license_inactive', status: 'expired' });
  w.responders.activate = () => jsonResponse(notPermitted('License key does not support activations'), 403);
  res = await post({ licenseKey: KEY, instanceName: 'laptop' });
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  w.responders.activate = () => jsonResponse(notFound('License key not found'), 404);
  res = await post({ licenseKey: KEY, instanceName: 'laptop' });
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  res = await post({ licenseKey: KEY });
  eq(res.status, 400);
  res = await w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: 'nope' });
  eq(res.status, 400);
  for (const respond of [() => jsonResponse({}, 500), () => jsonResponse({}, 429), () => new Response('x', { status: 200 })]) {
    w.responders.activate = respond;
    res = await post({ licenseKey: KEY, instanceName: 'laptop' });
    eq(res.status, 503);
    eq(await readJson(res), { error: 'license_service_unavailable' });
  }
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 0, 'nothing is cached from a rejected activation');
});

test('activate: organization mismatch 401, benefit mismatch 401, revoked or expired license key 402', async () => {
  const post = (w) => w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: { licenseKey: KEY, instanceName: 'laptop' } });
  let w = createWorld();
  w.responders.activate = () => jsonResponse(activateBody({ organizationId: 'org-foreign' }));
  let res = await post(w);
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  w = createWorld({ POLAR_ORGANIZATION_ID: '' });
  eq((await post(w)).status, 401);
  eq(w.polarCalls('activate').length, 0, 'no key is sent to Polar without an organization id');
  w = createWorld({ POLAR_BENEFIT_IDS: 'benefit-5' });
  eq((await post(w)).status, 401);
  eq(w.kv.store.size, 0);
  w = createWorld();
  w.responders.activate = () => jsonResponse(activateBody({ status: 'revoked' }));
  res = await post(w);
  eq(res.status, 402);
  eq((await readJson(res)).error, 'license_inactive');
  w = createWorld();
  w.responders.activate = () => jsonResponse(activateBody({ expiresAt: '2026-11-01T00:00:00.000000Z' }));
  res = await post(w);
  eq(res.status, 402);
  eq(await readJson(res), { error: 'license_inactive', status: 'expired' });
});

const TIERS = 'benefit-basic:basic, benefit-pro:pro';
const withBenefit = (benefitId) => () => jsonResponse(validateBody({ benefitId }));
const quoteFillPolicy = async (w) => {
  await w.send('/v1/prices/quote', { method: 'POST', body: [] });
  return w.calls.find((c) => c.url.startsWith(PRICING)).headers['x-fill-policy'];
};

test('tier: resolved from the verdict benefit through POLAR_TIERS, null when unmapped or unset', async () => {
  let w = createWorld({ POLAR_TIERS: TIERS });
  w.responders.validate = withBenefit('benefit-pro');
  eq((await readJson(await w.send('/v1/license'))).tier, 'pro');
  w = createWorld({ POLAR_TIERS: TIERS });
  w.responders.validate = withBenefit('benefit-basic');
  eq((await readJson(await w.send('/v1/license'))).tier, 'basic');
  w = createWorld({ POLAR_TIERS: TIERS, POLAR_BENEFIT_IDS: 'benefit-other' });
  w.responders.validate = withBenefit('benefit-other');
  eq((await readJson(await w.send('/v1/license'))).tier, null, 'allow-listed but unmapped benefit has no tier');
  w = createWorld();
  eq((await readJson(await w.send('/v1/license'))).tier, null, 'no POLAR_TIERS: no tier');
});

test('tier: cached with the verdict, no second validate needed to report it', async () => {
  const w = createWorld({ POLAR_TIERS: TIERS });
  w.responders.validate = withBenefit('benefit-pro');
  await w.send('/v1/license');
  const cacheKey = [...w.kv.store.keys()].find((k) => k.startsWith('lic:'));
  eq(JSON.parse(w.kv.store.get(cacheKey).value).tier, 'pro');
  eq((await readJson(await w.send('/v1/license'))).tier, 'pro');
  eq(w.polarCalls('validate').length, 1);
});

test('quote: x-fill-policy is default for pro, none for basic and for an unmapped benefit', async () => {
  let w = createWorld({ POLAR_TIERS: TIERS, FILL_POLICY: 'cheapest' });
  w.responders.validate = withBenefit('benefit-pro');
  eq(await quoteFillPolicy(w), 'default');
  w = createWorld({ POLAR_TIERS: TIERS, FILL_POLICY: 'cheapest' });
  w.responders.validate = withBenefit('benefit-basic');
  eq(await quoteFillPolicy(w), 'none');
  w = createWorld({ POLAR_TIERS: TIERS, POLAR_BENEFIT_IDS: 'benefit-other' });
  w.responders.validate = withBenefit('benefit-other');
  eq(await quoteFillPolicy(w), 'none', 'unmapped benefit falls back to FILL_POLICY (none)');
  w = createWorld({ POLAR_TIERS: TIERS, POLAR_BENEFIT_IDS: 'benefit-other', FILL_POLICY: 'cheapest' });
  w.responders.validate = withBenefit('benefit-other');
  eq(await quoteFillPolicy(w), 'cheapest', 'unmapped benefit uses FILL_POLICY');
});

test('quote: FILL_POLICY_BY_TIER overrides the default basic:none,pro:default', async () => {
  let w = createWorld({ POLAR_TIERS: TIERS, FILL_POLICY_BY_TIER: 'basic:default, pro:none' });
  w.responders.validate = withBenefit('benefit-basic');
  eq(await quoteFillPolicy(w), 'default');
  w = createWorld({ POLAR_TIERS: TIERS, FILL_POLICY_BY_TIER: 'basic:default, pro:none' });
  w.responders.validate = withBenefit('benefit-pro');
  eq(await quoteFillPolicy(w), 'none');
});

test('tier: POLAR_TIERS alone is the allow-list when POLAR_BENEFIT_IDS is empty', async () => {
  let w = createWorld({ POLAR_TIERS: TIERS });
  w.responders.validate = withBenefit('benefit-basic');
  eq((await w.send('/v1/license')).status, 200);
  w = createWorld({ POLAR_TIERS: TIERS });
  w.responders.validate = withBenefit('benefit-outside');
  const res = await w.send('/v1/license');
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  w = createWorld({ POLAR_TIERS: TIERS, POLAR_BENEFIT_IDS: 'benefit-outside' });
  w.responders.validate = withBenefit('benefit-outside');
  eq((await w.send('/v1/license')).status, 200, 'an explicit POLAR_BENEFIT_IDS stays the allow-list');
  w = createWorld({ POLAR_TIERS: TIERS, POLAR_BENEFIT_IDS: 'benefit-outside' });
  w.responders.validate = withBenefit('benefit-pro');
  eq((await w.send('/v1/license')).status, 401, 'explicit POLAR_BENEFIT_IDS excludes a tier benefit it does not list');
});

test('activate: response carries tier (string or null)', async () => {
  const post = (w) => w.send('/v1/license/activate', { method: 'POST', key: null, instance: null, body: { licenseKey: KEY, instanceName: 'laptop' } });
  let w = createWorld({ POLAR_TIERS: TIERS });
  w.responders.activate = () => jsonResponse(activateBody({ benefitId: 'benefit-pro' }));
  let res = await post(w);
  eq(res.status, 200);
  eq((await readJson(res)).tier, 'pro');
  eq((await readJson(await w.send('/v1/license'))).tier, 'pro', 'the seeded verdict carries the tier');
  eq(w.polarCalls('validate').length, 0);
  w = createWorld();
  res = await post(w);
  eq((await readJson(res)).tier, null);
});

test('deactivate: 204 returns 200, sends the activation id and clears the cached verdict', async () => {
  const w = createWorld();
  await w.send('/v1/license');
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 1);
  const res = await w.send('/v1/license/deactivate', { method: 'POST' });
  eq(res.status, 200);
  eq(await readJson(res), { deactivated: true });
  const call = w.polarCalls('deactivate')[0];
  eq(JSON.parse(call.body), { key: KEY, organization_id: ORG_ID, activation_id: INSTANCE });
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 0);
  await w.send('/v1/license');
  eq(w.polarCalls('validate').length, 2, 'next request has to validate again');
});

test('deactivate: 404 (activation already gone) is still 200 and clears the cached verdict', async () => {
  const w = createWorld();
  await w.send('/v1/license');
  w.responders.deactivate = () => jsonResponse(notFound('Activation not found'), 404);
  const res = await w.send('/v1/license/deactivate', { method: 'POST' });
  eq(res.status, 200);
  eq(await readJson(res), { deactivated: true });
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 0);
});

test('deactivate: 5xx and 429 are 503 and keep the cached verdict', async () => {
  const w = createWorld();
  await w.send('/v1/license');
  for (const status of [500, 429]) {
    w.responders.deactivate = () => jsonResponse({}, status);
    const res = await w.send('/v1/license/deactivate', { method: 'POST' });
    eq(res.status, 503);
    eq(await readJson(res), { error: 'license_service_unavailable' });
  }
  eq([...w.kv.store.keys()].filter((k) => k.startsWith('lic:')).length, 1);
});

test('404 for unknown paths, 405 for wrong methods', async () => {
  const w = createWorld();
  let res = await w.send('/v1/nothing');
  eq(res.status, 404);
  eq(await readJson(res), { error: 'not_found' });
  res = await w.send('/', { key: null });
  eq(res.status, 404);
  res = await w.send('/v1/prices/quote');
  eq(res.status, 405);
  eq(await readJson(res), { error: 'method_not_allowed' });
  ok(res.headers.get('allow').includes('POST'));
  res = await w.send('/v1/health', { method: 'POST', key: null });
  eq(res.status, 405);
  res = await w.send('/v1/license', { method: 'DELETE' });
  eq(res.status, 405);
  res = await w.send('/v1/products/5', { method: 'POST', body: {} });
  eq(res.status, 405);
});

test('license keys are never logged in full', async () => {
  const w = createWorld();
  await w.send('/v1/license');
  await w.send('/v1/license', { key: 'abcdefgh-wrong-key-0000' });
  ok(!JSON.stringify(w.logs).includes(KEY));
  ok(!JSON.stringify(w.logs).includes('abcdefgh-wrong-key-0000'));
});

// ---------- G1: namespaced routing, client policies, legacy aliases ----------

const sha256Hex = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

const APP_KEY = 'a'.repeat(32) + 'b'.repeat(32); // 32 bytes as hex
const OTHER_APP_KEY = 'c'.repeat(64);

// A world whose policy table has one app-key client (a stand-in for a server-side app).
async function createAppWorld({ fillPolicy = 'default', routes, quota, maxQuoteItems = null } = {}, envOverrides = {}) {
  const w = createWorld(envOverrides);
  const app = Object.freeze({
    id: 'test-backend',
    auth: 'app-key',
    keySha256: await sha256Hex(APP_KEY),
    routes: routes ?? ['pricing:quote', 'pricing:history', 'catalog:manifest', 'catalog:artifact'],
    fillPolicy,
    quota: quota ?? { daily: 1000, perMinute: 100, perMinuteBinding: 'RATE_LIMIT_APP' },
    maxQuoteItems,
    origins: [],
    cache: null,
  });
  w.deps.clients = { ...DEFAULT_CLIENTS, appKeys: [app] };
  assertValidClients(w.deps.clients);
  return w;
}

// A fake Workers rate-limiting binding: allows `limit` calls per key, records keys.
function fakeRateLimiter(limit) {
  const counts = new Map();
  const keys = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= limit };
    },
  };
}

const lastUpstream = (w, origin) => w.calls.filter((c) => c.url.startsWith(origin)).at(-1);

test('routes: namespaced paths resolve to service routes; unknown and traversal paths do not', async () => {
  eq(matchPath('/pricing/v1/prices/quote').routes[0].id, 'pricing:quote');
  eq(matchPath('/pricing/v1/prices/quote').upstreamPath, '/v1/prices/quote');
  eq(matchPath('/catalog/v1/artifacts/pokemon.0123abcd.json').routes[0].id, 'catalog:artifact');
  eq(matchPath('/catalog/v1/products:lookup').routes[0].id, 'catalog:products.lookup');
  eq(matchPath('/pricing/v1/prices/product/123').routes[0].id, 'pricing:product');
  eq(matchPath('/pricing/v1/prices/product/abc'), null);
  eq(matchPath('/catalog/v1/artifacts/.hidden'), null);
  eq(matchPath('/catalog/v1/artifacts/a/b.json'), null);
  eq(matchPath('/catalog/v2/manifest.json'), null);
  eq(matchPath('/pricing/v1/tags'), null, 'a route of one service is not served under the other');
  eq(matchPath('/other/v1/health'), null);
  eq(matchPath('/v1/health').routes[0].id, 'gateway:health');
});

test('routes: every legacy alias maps onto its namespaced route', async () => {
  const cases = [
    ['/v1/prices/quote', 'pricing:quote', '/v1/prices/quote'],
    ['/v1/products:lookup', 'catalog:products.lookup', '/v1/products:lookup'],
    ['/v1/products/42', 'catalog:products.get', '/v1/products/42'],
    ['/v1/prices/games', 'pricing:games', '/v1/games'],
    ['/v1/catalog/games', 'catalog:games', '/v1/games'],
  ];
  for (const [path, id, upstream] of cases) {
    const m = matchPath(path);
    eq([m.routes[0].id, m.upstreamPath, m.aliasOf], [id, upstream, path], path);
  }
});

test('pipeline: 404 and 405 come before any auth work', async () => {
  const w = createWorld();
  let res = await w.send('/pricing/v1/nope', { key: 'bad key with spaces', instance: null });
  eq([res.status, await readJson(res)], [404, { error: 'not_found' }]);
  res = await w.send('/pricing/v1/prices/quote', { method: 'GET', headers: { authorization: 'Basic x' } });
  eq(res.status, 405);
  eq(res.headers.get('allow'), 'POST, OPTIONS');
  eq(w.calls.length, 0, 'no Polar call, no upstream call');
});

test('licence client: allowed namespaced routes forward with the tier fill policy', async () => {
  const w = createWorld({ POLAR_TIERS: BENEFIT_ID + ':pro' });
  let res = await w.send('/pricing/v1/prices/quote', { method: 'POST', body: [{ productId: 1 }] });
  eq(res.status, 200);
  let call = lastUpstream(w, PRICING);
  eq([call.url, call.headers['x-fill-policy'], call.headers['x-app-token']], [PRICING + '/v1/prices/quote', 'default', 'pricing-secret']);
  res = await w.send('/catalog/v1/products/77?fields=a');
  eq(res.status, 200);
  call = lastUpstream(w, CATALOG);
  eq([call.url, call.headers['x-fill-policy']], [CATALOG + '/v1/products/77?fields=a', undefined], 'catalog never gets a fill policy');
  ok(res.headers.get('x-quota-remaining') !== null);
});

test('licence client: routes outside its policy are 403 forbidden, never forwarded', async () => {
  const w = createWorld();
  for (const [path, method] of [
    ['/pricing/v1/history', 'GET'],
    ['/pricing/v1/prices/product/1', 'GET'],
    ['/catalog/v1/manifest.json', 'GET'],
    ['/catalog/v1/tags', 'GET'],
    ['/catalog/v1/tags/mew%7C25', 'POST'],
    ['/catalog/v1/health', 'GET'],
  ]) {
    const res = await w.send(path, { method, body: method === 'POST' ? {} : undefined });
    eq([res.status, await readJson(res)], [403, { error: 'forbidden' }], path);
  }
  eq(w.calls.filter((c) => c.url.startsWith(PRICING) || c.url.startsWith(CATALOG)).length, 0);
});

test('anonymous client: open routes only; data routes are 401 credential_required', async () => {
  const w = createWorld();
  eq((await w.send('/v1/health', { key: null, instance: null })).status, 200);
  for (const path of ['/pricing/v1/games', '/catalog/v1/manifest.json', '/v1/catalog/games']) {
    const res = await w.send(path, { key: null, instance: null });
    eq([res.status, await readJson(res)], [401, { error: 'credential_required' }], path);
  }
  eq(w.calls.length, 0);
});

test('legacy aliases still work for Sourcery and each hit is logged', async () => {
  const w = createWorld();
  eq((await w.send('/v1/prices/quote', { method: 'POST', body: [] })).status, 200);
  eq(lastUpstream(w, PRICING).url, PRICING + '/v1/prices/quote');
  eq((await w.send('/v1/products/5')).status, 200);
  eq(lastUpstream(w, CATALOG).url, CATALOG + '/v1/products/5');
  const aliasLogs = w.logs.filter(([event]) => event === 'legacy_alias').map(([, f]) => [f.path, f.route, f.client]);
  eq(aliasLogs, [['/v1/prices/quote', 'pricing:quote', 'sourcery'], ['/v1/products/5', 'catalog:products.get', 'sourcery']]);
  eq((await w.send('/pricing/v1/prices/quote', { method: 'POST', body: [] })).status, 200);
  eq(w.logs.filter(([event]) => event === 'legacy_alias').length, 2, 'namespaced paths are not alias hits');
});

test('forwarding: only content-type and accept pass; client fill policy and tokens are stripped', async () => {
  const w = createWorld();
  await w.send('/pricing/v1/prices/quote', {
    method: 'POST',
    body: [],
    headers: { 'x-fill-policy': 'default', 'x-app-token': 'forged', cookie: 'a=b', 'cf-access-client-id': 'forged', accept: 'application/json' },
  });
  const call = lastUpstream(w, PRICING);
  eq(Object.keys(call.headers).sort(), ['accept', 'content-type', 'x-app-token', 'x-fill-policy']);
  eq([call.headers['x-fill-policy'], call.headers['x-app-token']], ['none', 'pricing-secret'], 'a basic-tier key cannot ask for fills');
});

test('app key: matched by hash before any licence lookup, even with X-Instance-Id present', async () => {
  const w = await createAppWorld({ fillPolicy: 'default' });
  const res = await w.send('/pricing/v1/history?game=pokemon', { key: APP_KEY, instance: INSTANCE });
  eq(res.status, 200);
  eq(w.polarCalls('validate').length, 0, 'no Polar call for an app key');
  const call = lastUpstream(w, PRICING);
  eq([call.url, call.headers['x-fill-policy']], [PRICING + '/v1/history?game=pokemon', 'default']);
  eq(res.headers.get('x-quota-remaining'), '999');
});

test('app key: policy is least privilege; ungranted routes are 403', async () => {
  const w = await createAppWorld();
  for (const path of ['/catalog/v1/products/1', '/v1/license', '/pricing/v1/games']) {
    const res = await w.send(path, { key: APP_KEY, instance: null });
    eq([res.status, await readJson(res)], [403, { error: 'forbidden' }], path);
  }
  eq((await w.send('/catalog/v1/artifacts/pokemon.abc.json', { key: APP_KEY, instance: null })).status, 200);
});

test('app key: an unknown key is never anonymous; without X-Instance-Id it is a 401', async () => {
  const w = await createAppWorld();
  let res = await w.send('/v1/health', { key: OTHER_APP_KEY, instance: null });
  eq([res.status, await readJson(res)], [401, { error: 'license_required' }], 'even an open route refuses an invalid credential');
  res = await w.send('/pricing/v1/history', { key: OTHER_APP_KEY, instance: null });
  eq(res.status, 401);
  eq(w.calls.length, 0);
});

test('invalid licence credential is a 401 on every route, never downgraded to anonymous', async () => {
  const w = createWorld();
  w.responders.validate = () => jsonResponse(notFound('License key not found'), 404);
  for (const [path, method] of [['/v1/health', 'GET'], ['/v1/license/activate', 'POST'], ['/pricing/v1/prices/quote', 'POST']]) {
    const res = await w.send(path, { method, body: method === 'POST' ? [] : undefined, key: 'unknown-key-1234' });
    eq([res.status, await readJson(res)], [401, { error: 'license_invalid' }], path);
  }
  w.responders.validate = () => jsonResponse(notFound('License key is revoked'), 404);
  const res = await w.send('/pricing/v1/prices/quote', { method: 'POST', body: [], key: 'revoked-key-1234' });
  eq([res.status, await readJson(res)], [402, { error: 'license_inactive', status: 'revoked' }], 'inactive keeps Sourcery\'s 402');
});

test('app key with a forced none fill policy cannot spend budget whatever it sends', async () => {
  const w = await createAppWorld({ fillPolicy: 'none' });
  await w.send('/pricing/v1/prices/quote', { method: 'POST', body: [], key: APP_KEY, instance: null, headers: { 'x-fill-policy': 'default' } });
  eq(lastUpstream(w, PRICING).headers['x-fill-policy'], 'none');
});

test('quote batch cap: a policy maxQuoteItems refuses larger batches with 413', async () => {
  const w = await createAppWorld({ maxQuoteItems: 100 });
  const item = { productId: 1 };
  let res = await w.send('/pricing/v1/prices/quote', { method: 'POST', body: Array(100).fill(item), key: APP_KEY, instance: null });
  eq(res.status, 200);
  res = await w.send('/pricing/v1/prices/quote', { method: 'POST', body: Array(101).fill(item), key: APP_KEY, instance: null });
  eq([res.status, await readJson(res)], [413, { error: 'batch_too_large', max: 100 }]);
  eq(w.calls.filter((c) => c.url.startsWith(PRICING)).length, 1);
  res = await w.send('/pricing/v1/prices/quote', { method: 'POST', body: { not: 'an array' }, key: APP_KEY, instance: null });
  eq(res.status, 400);
});

test('log rate_limited: the in-memory per-minute refusal logs once with limiter memory', async () => {
  const w = createWorld({ BURST_PER_MINUTE: '1' });
  eq((await w.send('/v1/license')).status, 200);
  eq(eventsNamed(w, 'rate_limited').length, 0);
  eq((await w.send('/v1/license')).status, 429);
  const events = eventsNamed(w, 'rate_limited');
  eq(events.length, 1);
  eq([events[0].client, events[0].limiter, events[0].subjectKind, events[0].subject.length], ['sourcery', 'memory', 'license', 8]);
});

test('rate-limiting binding: decides per-minute limits when present, keyed per licence key', async () => {
  const limiter = fakeRateLimiter(2);
  const w = createWorld({ RATE_LIMIT_LICENSE: limiter, BURST_PER_MINUTE: '1' });
  eq((await w.send('/v1/license')).status, 200);
  eq((await w.send('/v1/license')).status, 200, 'the binding, not the in-memory fallback (limit 1), decides');
  const res = await w.send('/v1/license');
  eq([res.status, res.headers.get('retry-after'), (await readJson(res)).scope], [429, '60', 'minute']);
  eq(new Set(limiter.keys).size, 1);
  ok(!limiter.keys[0].includes(KEY), 'the binding key is a hash, never the licence key');
});

test('log rate_limited: a binding refusal logs the binding name and ip subject; an app key logs its app id', async () => {
  const w = createWorld({ RATE_LIMIT_PUBLIC: fakeRateLimiter(1) });
  const anon = () => w.send('/v1/health', { key: null, instance: null, headers: { 'cf-connecting-ip': '1.1.1.1' } });
  await anon();
  eq(eventsNamed(w, 'rate_limited').length, 0);
  await anon();
  const events = eventsNamed(w, 'rate_limited');
  eq(events.length, 1);
  eq([events[0].client, events[0].limiter, events[0].subjectKind, events[0].subject, events[0].ip], ['anonymous', 'RATE_LIMIT_PUBLIC', 'ip', '1.1.1.1', '1.1.1.1']);
  const app = await createAppWorld({}, { RATE_LIMIT_APP: fakeRateLimiter(0) });
  const res = await app.send('/catalog/v1/manifest.json', { key: APP_KEY, instance: null });
  eq(res.status, 429);
  const appEvents = eventsNamed(app, 'rate_limited');
  eq([appEvents.length, appEvents[0].client, appEvents[0].subjectKind, appEvents[0].subject], [1, 'test-backend', 'app', 'test-backend']);
  ok(!JSON.stringify(app.logs).includes(APP_KEY));
});

test('rate-limiting binding: anonymous calls are limited per IP; a binding error fails open', async () => {
  const limiter = fakeRateLimiter(1);
  const w = createWorld({ RATE_LIMIT_PUBLIC: limiter });
  const anon = (ip) => w.send('/v1/health', { key: null, instance: null, headers: { 'cf-connecting-ip': ip } });
  eq((await anon('1.1.1.1')).status, 200);
  eq((await anon('1.1.1.1')).status, 429);
  eq((await anon('2.2.2.2')).status, 200);
  eq(limiter.keys, ['ip:1.1.1.1', 'ip:1.1.1.1', 'ip:2.2.2.2']);
  w.env.RATE_LIMIT_PUBLIC = { limit: async () => { throw new Error('down'); } };
  eq((await anon('1.1.1.1')).status, 200);
  ok(w.logs.some(([event]) => event === 'rate_limiter_unavailable'));
});

test('app key quota: daily limit from its policy, counted separately from licences', async () => {
  const w = await createAppWorld({ quota: { daily: 2, perMinute: null, perMinuteBinding: null } });
  eq((await w.send('/pricing/v1/history', { key: APP_KEY, instance: null })).status, 200);
  eq((await w.send('/pricing/v1/history', { key: APP_KEY, instance: null })).status, 200);
  const res = await w.send('/pricing/v1/history', { key: APP_KEY, instance: null });
  eq([res.status, (await readJson(res)).scope], [429, 'day']);
  eq((await w.send('/v1/license')).status, 200, 'the licence quota is untouched');
});

test('policy table: the shipped table is valid; malformed rows are rejected', async () => {
  assertValidClients(DEFAULT_CLIENTS);
  eq(LICENSE_CLIENT.routes.includes('catalog:tags.write'), false, 'no client is granted the tag write by default');
  const app = { id: 'x', auth: 'app-key', keySha256: '0'.repeat(64), routes: [], fillPolicy: 'none', quota: {}, origins: [] };
  const bad = [
    { ...app, routes: ['pricing:nope'] },
    { ...app, fillPolicy: 'sometimes' },
    { ...app, fillPolicy: 'by-license-tier' },
    { ...app, keySha256: 'not-a-hash' },
    { ...app, routes: ['gateway:license'] },
    { ...app, id: 'sourcery' },
  ];
  for (const row of bad) {
    let threw = false;
    try { assertValidClients({ ...DEFAULT_CLIENTS, appKeys: [row] }); } catch { threw = true; }
    ok(threw, JSON.stringify(row));
  }
  let threw = false;
  try { assertValidClients({ ...DEFAULT_CLIENTS, anonymous: { ...ANONYMOUS_CLIENT, routes: ['pricing:quote'] } }); } catch { threw = true; }
  ok(threw, 'the anonymous client may not be granted data routes');
});

// ---------- G2: pricing health open through the gateway ----------

test('pricing health: open to anonymous callers, forwarded to pricing /v1/health, never spends budget', async () => {
  const w = createWorld();
  const healthBody = { ok: true, tcgcsv: { lastSyncAt: '2026-11-09T00:00:00Z' } };
  w.responders.pricing = () => jsonResponse(healthBody);
  const res = await w.send('/pricing/v1/health', { key: null, instance: null });
  eq([res.status, await readJson(res)], [200, healthBody]);
  const call = lastUpstream(w, PRICING);
  eq([call.url, call.method, call.headers['x-fill-policy']], [PRICING + '/v1/health', 'GET', 'none']);
  eq(res.headers.get('x-quota-remaining'), null, 'anonymous calls carry no daily quota');
  eq((await w.send('/pricing/v1/health', { method: 'POST', key: null, instance: null })).status, 405);
});

test('pricing health: licence and app-key callers may reach it too; catalog health stays closed', async () => {
  const w = await createAppWorld();
  eq((await w.send('/pricing/v1/health')).status, 200, 'licence');
  eq((await w.send('/pricing/v1/health', { key: APP_KEY, instance: null })).status, 200, 'app key');
  eq((await w.send('/catalog/v1/health', { key: null, instance: null })).status, 401);
});

test('pricing health: an unreachable pricing origin is a 502 the alert can see', async () => {
  const w = createWorld();
  w.responders.pricing = () => new Response('boom', { status: 503 });
  eq((await w.send('/pricing/v1/health', { key: null, instance: null })).status, 502);
});

test('pricing health: anonymous calls are per-IP limited by the public binding', async () => {
  const limiter = fakeRateLimiter(1);
  const w = createWorld({ RATE_LIMIT_PUBLIC: limiter });
  const headers = { 'cf-connecting-ip': '9.9.9.9' };
  eq((await w.send('/pricing/v1/health', { key: null, instance: null, headers })).status, 200);
  eq((await w.send('/pricing/v1/health', { key: null, instance: null, headers })).status, 429);
});

// ---------- G4: Cloudflare Access service-token headers ----------

const ACCESS_ENV = { ACCESS_CLIENT_ID: 'access-id.access', ACCESS_CLIENT_SECRET: 'access-secret' };

test('access: with both secrets set, every forwarded request carries the service-token headers', async () => {
  const w = createWorld(ACCESS_ENV);
  await w.send('/pricing/v1/prices/quote', { method: 'POST', body: [] });
  await w.send('/catalog/v1/products/1');
  await w.send('/pricing/v1/health', { key: null, instance: null });
  const upstream = w.calls.filter((c) => c.url.startsWith(PRICING) || c.url.startsWith(CATALOG));
  eq(upstream.length, 3);
  for (const call of upstream) {
    eq([call.headers['cf-access-client-id'], call.headers['cf-access-client-secret']], ['access-id.access', 'access-secret'], call.url);
  }
});

test('access: Polar calls never carry the service token', async () => {
  const w = createWorld(ACCESS_ENV);
  await w.send('/v1/license');
  const polarCall = w.polarCalls('validate')[0];
  eq([polarCall.headers['cf-access-client-id'], polarCall.headers['cf-access-client-secret']], [undefined, undefined]);
});

test('access: a client cannot supply or override the service-token headers', async () => {
  const forged = { 'cf-access-client-id': 'forged', 'cf-access-client-secret': 'forged' };
  let w = createWorld(ACCESS_ENV);
  await w.send('/catalog/v1/products/1', { headers: forged });
  eq(lastUpstream(w, CATALOG).headers['cf-access-client-id'], 'access-id.access');
  w = createWorld();
  await w.send('/catalog/v1/products/1', { headers: forged });
  eq(lastUpstream(w, CATALOG).headers['cf-access-client-id'], undefined, 'before the lock, nothing is sent');
});

test('access: only one of the two secrets set is a 503, logged, with no upstream call', async () => {
  for (const env of [{ ACCESS_CLIENT_ID: 'id-only' }, { ACCESS_CLIENT_SECRET: 'secret-only' }]) {
    const w = createWorld(env);
    const res = await w.send('/catalog/v1/products/1');
    eq([res.status, await readJson(res)], [503, { error: 'origin_not_configured' }]);
    eq(w.calls.filter((c) => c.url.startsWith(CATALOG)).length, 0);
    ok(w.logs.some(([event]) => event === 'access_misconfigured'));
    ok(!JSON.stringify(w.logs).includes('secret-only'), 'the secret is never logged');
  }
});

// ---------- G5: public sessions, edge cache, per-item quote cache ----------

const SITE = 'https://poke-guide.com';
const PREVIEW = 'https://dyzfunkshin.github.io';
const SESSION_ENV = { TURNSTILE_SECRET_KEY: 'turnstile-secret', SESSION_SIGNING_KEY: 'signing-key-0123456789abcdef', RATE_LIMIT_PUBLIC: undefined };

// A Cache API stand-in that honours max-age against the world clock.
function createFakeCache(clock) {
  const store = new Map();
  return {
    store,
    async match(url) {
      const entry = store.get(String(url));
      if (!entry) return undefined;
      if (entry.expiresAt <= clock.t) {
        store.delete(String(url));
        return undefined;
      }
      return new Response(entry.body.slice(0), { status: 200, headers: entry.headers });
    },
    async delete(url) { return store.delete(String(url)); },
    async put(url, response) {
      const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1] ?? 0);
      store.set(String(url), { body: await response.arrayBuffer(), headers: Object.fromEntries(response.headers), expiresAt: clock.t + maxAge * 1000 });
    },
  };
}

// A world with the poke-guide client, a fake edge cache, Turnstile, and a pricing origin
// that answers a quote item by item (so merges can be checked).
function createPublicWorld(envOverrides = {}) {
  const w = createWorld({ ...SESSION_ENV, ...envOverrides });
  w.cache = createFakeCache(w.clock);
  w.deps.cache = w.cache;
  w.turnstile = { success: true, hostname: 'poke-guide.com', action: 'gateway-session' };
  w.siteverifyCalls = [];
  const innerFetch = w.deps.fetch;
  w.deps.fetch = async (url, init = {}) => {
    if (String(url) === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      w.siteverifyCalls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      if (w.turnstile === 'down') return new Response('nope', { status: 500 });
      return jsonResponse({ success: w.turnstile.success, hostname: w.turnstile.hostname, ...(w.turnstile.action === undefined ? {} : { action: w.turnstile.action }), 'error-codes': w.turnstile.success ? [] : ['invalid-input-response'] });
    }
    return innerFetch(url, init);
  };
  w.responders.pricing = (call) => {
    if (call.url.includes('/v1/prices/quote')) {
      const items = JSON.parse(call.body);
      return jsonResponse({ data: items.map((item) => ({ productId: item.productId ?? null, skuId: item.skuId ?? null, market: 1.5, condition: item.condition ?? null })) });
    }
    return jsonResponse({ data: [{ ok: 1 }] }, 200, { etag: '"p1"' });
  };
  w.issue = async (origin = SITE, ip = '1.1.1.1') => {
    const res = await w.send('/v1/session', { method: 'POST', key: null, instance: null, origin, body: { turnstileToken: 'widget-token' }, headers: { 'cf-connecting-ip': ip } });
    return res.status === 200 ? (await readJson(res)).token : res;
  };
  w.publicSend = (path, token, { origin = SITE, ip = '1.1.1.1', ...options } = {}) =>
    w.send(path, { key: null, instance: null, origin, ...options, headers: { authorization: 'Session ' + token, 'cf-connecting-ip': ip, ...(options.headers || {}) } });
  w.originCalls = (origin) => w.calls.filter((c) => c.url.startsWith(origin));
  return w;
}

test('session: a Turnstile proof from an allowed origin buys a signed 30-minute token', async () => {
  const w = createPublicWorld();
  const res = await w.send('/v1/session', { method: 'POST', key: null, instance: null, origin: SITE, body: { turnstileToken: 'widget-token' }, headers: { 'cf-connecting-ip': '1.1.1.1' } });
  eq(res.status, 200);
  const body = await readJson(res);
  eq([body.ttlSeconds, body.expiresAt], [1800, new Date(T0 + 1800 * 1000).toISOString()]);
  ok(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.token));
  eq(res.headers.get('cache-control'), 'no-store');
  eq(res.headers.get('access-control-allow-origin'), SITE);
  eq(w.siteverifyCalls, [{ secret: 'turnstile-secret', response: 'widget-token', remoteip: '1.1.1.1' }]);
});

test('session: the preview origin works when Turnstile reports its hostname', async () => {
  const w = createPublicWorld();
  w.turnstile = { success: true, hostname: 'dyzfunkshin.github.io', action: 'gateway-session' };
  ok(typeof (await w.issue(PREVIEW)) === 'string');
});

test('session: refused for a foreign or look-alike origin before Turnstile is asked', async () => {
  const w = createPublicWorld();
  for (const origin of ['https://evil.example', 'https://poke-guide.com.evil.example', 'http://poke-guide.com', null]) {
    const res = await w.send('/v1/session', { method: 'POST', key: null, instance: null, origin, body: { turnstileToken: 't' } });
    eq([res.status, await readJson(res)], [403, { error: 'origin_not_allowed' }], String(origin));
  }
  eq(w.siteverifyCalls.length, 0);
});

test('session: failed Turnstile, wrong hostname, Turnstile down, bad body, missing secrets', async () => {
  let w = createPublicWorld();
  w.turnstile = { success: false, hostname: 'poke-guide.com' };
  let res = await w.issue();
  eq([res.status, await readJson(res)], [403, { error: 'turnstile_failed' }]);
  w.turnstile = { success: true, hostname: 'evil.example' };
  res = await w.issue();
  eq([res.status, await readJson(res)], [403, { error: 'turnstile_failed' }], 'a widget solved on another site does not count');
  w.turnstile = 'down';
  res = await w.issue();
  eq([res.status, res.headers.get('retry-after')], [503, '5']);
  res = await w.send('/v1/session', { method: 'POST', key: null, instance: null, origin: SITE, body: { nope: 1 } });
  eq(res.status, 400);
  for (const missing of ['TURNSTILE_SECRET_KEY', 'SESSION_SIGNING_KEY']) {
    w = createPublicWorld({ [missing]: '' });
    res = await w.issue();
    eq([res.status, await readJson(res)], [503, { error: 'session_not_configured' }], missing);
    ok(!JSON.stringify(w.logs).includes('turnstile-secret') && !JSON.stringify(w.logs).includes('signing-key-0123'));
  }
});

test('session: the Turnstile action must match the client (allow, wrong, missing)', async () => {
  let w = createPublicWorld();
  let res = await w.issue();
  eq(typeof res, 'string', 'matching action buys a session token');
  w = createPublicWorld();
  w.turnstile = { success: true, hostname: 'poke-guide.com', action: 'some-other-widget' };
  res = await w.issue();
  eq([res.status, await readJson(res)], [403, { error: 'turnstile_failed' }], 'wrong action');
  ok(w.logs.some((l) => JSON.stringify(l).includes('action mismatch')), 'reason logged server-side');
  w = createPublicWorld();
  w.turnstile = { success: true, hostname: 'poke-guide.com' };
  res = await w.issue();
  eq([res.status, await readJson(res)], [403, { error: 'turnstile_failed' }], 'missing action');
});

test('policy table: public rows need a valid turnstileAction', async () => {
  const base = DEFAULT_CLIENTS.publicSessions[0];
  eq(base.turnstileAction, 'gateway-session');
  const { turnstileAction, ...without } = base;
  for (const row of [without, { ...base, turnstileAction: '' }, { ...base, turnstileAction: 'has space' }, { ...base, turnstileAction: 'x'.repeat(33) }, { ...base, turnstileAction: 5 }]) {
    let threw = false;
    try { assertValidClients({ ...DEFAULT_CLIENTS, publicSessions: [row] }); } catch { threw = true; }
    ok(threw, JSON.stringify(row.turnstileAction));
  }
  assertValidClients({ ...DEFAULT_CLIENTS, publicSessions: [{ ...base, turnstileAction: 'abc_DEF-123' }] });
});

test('session token: works from another IP (not IP-bound), only from its own origin, until it expires', async () => {
  const w = createPublicWorld();
  const token = await w.issue(SITE, '1.1.1.1');
  eq((await w.publicSend('/catalog/v1/manifest.json', token, { ip: '2.2.2.2' })).status, 200, 'a phone that changes IP keeps its session');
  let res = await w.publicSend('/catalog/v1/manifest.json', token, { origin: PREVIEW });
  eq([res.status, await readJson(res)], [401, { error: 'session_invalid' }], 'a token is bound to the origin it was issued for');
  res = await w.publicSend('/catalog/v1/manifest.json', token, { origin: null });
  eq(res.status, 401);
  w.clock.t += 1800 * 1000;
  res = await w.publicSend('/catalog/v1/manifest.json', token);
  eq([res.status, await readJson(res)], [401, { error: 'session_expired' }]);
});

test('session token: tampered, foreign-key and malformed tokens are 401 session_invalid', async () => {
  const w = createPublicWorld();
  const token = await w.issue();
  const [version, payload, signature] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ c: 'poke-guide', o: SITE, e: T0 + 10 ** 12 })).toString('base64url');
  const other = createPublicWorld({ SESSION_SIGNING_KEY: 'a-different-signing-key-000000' });
  const foreignToken = await other.issue();
  for (const bad of [`${version}.${forgedPayload}.${signature}`, `${version}.${payload}.${signature.slice(0, -2)}AA`, foreignToken, 'v1.x', 'v2.' + payload + '.' + signature, 'garbage']) {
    const res = await w.publicSend('/catalog/v1/manifest.json', bad);
    eq([res.status, await readJson(res)], [401, { error: 'session_invalid' }], bad.slice(0, 20));
  }
  eq(w.originCalls(CATALOG).length, 0);
});

test('log session_expired and session_invalid origin mismatch: each logs once with reason and ip', async () => {
  const w = createPublicWorld();
  const token = await w.issue(SITE, '1.1.1.1');
  await w.publicSend('/catalog/v1/manifest.json', token, { origin: PREVIEW, ip: '6.6.6.6' });
  const invalid = eventsNamed(w, 'session_invalid');
  eq([invalid.length, invalid[0].reason, invalid[0].ip], [1, 'origin mismatch', '6.6.6.6']);
  eq(eventsNamed(w, 'session_expired').length, 0);
  w.clock.t += 1800 * 1000;
  await w.publicSend('/catalog/v1/manifest.json', token, { ip: '6.6.6.6' });
  const expired = eventsNamed(w, 'session_expired');
  eq([expired.length, expired[0].client, expired[0].ip], [1, 'poke-guide', '6.6.6.6']);
  eq(eventsNamed(w, 'session_invalid').length, 1, 'expiry is its own event, not session_invalid');
  ok(!JSON.stringify(w.logs).includes(token));
});

test('log session_refused: origin_not_allowed, bad body and failed Turnstile each log once with a reason', async () => {
  const w = createPublicWorld();
  const post = (origin, body) => w.send('/v1/session', { method: 'POST', key: null, instance: null, origin, body, headers: { 'cf-connecting-ip': '7.7.7.7' } });
  eq((await post('https://evil.example', { turnstileToken: 'SECRET-TS' })).status, 403);
  let events = eventsNamed(w, 'session_refused');
  eq([events.length, events[0].reason, events[0].ip], [1, 'origin_not_allowed', '7.7.7.7']);
  eq((await post(SITE, { nope: 1 })).status, 400);
  events = eventsNamed(w, 'session_refused');
  eq([events.length, events[1].reason, events[1].client], [2, 'bad body', 'poke-guide']);
  w.turnstile = { success: false, hostname: 'poke-guide.com', action: 'gateway-session' };
  eq((await post(SITE, { turnstileToken: 'SECRET-TS' })).status, 403);
  events = eventsNamed(w, 'session_refused');
  eq([events.length, events[2].reason], [3, 'turnstile']);
  w.turnstile = { success: true, hostname: 'poke-guide.com', action: 'gateway-session' };
  eq((await post(SITE, { turnstileToken: 'widget-token' })).status, 200);
  eq(eventsNamed(w, 'session_refused').length, 3, 'a successful exchange logs no refusal');
  ok(!JSON.stringify(w.logs).includes('SECRET-TS'));
});

test('log request_rejected: batch_too_large and payload_too_large each log once', async () => {
  const w = await createAppWorld({ maxQuoteItems: 2 });
  await w.send('/pricing/v1/prices/quote', { method: 'POST', body: [{ productId: 1 }, { productId: 2 }], key: APP_KEY, instance: null });
  eq(eventsNamed(w, 'request_rejected').length, 0);
  await w.send('/pricing/v1/prices/quote', { method: 'POST', body: [{ productId: 1 }, { productId: 2 }, { productId: 3 }], key: APP_KEY, instance: null, headers: { 'cf-connecting-ip': '8.8.8.8' } });
  let events = eventsNamed(w, 'request_rejected');
  eq(events.length, 1);
  eq([events[0].reason, events[0].route, events[0].client, events[0].ip, events[0].count, events[0].max], ['batch_too_large', 'pricing:quote', 'test-backend', '8.8.8.8', 3, 2]);
  const res = await w.send('/pricing/v1/prices/quote', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), key: APP_KEY, instance: null });
  eq(res.status, 413);
  events = eventsNamed(w, 'request_rejected');
  eq([events.length, events[1].reason], [2, 'payload_too_large']);
});

test('log sweep: no deny-path event ever carries a raw licence key, app key, session token, Turnstile token or Authorization header', async () => {
  const FAKE_LICENSE = 'FAKELICENSEKEY-9f8e7d6c5b4a';
  const FAKE_APP = 'fakeappkey' + 'e'.repeat(54);
  const FAKE_SESSION = 'v1.FAKESESSIONPAYLOAD.FAKESESSIONSIG';
  const FAKE_TURNSTILE = 'FAKE-TURNSTILE-TOKEN-xyz';
  const secrets = [FAKE_LICENSE, FAKE_APP, FAKE_SESSION, FAKE_TURNSTILE, 'FAKESESSIONPAYLOAD', 'Bearer ', 'Session '];
  const allLogs = [];

  const pub = createPublicWorld({ RATE_LIMIT_SESSION: fakeRateLimiter(0) });
  pub.turnstile = { success: false, hostname: 'poke-guide.com', action: 'gateway-session' };
  const session = (origin, body) => pub.send('/v1/session', { method: 'POST', key: null, instance: null, origin, body, headers: { 'cf-connecting-ip': '1.2.3.4' } });
  await session(SITE, { turnstileToken: FAKE_TURNSTILE });
  await session('https://evil.example', { turnstileToken: FAKE_TURNSTILE });
  await session(SITE, { turnstileToken: 7 });
  await pub.publicSend('/catalog/v1/manifest.json', FAKE_SESSION);
  await pub.send('/pricing/v1/games', { key: null, instance: null, origin: SITE, headers: { authorization: 'Session ' + FAKE_SESSION, 'cf-connecting-ip': '1.2.3.4' } });
  allLogs.push(...pub.logs);

  const lic = createWorld({ DAILY_QUOTA: '1', RATE_LIMIT_LICENSE_ATTEMPTS: fakeRateLimiter(0) });
  lic.responders.validate = () => jsonResponse(notFound('License key does not exist.'), 404);
  await lic.send('/v1/license', { key: FAKE_LICENSE, instance: null });
  await lic.send('/v1/license', { key: null, headers: { authorization: 'Basic ' + FAKE_LICENSE } });
  await lic.send('/v1/license', { key: FAKE_LICENSE, headers: { 'cf-connecting-ip': '1.2.3.4' } });
  allLogs.push(...lic.logs);

  const quota = createWorld({ DAILY_QUOTA: '1' });
  await quota.send('/v1/license', { key: FAKE_LICENSE });
  await quota.send('/v1/license', { key: FAKE_LICENSE });
  allLogs.push(...quota.logs);

  const app = await createAppWorld({ maxQuoteItems: 1 }, { RATE_LIMIT_APP: fakeRateLimiter(1) });
  app.deps.clients = { ...app.deps.clients, appKeys: [{ ...app.deps.clients.appKeys[0], keySha256: await sha256Hex(FAKE_APP) }] };
  await app.send('/pricing/v1/prices/quote', { method: 'POST', body: [{ productId: 1 }, { productId: 2 }], key: FAKE_APP, instance: null });
  await app.send('/catalog/v1/manifest.json', { key: FAKE_APP, instance: null });
  await app.send('/catalog/v1/manifest.json', { key: FAKE_APP, instance: null });
  allLogs.push(...app.logs);

  const names = new Set(allLogs.map(([event]) => event));
  for (const expected of ['session_refused', 'session_invalid', 'credential_invalid', 'rate_limited', 'request_rejected']) ok(names.has(expected), 'sweep exercised ' + expected);
  const serialized = JSON.stringify(allLogs);
  for (const secret of secrets) ok(!serialized.includes(secret), 'log contains ' + secret);
});

test('public policy: reads only, quote forced to fill none and capped at 100, no writes or lookups', async () => {
  const w = createPublicWorld();
  const token = await w.issue();
  for (const [path, method] of [['/catalog/v1/products:lookup', 'POST'], ['/catalog/v1/tags/mew%7C25', 'POST'], ['/catalog/v1/tags', 'GET'], ['/v1/license', 'GET']]) {
    const res = await w.publicSend(path, token, { method, body: method === 'POST' ? {} : undefined });
    eq([res.status, await readJson(res)], [403, { error: 'forbidden' }], path);
  }
  let res = await w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: [{ productId: 1 }], headers: { 'x-fill-policy': 'default' } });
  eq(res.status, 200);
  eq(w.originCalls(PRICING).at(-1).headers['x-fill-policy'], 'none');
  res = await w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: Array.from({ length: 101 }, (_, i) => ({ productId: i + 1 })) });
  eq([res.status, await readJson(res)], [413, { error: 'batch_too_large', max: 100 }]);
});

test('public calls are per-IP limited by the session binding (allow, deny, another IP allowed)', async () => {
  const limiter = fakeRateLimiter(2);
  const w = createPublicWorld({ RATE_LIMIT_SESSION: limiter });
  const token = await w.issue();
  eq((await w.publicSend('/pricing/v1/games', token, { ip: '3.3.3.3' })).status, 200);
  eq((await w.publicSend('/pricing/v1/games', token, { ip: '3.3.3.3' })).status, 200);
  eq((await w.publicSend('/pricing/v1/games', token, { ip: '3.3.3.3' })).status, 429);
  eq((await w.publicSend('/pricing/v1/games', (w.clock.t += 1000, await w.issue(SITE, '4.4.4.4')), { ip: '4.4.4.4' })).status, 200);
  eq(limiter.keys.filter((k) => k.startsWith('ip:')), ['ip:3.3.3.3', 'ip:3.3.3.3', 'ip:3.3.3.3', 'ip:4.4.4.4']);
});

test('public calls are also limited per session token: one token rotating IPs is refused (deny), separate tokens are not (allow)', async () => {
  const limiter = fakeRateLimiter(2);
  const w = createPublicWorld({ RATE_LIMIT_SESSION: limiter });
  const token = await w.issue();
  eq((await w.publicSend('/pricing/v1/games', token, { ip: '5.0.0.1' })).status, 200);
  eq((await w.publicSend('/pricing/v1/games', token, { ip: '5.0.0.2' })).status, 200);
  const res = await w.publicSend('/pricing/v1/games', token, { ip: '5.0.0.3' });
  eq([res.status, res.headers.get('retry-after')], [429, '60']);
  const event = eventsNamed(w, 'rate_limited').at(-1);
  eq([event.subjectKind, event.subject.length, event.limiter], ['session', 16, 'RATE_LIMIT_SESSION']);
  const sessionKeys = limiter.keys.filter((k) => k.startsWith('session:'));
  eq(new Set(sessionKeys).size, 1);
  ok(!sessionKeys[0].includes(token) && !JSON.stringify(w.logs).includes(token), 'the token itself is never a key or logged');
  eq((await w.publicSend('/pricing/v1/games', (w.clock.t += 1000, await w.issue(SITE, '5.0.0.4')), { ip: '5.0.0.4' })).status, 200, 'a different token is its own budget');
});

test('ipLimiterKey: IPv4 as is; IPv6 on its /64 in every spelling; mapped IPv4 as IPv4', async () => {
  eq(ipLimiterKey('9.9.9.9'), 'ip:9.9.9.9');
  eq(ipLimiterKey('unknown'), 'ip:unknown');
  const prefix = 'ip:2001:db8:aa:bb::/64';
  for (const ip of ['2001:db8:aa:bb::1', '2001:0db8:00aa:00bb:ffff:1:2:3', '2001:DB8:AA:BB:0:0:0:9', '2001:db8:aa:bb:1::', '2001:db8:aa:bb::1.2.3.4', '2001:db8:aa:bb::1%eth0']) eq(ipLimiterKey(ip), prefix, ip);
  eq(ipLimiterKey('2001:db8:aa:bc::1'), 'ip:2001:db8:aa:bc::/64', 'a different /64 is a different key');
  eq(ipLimiterKey('2001:db8::1'), 'ip:2001:db8:0:0::/64');
  eq(ipLimiterKey('::1'), 'ip:0:0:0:0::/64');
  eq(ipLimiterKey('::ffff:1.2.3.4'), 'ip:1.2.3.4');
  for (const bad of ['1::2::3', '2001:db8:1:2:3:4:5:6:7', 'gggg::1', '1:2:3:4:5:6:7']) eq(ipLimiterKey(bad), 'ip:' + bad, 'unparsable is verbatim: ' + bad);
});

test('per-IP limits key IPv6 on the /64: rotating within it is refused (deny), another /64 is not (allow)', async () => {
  const limiter = fakeRateLimiter(2);
  const w = createWorld({ RATE_LIMIT_PUBLIC: limiter });
  const health = (ip) => w.send('/v1/health', { key: null, instance: null, headers: { 'cf-connecting-ip': ip } });
  eq((await health('2001:db8:1:2::a')).status, 200);
  eq((await health('2001:db8:1:2::b')).status, 200);
  eq((await health('2001:db8:1:2:ffff::c')).status, 429);
  eq((await health('2001:db8:1:3::a')).status, 200);
  const attempts = fakeRateLimiter(1);
  const lic = createWorld({ RATE_LIMIT_LICENSE_ATTEMPTS: attempts });
  eq((await lic.send('/v1/license', { key: 'random-key-a', headers: { 'cf-connecting-ip': '2001:db8:9:9::1' } })).status, 200);
  eq((await lic.send('/v1/license', { key: 'random-key-b', headers: { 'cf-connecting-ip': '2001:db8:9:9::2' } })).status, 429, 'the licence flood guard shares the /64 key');
  eq(attempts.keys, ['ip:2001:db8:9:9::/64', 'ip:2001:db8:9:9::/64']);
});

test('edge cache: repeated public GETs reach the origin once, until the TTL runs out', async () => {
  const w = createPublicWorld();
  const token = await w.issue();
  const path = '/catalog/v1/artifacts/pokemon.0123abcd.json';
  for (let i = 0; i < 50; i += 1) {
    const res = await w.publicSend(path, token, { ip: `10.0.0.${i}` });
    eq(res.status, 200);
    eq(res.headers.get('x-gateway-cache'), i === 0 ? 'miss' : 'hit');
    eq(res.headers.get('etag'), '"cat"');
    eq(res.headers.get('cache-control'), 'public, max-age=31536000');
  }
  eq(w.originCalls(CATALOG).length, 1, '50 requests, one origin call');
  await w.publicSend('/catalog/v1/manifest.json', token);
  w.clock.t += 61 * 1000;
  const fresh = await w.issue();
  eq((await w.publicSend('/catalog/v1/manifest.json', fresh)).headers.get('x-gateway-cache'), 'miss', 'the manifest is kept only 60 s');
  eq((await w.publicSend(path, fresh)).headers.get('x-gateway-cache'), 'hit', 'the artifact is still cached');
});

test('edge cache: streams GET bodies through, and still stores the full body via waitUntil', async () => {
  const w = createPublicWorld();
  const token = await w.issue();
  const path = '/catalog/v1/artifacts/pokemon.0123abcd.json';
  const text = JSON.stringify({ big: 'x'.repeat(5000) });
  let arrayBufferCalled = false;
  w.responders.catalog = () => {
    const chunks = [text.slice(0, 2000), text.slice(2000)];
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json', etag: '"big"' } },
    );
    upstream.arrayBuffer = async () => {
      arrayBufferCalled = true;
      throw new Error('upstream body was buffered');
    };
    return upstream;
  };
  const miss = await w.publicSend(path, token);
  eq(miss.status, 200);
  eq(miss.headers.get('x-gateway-cache'), 'miss');
  eq(miss.headers.get('content-type'), 'application/json');
  ok(!(miss.headers.get('cache-control') || '').includes('no-transform'), 'never no-transform');
  ok(miss.body instanceof ReadableStream);
  eq(await miss.text(), text);
  eq(arrayBufferCalled, false, 'upstream body is never read to an ArrayBuffer');
  const stored = w.cache.store.get([...w.cache.store.keys()].find((key) => key.includes('pokemon.0123abcd')));
  eq(new TextDecoder().decode(stored.body), text, 'full body reached the cache');
  eq(stored.headers['content-type'], 'application/json');
  const hit = await w.publicSend(path, token);
  eq(hit.headers.get('x-gateway-cache'), 'hit');
  eq(await hit.text(), text);
  eq(hit.headers.get('etag'), '"big"');
  ok(!(hit.headers.get('cache-control') || '').includes('no-transform'));
  eq(w.originCalls(CATALOG).length, 1);
});

test('edge cache: query strings are part of the key; errors are never cached', async () => {
  const w = createPublicWorld();
  const token = await w.issue();
  await w.publicSend('/pricing/v1/history?game=pokemon&productId=1', token);
  eq((await w.publicSend('/pricing/v1/history?game=pokemon&productId=2', token)).headers.get('x-gateway-cache'), 'miss');
  w.responders.catalog = () => jsonResponse({ error: 'not_found' }, 404);
  eq((await w.publicSend('/catalog/v1/products/9', token)).status, 404);
  w.responders.catalog = () => jsonResponse({ product: 9 });
  const res = await w.publicSend('/catalog/v1/products/9', token);
  eq([res.status, res.headers.get('x-gateway-cache')], [200, 'miss'], 'the 404 was not stored');
});

test('edge cache: licence and anonymous traffic never reads or writes it', async () => {
  const w = createPublicWorld();
  await w.send('/catalog/v1/products/1');
  await w.send('/catalog/v1/products/1');
  await w.send('/pricing/v1/health', { key: null, instance: null });
  eq(w.cache.store.size, 0);
  eq(w.originCalls(CATALOG).length, 2);
});

test('quote cache: items are cached one by one; only misses reach pricing; order is kept', async () => {
  const w = createPublicWorld();
  const token = await w.issue();
  const quote = (items) => w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: items });
  const A = { productId: 1, condition: 'Near Mint', printing: 'Holofoil' };
  const B = { productId: 2 };
  const C = { skuId: 555 };
  let res = await quote([A, B]);
  eq(res.headers.get('x-gateway-cache'), 'miss');
  res = await quote([B, C, A]);
  eq(res.headers.get('x-gateway-cache'), 'partial');
  eq((await readJson(res)).data.map((q) => [q.productId, q.skuId]), [[2, null], [null, 555], [1, null]]);
  eq(JSON.parse(w.originCalls(PRICING).at(-1).body), [C], 'only the miss was forwarded');
  res = await quote([C, A, B]);
  eq(res.headers.get('x-gateway-cache'), 'hit');
  eq(w.originCalls(PRICING).length, 2, 'an all-hit batch never reaches pricing');
  res = await quote([{ ...A, condition: 'near mint' }]);
  eq(res.headers.get('x-gateway-cache'), 'miss', 'selectors are keyed exactly as pricing receives them (no case folding)');
  w.clock.t += 3601 * 1000;
  const fresh = await w.issue();
  res = await w.publicSend('/pricing/v1/prices/quote', fresh, { method: 'POST', body: [A] });
  eq(res.headers.get('x-gateway-cache'), 'miss', 'items expire after an hour');
});

test('quote cache: unusual items always go to pricing; a short or failed answer is not merged', async () => {
  const w = createPublicWorld();
  const token = await w.issue();
  const odd = [{ productId: 1, extra: true }, { productId: 1, skuId: 2 }, { condition: 'Near Mint' }, { productId: '1' }];
  await w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: odd });
  await w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: odd });
  eq(JSON.parse(w.originCalls(PRICING).at(-1).body), odd, 'uncacheable items are forwarded every time');
  eq(w.cache.store.size, 0);
  w.responders.pricing = () => jsonResponse({ data: [] });
  let res = await w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: [{ productId: 7 }] });
  eq(res.status, 502);
  ok(w.logs.some(([event]) => event === 'quote_shape_mismatch'));
  w.responders.pricing = () => jsonResponse({ error: 'bad' }, 400);
  res = await w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: [{ productId: 7 }] });
  eq(res.status, 400, 'a pricing 4xx passes through');
  eq(w.cache.store.size, 0);
});

// Pricing's real semantics (cascade.js): game is String(it.game) matched exactly; "" or absent
// means pokemon. So " " and "POKEMON" are different questions with a null answer.
function pricingLikeQuote(w) {
  w.responders.pricing = (call) => {
    const items = JSON.parse(call.body);
    return jsonResponse({ data: items.map((it) => {
      const game = (it.game != null ? String(it.game) : '') || 'pokemon';
      return { productId: it.productId ?? null, game, market: ['pokemon', 'pokemon-japan'].includes(game) ? 12.34 : null };
    }) });
  };
}

test('quote cache poisoning (regression): a non-canonical game never answers the canonical question', async () => {
  const w = createPublicWorld();
  pricingLikeQuote(w);
  const token = await w.issue();
  const quote = (items) => w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: items });
  await quote([{ productId: 42, game: ' ' }]);
  let res = await quote([{ productId: 42 }]);
  eq([res.headers.get('x-gateway-cache'), (await readJson(res)).data[0].market], ['miss', 12.34], 'whitespace game did not poison the absent-game key');
  await quote([{ productId: 43, game: 'POKEMON' }]);
  res = await quote([{ productId: 43, game: 'pokemon' }]);
  eq([res.headers.get('x-gateway-cache'), (await readJson(res)).data[0].market], ['miss', 12.34], 'upper-case game did not poison the canonical key');
});

test('quote cache: canonical items are cached (allow); non-canonical selectors and priceless answers are not (deny)', async () => {
  const w = createPublicWorld();
  pricingLikeQuote(w);
  const token = await w.issue();
  const quote = (items) => w.publicSend('/pricing/v1/prices/quote', token, { method: 'POST', body: items });
  const canonical = [{ productId: 1, game: 'pokemon' }, { productId: 2, condition: 'Near Mint', printing: 'Reverse Holofoil' }, { skuId: 3, game: 'pokemon-japan' }];
  await quote(canonical);
  eq((await quote(canonical)).headers.get('x-gateway-cache'), 'hit');
  const before = w.originCalls(PRICING).length;
  const odd = [{ productId: 1, game: 'Pokemon' }, { productId: 1, game: '' }, { productId: 1, condition: ' Near Mint' }, { productId: 1, printing: 'Holo\u0000' }, { productId: 1, condition: 'Near  Mint' }];
  await quote(odd);
  await quote(odd);
  eq(w.originCalls(PRICING).length, before + 2, 'non-canonical items reach pricing every time');
  eq(JSON.parse(w.originCalls(PRICING).at(-1).body), odd, 'and are forwarded verbatim');
  const size = w.cache.store.size;
  await quote([{ productId: 9, game: 'onepiececardgame' }]); // canonical, but pricing has no price
  eq(w.cache.store.size, size, 'an answer with market null is never stored');
  eq((await quote([{ productId: 9, game: 'onepiececardgame' }])).headers.get('x-gateway-cache'), 'miss');
});

test('CORS: site origins match exactly, extension schemes by prefix', async () => {
  const origins = corsOriginsOf(DEFAULT_CLIENTS);
  eq(corsHeaders(SITE, origins)['Access-Control-Allow-Origin'], SITE);
  eq(corsHeaders(PREVIEW, origins)['Access-Control-Allow-Origin'], PREVIEW);
  eq(corsHeaders('https://poke-guide.com.evil.example', origins), {});
  eq(corsHeaders('https://poke-guide.com:8443', origins), {});
  eq(corsHeaders('chrome-extension://anything', origins)['Access-Control-Allow-Origin'], 'chrome-extension://anything');
});

test('policy table: public and cached rows must be budget-free, read-only, exact-origin', async () => {
  const base = DEFAULT_CLIENTS.publicSessions[0];
  const bad = [
    { ...base, fillPolicy: 'default' },
    { ...base, routes: [...base.routes, 'catalog:tags.write'] },
    { ...base, maxQuoteItems: null },
    { ...base, origins: ['https://poke-guide.com/'] },
    { ...base, origins: ['http://poke-guide.com'] },
    { ...base, origins: ['chrome-extension://'] },
    { ...base, cache: { 'catalog:tags': 60 } },
    { ...base, quota: { daily: null, perMinute: 1, perMinuteBinding: null } },
  ];
  for (const row of bad) {
    let threw = false;
    try { assertValidClients({ ...DEFAULT_CLIENTS, publicSessions: [row] }); } catch { threw = true; }
    ok(threw, JSON.stringify(row).slice(0, 80));
  }
  let threw = false;
  const cachingApp = { id: 'x', auth: 'app-key', keySha256: '0'.repeat(64), routes: ['pricing:games'], fillPolicy: 'default', quota: {}, origins: [], cache: { 'pricing:games': 60 } };
  try { assertValidClients({ ...DEFAULT_CLIENTS, appKeys: [cachingApp] }); } catch { threw = true; }
  ok(threw, 'a client that may spend budget may not share the edge cache');
});

// ---------- runner ----------

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
  } catch (error) {
    failures += 1;
    console.error('FAIL: ' + name);
    console.error(error && error.stack ? error.stack : error);
  }
}
if (failures > 0) {
  console.error(`tcg-api-gateway: ${failures} of ${tests.length} tests failed`);
  process.exitCode = 1; // never process.exit(): Windows teardown aborts libuv
} else {
  console.log(`tcg-api-gateway: ${checkCount} checks passed`);
}
