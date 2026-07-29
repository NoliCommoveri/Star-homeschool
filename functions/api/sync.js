// POST /api/sync — docs/parent-sync-spec.md §6.2, §6.3, §6.4, §8.
// Child-role only. Idempotent: retries and double-sends are harmless.
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

  const { app, childId, childName, sessions } = body || {};
  if (!app || !childId || !Array.isArray(sessions)) {
    return json({ error: 'app, childId, and sessions[] are required' }, { status: 400 });
  }

  const now = Date.now();

  // §6.2 / §6.5 step 4: a childId belonging to another family 404s, same as
  // everywhere else — the upsert must never let a guessed id attach a
  // session to a family it doesn't belong to.
  const existingChild = await env.DB.prepare(
    'SELECT family_id FROM children WHERE id = ?'
  ).bind(childId).first();

  if (existingChild && existingChild.family_id !== device.family_id) {
    return json({ error: 'not found' }, { status: 404 });
  }

  if (existingChild) {
    if (childName) {
      await env.DB.prepare('UPDATE children SET name = ? WHERE id = ?').bind(childName, childId).run();
    }
  } else {
    await env.DB.prepare(
      'INSERT INTO children (id, family_id, name, created_at) VALUES (?, ?, ?, ?)'
    ).bind(childId, device.family_id, childName || '', now).run();
  }

  const accepted = [];
  for (const session of sessions) {
    if (!session || session.id == null) continue;
    const sessionId = String(session.id);
    const { id, date, mode, score, total, ...rest } = session;
    const occurredAt = Date.parse(date);

    await env.DB.prepare(
      `INSERT INTO sessions (child_id, app, device_id, session_id, occurred_at, received_at, mode, score, total, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(child_id, app, device_id, session_id) DO NOTHING`
    ).bind(
      childId,
      app,
      device.id,
      sessionId,
      Number.isFinite(occurredAt) ? occurredAt : now,
      now,
      mode || null,
      score ?? null,
      total ?? null,
      JSON.stringify(rest)
    ).run();

    accepted.push(sessionId);
  }

  return json({ accepted });
}
