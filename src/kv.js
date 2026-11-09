// Tiny helpers over a Cloudflare KV namespace binding.
//
// KV is eventually consistent, has no atomic increment, and the free plan allows only
// 1,000 writes a day across the account, so nothing here is written per request: the
// quota counters in worker.js are buffered in memory and flushed in batches.

// KV rejects expiration_ttl below 60 seconds.
const KV_MIN_TTL_SECONDS = 60;

const clampTtl = (ttlSeconds) => Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlSeconds));

export async function getJson(kv, key) {
  const raw = await kv.get(key);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function putJson(kv, key, value, ttlSeconds) {
  await kv.put(key, JSON.stringify(value), { expirationTtl: clampTtl(ttlSeconds) });
}

export async function deleteKey(kv, key) {
  await kv.delete(key);
}
