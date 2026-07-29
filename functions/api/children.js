// GET /api/children — docs/parent-sync-spec.md §6.4. Parent-role only.
import { authenticate, json } from './_lib/auth.js';

export async function onRequestGet({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }

  const { results } = await env.DB.prepare(
    'SELECT id, name, created_at FROM children WHERE family_id = ? ORDER BY created_at'
  ).bind(device.family_id).all();

  return json({ children: results });
}
