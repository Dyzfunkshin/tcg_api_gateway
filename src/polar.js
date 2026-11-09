// Polar license key API client (customer portal endpoints; public, no auth header).
//
// CONTRACT (verified against polar.sh/docs on 2026-11-05):
//
//   Base: env.POLAR_API_BASE (default https://api.polar.sh; the sandbox is
//   https://sandbox-api.polar.sh). JSON request and response bodies.
//
//   POST {base}/v1/customer-portal/license-keys/activate
//     body { key, organization_id, label, meta? }
//     200 -> { id, license_key_id, label, meta, created_at, modified_at,
//              license_key: { id, organization_id, customer_id, benefit_id, key,
//                             display_key, status: "granted", limit_activations, usage,
//                             limit_usage, validations, last_validated_at, expires_at } }
//         The activation id is the top-level `id`.
//     403 { error: "NotPermitted", detail } = key revoked, disabled or expired, key
//         does not support activations, or activation limit reached (no separate
//         code; the `detail` string is the only hint).
//     404 { error: "ResourceNotFound", detail } = key not found. 422 = validation error.
//
//   POST {base}/v1/customer-portal/license-keys/validate
//     body { key, organization_id, activation_id?, benefit_id?, conditions?, increment_usage? }
//     200 -> { id, organization_id, customer_id, benefit_id, key, display_key,
//              status: "granted", limit_activations, usage, limit_usage, validations,
//              last_validated_at, expires_at (null = never), activation: {id, label, ...}|null }
//         A 200 is the only "valid" signal; there is no `valid` boolean.
//     400 { error: "BadRequest" } = usage increment exceeded (we never send increment_usage).
//     404 { error: "ResourceNotFound", detail } = not found, revoked, disabled or expired,
//         or the activation is missing or does not match. 422 = validation error.
//
//   POST {base}/v1/customer-portal/license-keys/deactivate
//     body { key, organization_id, activation_id }
//     204 no body. 404 = key or activation not found.
//
// Every function resolves to { status, body } where `status` is the HTTP status
// and `body` the parsed JSON (null when the response was not JSON, e.g. a 204).
// Rejected keys come back as 4xx, so callers treat 4xx as an answer and only
// 5xx / 429 / a null body / a thrown error as "service unavailable".

const DEFAULT_BASE = 'https://api.polar.sh';
const PATH = '/v1/customer-portal/license-keys/';

async function call(action, fields, env, fetchImpl) {
  const base = String(env.POLAR_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const response = await fetchImpl(base + PATH + action, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fields),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  return { status: response.status, body, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
}

export function validate(key, activationId, env, fetchImpl = fetch) {
  return call('validate', { key, organization_id: env.POLAR_ORGANIZATION_ID, activation_id: activationId }, env, fetchImpl);
}

export function activate(key, label, env, fetchImpl = fetch) {
  return call('activate', { key, organization_id: env.POLAR_ORGANIZATION_ID, label }, env, fetchImpl);
}

export function deactivate(key, activationId, env, fetchImpl = fetch) {
  return call('deactivate', { key, organization_id: env.POLAR_ORGANIZATION_ID, activation_id: activationId }, env, fetchImpl);
}
