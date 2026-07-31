// /api/commands — docs/parent-sync-spec.md §15.2, §15.3. Parent-role only.
//
//   POST  queue a command for one child (all of a merged child's ids, §6.2)
//   GET   ?childId=&childId=&app=   recent commands + their delivery status
//
// The server never interprets a payload (§3 rule 3) beyond checking `kind`
// against the known set and capping the size: what an `assign-list` means is
// the child app's business, and keeping it that way is what lets a new command
// kind ship as an app change rather than a backend deploy.
import {
  authenticate,
  familyChildIds,
  json,
  randomId,
  COMMAND_KINDS,
  MAX_COMMAND_PAYLOAD_BYTES,
} from './_lib/auth.js';

// Delivered commands are history, not state — a tablet that has applied one
// never needs it again. Sweeping on create keeps the table from growing
// without a scheduled job, the same trick §7 uses for expired pairing codes.
const COMMAND_RETENTION_MS = 30 * 86400000;

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

  const { app, kind, payload } = body || {};
  const requestedIds = Array.isArray(body?.childIds) ? body.childIds : [body?.childId];

  if (!app || !kind) {
    return json({ error: 'app and kind are required' }, { status: 400 });
  }
  if (!COMMAND_KINDS.includes(kind)) {
    return json({ error: 'unknown command kind' }, { status: 400 });
  }

  const serialized = JSON.stringify(payload ?? {});
  if (serialized.length > MAX_COMMAND_PAYLOAD_BYTES) {
    return json({ error: 'payload too large' }, { status: 413 });
  }

  // §6.5 step 4: client-supplied childIds are selectors. Anything outside this
  // family is silently not addressed rather than 403'd — a 403 would confirm
  // the id exists.
  const childIds = await familyChildIds(env, device.family_id, requestedIds);
  if (!childIds.length) {
    return json({ error: 'not found' }, { status: 404 });
  }

  const now = Date.now();
  await env.DB.prepare('DELETE FROM command_acks WHERE command_id IN (SELECT id FROM commands WHERE created_at < ?)')
    .bind(now - COMMAND_RETENTION_MS).run();
  await env.DB.prepare('DELETE FROM commands WHERE created_at < ?')
    .bind(now - COMMAND_RETENTION_MS).run();

  // One row per id the merged child synced under (§6.2), so the assignment
  // reaches the tablet whichever id it is currently pushing with. A tablet
  // pulls only its own id's queue, so the extra rows are never applied twice.
  const created = [];
  for (const childId of childIds) {
    const id = randomId();
    await env.DB.prepare(
      `INSERT INTO commands (id, family_id, child_id, app, kind, payload, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, device.family_id, childId, app, kind, serialized, now, device.id).run();
    created.push({ id, childId });
  }

  return json({ commands: created, createdAt: now });
}

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
    `SELECT c.id, c.child_id, c.kind, c.payload, c.created_at, c.canceled,
            (SELECT COUNT(*) FROM command_acks a WHERE a.command_id = c.id) AS ack_count,
            (SELECT MIN(a.applied_at) FROM command_acks a WHERE a.command_id = c.id) AS first_applied_at
     FROM commands c
     WHERE c.app = ? AND c.child_id IN (${placeholders})
     ORDER BY c.created_at DESC
     LIMIT 40`
  ).bind(app, ...childIds).all();

  const commands = results.map((row) => ({
    id: row.id,
    childId: row.child_id,
    kind: row.kind,
    payload: safeParse(row.payload),
    createdAt: row.created_at,
    canceled: !!row.canceled,
    ackCount: row.ack_count,
    firstAppliedAt: row.first_applied_at,
  }));

  return json({ commands });
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
