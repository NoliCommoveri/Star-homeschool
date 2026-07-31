// GET /api/child-state?childId=&childId=&app= — docs/parent-sync-spec.md §15.4.
// Parent-role only.
//
// The freshest snapshot a tablet uploaded of what it actually has: word lists
// and the assigned one for Spelling Star, focus areas and the category catalog
// for Math Star. This is what lets parent.html offer "assign the list that's
// already on the tablet" and a real Math category picker without shipping a
// second copy of either app's data model — the tablet is the authority on what
// version of itself is installed.
import { authenticate, familyChildIds, json } from './_lib/auth.js';

export async function onRequestGet({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }

  const url = new URL(request.url);
  const app = url.searchParams.get('app');
  const childIds = await familyChildIds(env, device.family_id, url.searchParams.getAll('childId'));

  if (!app) return json({ error: 'app query param is required' }, { status: 400 });
  if (!childIds.length) return json({ error: 'not found' }, { status: 404 });

  const placeholders = childIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT s.child_id, s.device_id, s.updated_at, s.state, d.label
     FROM child_state s
     LEFT JOIN devices d ON d.id = s.device_id
     WHERE s.app = ? AND s.child_id IN (${placeholders})
     ORDER BY s.updated_at DESC`
  ).bind(app, ...childIds).all();

  const snapshots = results.map((row) => ({
    childId: row.child_id,
    deviceId: row.device_id,
    deviceLabel: row.label,
    updatedAt: row.updated_at,
    state: safeParse(row.state),
  })).filter((s) => s.state);

  return json({ snapshots });
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
