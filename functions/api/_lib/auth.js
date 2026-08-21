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
// The §15.3 command set. Kept server-side purely as a spelling check — the
// server stays dumb storage (§3 rule 3) and never interprets a payload, but
// an unknown `kind` is a client bug that should fail loudly at the point of
// queueing rather than sit unrecognized on a tablet forever.
export const COMMAND_KINDS = [
  'assign-list',       // spelling: add/replace a word list, optionally make it active
  'set-active-list',   // spelling: switch which existing list is assigned
  'reorder-lists',     // spelling: set the order of existing lists (drives "the next list")
  'assign-focus',      // math: add/replace a focus area, optionally make it active
  'set-active-focus',  // math: switch which existing focus area is assigned
  'delete-session',    // both: drop sessions from the tablet's own history
  'assign-book',        // reading: add/replace a catalog book (parent editor, §4.3)
  'delete-book',        // reading: retire a catalog overlay entry
  'set-reading-support-level', // reading: a parent-set generic tier, hook for future point weighting (§7)
];

// Payload and snapshot ceilings (§15.6). A word list or focus area is a few
// KB; anything near these is a bug or an abuse, and D1 rows are not the place
// to find that out.
export const MAX_COMMAND_PAYLOAD_BYTES = 64 * 1024;
export const MAX_CHILD_STATE_BYTES = 128 * 1024;

// §6.5 step 4, factored out: the merged dashboard child holds several childIds
// (§6.2), and every parent endpoint that takes them must confirm each one is
// this family's before it becomes a selector. Returns the subset that checks
// out, so an id from another family simply isn't addressed — matching the 404
// posture elsewhere rather than confirming the id exists.
export async function familyChildIds(env, familyId, ids) {
  const wanted = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id FROM children WHERE family_id = ? AND id IN (${placeholders})`
  ).bind(familyId, ...wanted).all();
  return results.map((r) => r.id);
}

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
