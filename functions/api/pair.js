// POST /api/pair — docs/parent-sync-spec.md §6.4, §7 "On each child device".
// Not idempotent (§7): a network error must be treated by the client as
// "unknown, generate a new code," never retried with the same code.
import { json, randomToken, sha256Hex } from './_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { code, deviceId, role, label } = body || {};
  if (!code || !deviceId || (role !== 'child' && role !== 'parent')) {
    return json({ error: 'code, deviceId, and role ("child" | "parent") are required' }, { status: 400 });
  }

  const now = Date.now();
  const codeHash = await sha256Hex(code);

  const pairing = await env.DB.prepare(
    'SELECT family_id, role FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?'
  ).bind(codeHash, now).first();

  if (!pairing) return json({ error: 'invalid or expired code' }, { status: 401 });
  if (pairing.role !== role) return json({ error: 'role does not match this code' }, { status: 400 });

  // Single atomic UPDATE with the used_at IS NULL guard is what makes
  // redemption single-use under concurrent requests (§7) — no separate
  // read-then-write race window.
  const redeemed = await env.DB.prepare(
    'UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL'
  ).bind(now, codeHash).run();

  if (!redeemed.meta.changes) {
    return json({ error: 'code already used' }, { status: 401 });
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);

  // ON CONFLICT(id): a re-paired device sends the same client-generated
  // deviceId it always has (§6.1), so this rotates its token and un-revokes
  // it in place rather than colliding on the primary key.
  await env.DB.prepare(
    `INSERT INTO devices (id, family_id, token_hash, role, label, created_at, last_seen, rl_window, rl_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       family_id = excluded.family_id,
       token_hash = excluded.token_hash,
       role = excluded.role,
       label = excluded.label,
       last_seen = excluded.last_seen,
       revoked = 0`
  ).bind(deviceId, pairing.family_id, tokenHash, role, label || null, now, now, Math.floor(now / 1000)).run();

  return json({ token, role });
}
