// GET /api/devices — docs/parent-sync-spec.md §6.4, §7, §13. Parent-role
// only; backs the "revoking one token and nothing else" story and the
// quiet-device flag (7+ days by last_seen).
import { authenticate, json } from './_lib/auth.js';

export async function onRequestGet({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }

  const { results } = await env.DB.prepare(
    'SELECT id, role, label, created_at, last_seen, revoked FROM devices WHERE family_id = ? ORDER BY created_at'
  ).bind(device.family_id).all();

  return json({ devices: results });
}
