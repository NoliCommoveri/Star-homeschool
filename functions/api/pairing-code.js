// POST /api/pairing-code — docs/parent-sync-spec.md §6.4, §7 "Adding a device".
// Parent-role only, so a child device's append-only token cannot mint codes.
import { authenticate, json, randomPairingCode, sha256Hex } from './_lib/auth.js';

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

  const role = body?.role;
  if (role !== 'child' && role !== 'parent') {
    return json({ error: 'role must be "child" or "parent"' }, { status: 400 });
  }

  const code = randomPairingCode();
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000; // ~10 minutes, per §7

  await env.DB.prepare(
    'INSERT INTO pairing_codes (code_hash, family_id, role, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(codeHash, device.family_id, role, expiresAt).run();

  // Plaintext code returned once; only its hash is ever stored (§7).
  return json({ code, expiresAt });
}
