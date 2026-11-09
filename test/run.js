// Sourcery gateway tests. Plain node:assert, no dependencies.
// Run: node gateway/test/run.js   (exits non-zero on any failure)
import assert from 'node:assert/strict';
import { handle, licenseKeyFrom, corsHeaders, corsPrefixesOf, quotaKeys, resetQuotaMemory } from '../src/worker.js';
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
  const deps = { fetch: fetchImpl, now: () => clock.t, log: (...args) => logs.push(args) };
  const send = (path, options = {}) => handle(makeRequest(path, options), env, deps);
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

test('validate 404 plain is 401 license_invalid and the verdict is cached for LICENSE_CACHE_SECONDS', async () => {
  const w = createWorld();
  w.responders.validate = () => jsonResponse(notFound('License key not found'), 404);
  const res = await w.send('/v1/license');
  eq(res.status, 401);
  eq(await readJson(res), { error: 'license_invalid' });
  const cacheKeys = [...w.kv.store.keys()].filter((k) => k.startsWith('lic:'));
  eq(cacheKeys.length, 1);
  eq(w.kv.ttls.get(cacheKeys[0]), 600);
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
  eq(res.headers.get('access-control-expose-headers'), 'X-Quota-Remaining, Retry-After, ETag');
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
  const prefixes = corsPrefixesOf(DEFAULT_CLIENTS);
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

test('activate: success returns instance details and seeds the verdict cache', async () => {
  const w = createWorld();
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
  const seeded = [...w.kv.store.keys()].filter((k) => k.startsWith('lic:'));
  eq(seeded.length, 1);
  ok(!seeded[0].includes(KEY), 'cache key never contains the license key');
  eq(w.kv.ttls.get(seeded[0]), 86400);
  eq((await w.send('/v1/license')).status, 200);
  eq(w.polarCalls('validate').length, 0, 'first authed request uses the seeded verdict');
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
  const cacheKey = [...w.kv.store.keys()].find((k) => k.startsWith('lic:'));
  eq(JSON.parse(w.kv.store.get(cacheKey).value).tier, 'pro', 'the seeded verdict carries the tier');
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
