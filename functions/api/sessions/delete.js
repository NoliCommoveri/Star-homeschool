// POST /api/sessions/delete — docs/parent-sync-spec.md §15.3. Parent-role only.
//
// The parent-initiated counterpart to the child-role /api/delete. It does two
// things in one call because half of it is useless on its own: it tombstones
// the rows so the dashboard stops showing them immediately, and it queues a
// `delete-session` command so the tablet drops them from its own history the
// next time it syncs. Splitting these into two client calls would leave a
// window where a network drop deletes a session from the parent's view and
// leaves it on the tablet forever, which is exactly the divergence §15 exists
// to avoid.
//
// Unlike /api/delete — which scopes to the calling device's own rows, since a
// tablet can only ever have pushed its own (§6.2) — this scopes by child and
// app across every device, because a parent deleting "that session" means the
// row they are looking at regardless of which tablet recorded it.
import { authenticate, familyChildIds, json, randomId } from './../_lib/auth.js';

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

  const { app, sessionIds } = body || {};
  const requestedIds = Array.isArray(body?.childIds) ? body.childIds : [body?.childId];

  if (!app || !Array.isArray(sessionIds) || !sessionIds.length) {
    return json({ error: 'app and a non-empty sessionIds[] are required' }, { status: 400 });
  }

  const childIds = await familyChildIds(env, device.family_id, requestedIds);
  if (!childIds.length) return json({ error: 'not found' }, { status: 404 });

  const ids = [...new Set(sessionIds.map(String))].slice(0, 100);
  const now = Date.now();

  const childPlaceholders = childIds.map(() => '?').join(',');
  const sessionPlaceholders = ids.map(() => '?').join(',');

  const tombstoned = await env.DB.prepare(
    `UPDATE sessions SET deleted = 1
     WHERE app = ? AND child_id IN (${childPlaceholders}) AND session_id IN (${sessionPlaceholders})`
  ).bind(app, ...childIds, ...ids).run();

  // Queued per child id (§6.2) for the same reason /api/commands is: the
  // tablet pulls whichever queue matches the id it currently syncs under.
  const payload = JSON.stringify({ sessionIds: ids });
  const commands = [];
  for (const childId of childIds) {
    const id = randomId();
    await env.DB.prepare(
      `INSERT INTO commands (id, family_id, child_id, app, kind, payload, created_at, created_by)
       VALUES (?, ?, ?, ?, 'delete-session', ?, ?, ?)`
    ).bind(id, device.family_id, childId, app, payload, now, device.id).run();
    commands.push({ id, childId });
  }

  return json({ deleted: ids, rows: tombstoned.meta.changes, commands });
}
