// POST /api/devices/revoke — docs/parent-sync-spec.md §6.4, §7. One-way
// flip; un-revoking means re-pairing (deliberate, per §6.4).
import { authenticate, json } from '../_lib/auth.js';

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

  const { deviceId } = body || {};
  if (!deviceId) return json({ error: 'deviceId is required' }, { status: 400 });

  const result = await env.DB.prepare(
    'UPDATE devices SET revoked = 1 WHERE id = ? AND family_id = ?'
  ).bind(deviceId, device.family_id).run();

  if (!result.meta.changes) {
    return json({ error: 'not found' }, { status: 404 });
  }

  return json({ revoked: true });
}
