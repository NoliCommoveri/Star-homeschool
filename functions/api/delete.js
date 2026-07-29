// POST /api/delete — docs/parent-sync-spec.md §6.4, §8. Tombstones rows;
// never removes them, so a stale push can't resurrect a deleted session.
import { authenticate, json } from './_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ['child']);
  } catch (response) {
    return response;
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { app, childId, sessionIds } = body || {};
  if (!app || !childId || !Array.isArray(sessionIds)) {
    return json({ error: 'app, childId, and sessionIds[] are required' }, { status: 400 });
  }

  const child = await env.DB.prepare('SELECT family_id FROM children WHERE id = ?').bind(childId).first();
  if (!child || child.family_id !== device.family_id) {
    return json({ error: 'not found' }, { status: 404 });
  }

  const deleted = [];
  for (const sessionId of sessionIds) {
    await env.DB.prepare(
      'UPDATE sessions SET deleted = 1 WHERE child_id = ? AND app = ? AND session_id = ?'
    ).bind(childId, app, String(sessionId)).run();
    deleted.push(String(sessionId));
  }

  return json({ deleted });
}
