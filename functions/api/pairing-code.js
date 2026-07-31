// POST /api/pairing-code — docs/parent-sync-spec.md §6.4, §7 "Adding a device".
// Parent-role only, so a child device's append-only token cannot mint codes.
import { authenticate, json, randomId, randomPairingCode, sha256Hex } from './_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { role, childId, childName } = body || {};
  if (role !== 'child' && role !== 'parent') {
    return json({ error: 'role must be "child" or "parent"' }, { status: 400 });
  }

  const now = Date.now();

  // §6.2: a child-role code can now carry the child it is for, so pairing
  // assigns identity instead of a device guessing it from a typed name.
  // Both childId (reuse) and childName (mint one now — this flow's "create a
  // child" moment, same as sync's lazy upsert is its) are optional: a caller
  // that sends neither gets the pre-existing behavior — an unbound code, with
  // the device falling back to its own local name-slug guess on redemption.
  let boundChildId = null;
  if (role === 'child' && childId) {
    const existing = await env.DB.prepare(
      'SELECT id FROM children WHERE id = ? AND family_id = ?'
    ).bind(childId, device.family_id).first();
    if (!existing) return json({ error: 'not found' }, { status: 404 });
    boundChildId = existing.id;
  } else if (role === 'child' && childName && String(childName).trim()) {
    boundChildId = randomId();
    await env.DB.prepare(
      'INSERT INTO children (id, family_id, name, created_at) VALUES (?, ?, ?, ?)'
    ).bind(boundChildId, device.family_id, String(childName).trim(), now).run();
  }

  const code = randomPairingCode();
  const codeHash = await sha256Hex(code);
  const expiresAt = now + 10 * 60 * 1000; // ~10 minutes, per §7

  await env.DB.prepare(
    'INSERT INTO pairing_codes (code_hash, family_id, role, child_id, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(codeHash, device.family_id, role, boundChildId, expiresAt).run();

  // Plaintext code returned once; only its hash is ever stored (§7).
  return json({ code, expiresAt });
}
