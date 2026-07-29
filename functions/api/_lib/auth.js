// Shared helpers for functions/api/*. Underscore-prefixed directory: Pages
// Functions never routes this as an endpoint (docs/parent-sync-spec.md §12
// Step 7), only imports it.

const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const RATE_LIMIT_WINDOW_SECONDS = 3600;
const RATE_LIMIT_MAX_PER_WINDOW = 300;

export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 128-bit random id for families/children (§6.5: never derived, non-guessable).
export function randomId() {
  return randomHex(16);
}

// 256-bit bearer token; only its hash is ever stored (§7).
export function randomToken() {
  return randomHex(32);
}

export function randomPairingCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]).join('');
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Resolves the bearer token to its device row, enforcing §6.5's boundary:
// family_id and role always come from the token's own devices row, never
// the request body. On failure, throws the Response to return as-is.
//
// Also folds in §6.6 rate limiting: rl_window/rl_count are kept in epoch
// *seconds* (unlike every other timestamp in this schema, which is epoch
// milliseconds) purely so the "now - rl_window > 3600" check in the spec
// reads as one hour without a unit conversion.
export async function authenticate(request, env, allowedRoles) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw json({ error: 'missing bearer token' }, { status: 401 });

  const tokenHash = await sha256Hex(token);
  const device = await env.DB.prepare(
    'SELECT id, family_id, role, revoked, rl_window, rl_count FROM devices WHERE token_hash = ?'
  ).bind(tokenHash).first();

  if (!device || device.revoked) throw json({ error: 'invalid or revoked token' }, { status: 401 });
  if (allowedRoles && !allowedRoles.includes(device.role)) {
    throw json({ error: 'forbidden for this role' }, { status: 403 });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  let rlWindow = device.rl_window;
  let rlCount = device.rl_count;
  if (nowSeconds - rlWindow > RATE_LIMIT_WINDOW_SECONDS) {
    rlWindow = nowSeconds;
    rlCount = 1;
  } else {
    rlCount += 1;
  }

  if (rlCount > RATE_LIMIT_MAX_PER_WINDOW) {
    throw json({ error: 'rate limited' }, { status: 429 });
  }

  await env.DB.prepare(
    'UPDATE devices SET last_seen = ?, rl_window = ?, rl_count = ? WHERE id = ?'
  ).bind(Date.now(), rlWindow, rlCount, device.id).run();

  return device;
}
