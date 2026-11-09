// Public browser sessions (docs/PLAN.md section 6.3, step G5).
//
// A public website cannot hold a secret, so the gateway does not authenticate the
// visitor. It makes public access bounded: the site proves a Turnstile challenge once
// at POST /v1/session and gets a short-lived, signed, read-only session token, sent
// back as "Authorization: Session <token>". Tokens are deliberately NOT bound to an IP
// (owner decision 2026-11-09): phones change IP mid-visit.
//
// Token format: "v1.<base64url payload>.<base64url HMAC-SHA256(SESSION_SIGNING_KEY, 'v1.' + payload)>"
// with payload JSON { c: client id, o: origin, e: expiry epoch ms }.

const TOKEN_VERSION = 'v1';
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const encoder = new TextEncoder();

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const signingKeys = new Map(); // secret -> Promise<CryptoKey>
function signingKeyFor(secret) {
  if (!signingKeys.has(secret)) {
    signingKeys.set(secret, crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return signingKeys.get(secret);
}

// A signed session token for { clientId, origin } that expires at expiresAt (epoch ms).
export async function issueSessionToken({ clientId, origin, expiresAt }, signingSecret) {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ c: clientId, o: origin, e: expiresAt })));
  const signed = `${TOKEN_VERSION}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await signingKeyFor(signingSecret), encoder.encode(signed));
  return `${signed}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// { clientId, origin, expiresAt } for a well-formed token with a valid signature, else
// null. Expiry is the caller's check (so it can answer "expired" distinctly).
export async function readSessionToken(token, signingSecret) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const signature = base64UrlDecode(parts[2]);
  const payloadBytes = base64UrlDecode(parts[1]);
  if (!signature || !payloadBytes) return null;
  // crypto.subtle.verify compares in constant time.
  const isValid = await crypto.subtle.verify('HMAC', await signingKeyFor(signingSecret), signature, encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!isValid) return null;
  try {
    const { c, o, e } = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (typeof c !== 'string' || typeof o !== 'string' || !Number.isFinite(e)) return null;
    return { clientId: c, origin: o, expiresAt: e };
  } catch {
    return null;
  }
}

// Asks Turnstile whether a widget token is genuine. Resolves { ok, hostname, errorCodes }
// or { unavailable: true } when siteverify could not answer.
export async function verifyTurnstile(widgetToken, remoteIp, secret, fetchImpl) {
  const form = new URLSearchParams({ secret, response: widgetToken });
  if (remoteIp) form.set('remoteip', remoteIp);
  let response;
  try {
    response = await fetchImpl(SITEVERIFY_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  } catch {
    return { unavailable: true };
  }
  if (!response.ok) return { unavailable: true };
  let body;
  try {
    body = await response.json();
  } catch {
    return { unavailable: true };
  }
  return { ok: body.success === true, hostname: typeof body.hostname === 'string' ? body.hostname : null, errorCodes: Array.isArray(body['error-codes']) ? body['error-codes'] : [] };
}
