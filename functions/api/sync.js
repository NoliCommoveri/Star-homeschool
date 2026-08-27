// POST /api/sync — docs/parent-sync-spec.md §6.2, §6.3, §6.4, §8, §15.
// Child-role only. Idempotent: retries and double-sends are harmless.
//
// Phase 3 (§15.2) made this the child's only round-trip rather than adding a
// second endpoint to poll. It already ran on boot and after every session, so
// it carries the new traffic in both directions: `state` and `applied[]` go
// up alongside the sessions, `commands[]` comes back down. A Phase 1 client
// that sends neither still works unchanged — every new field is optional, and
// a client that ignores `commands` just never acts on them.
import { authenticate, json, MAX_CHILD_STATE_BYTES } from './_lib/auth.js';

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

  const { app, childId, childName, sessions, state, applied, planRevision } = body || {};
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
    const { id, date, mode, score, total, localDate, ...rest } = session;
    const occurredAt = Date.parse(date);

    // §16.3: grade and scope are lifted out of the payload into columns,
    // because the multi-year view GROUPs BY them and a Worker cannot parse
    // every payload to do that inside its CPU budget. Everything else keeps
    // riding along in the blob for free (§6.3).
    //
    // The two apps name these differently in their own session records, which
    // is right for each — a Spelling Star session has a listName, not a
    // "scope". Normalizing happens here rather than in the apps so neither has
    // to learn the server's vocabulary.
    const scope = sessionScope(app, rest);

    await env.DB.prepare(
      `INSERT INTO sessions (child_id, app, device_id, session_id, occurred_at, received_at, mode, score, total, payload, grade, scope_id, scope_name, local_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(rest),
      scope.grade,
      scope.id,
      scope.name,
      // assignment-spec.md §9.3: the calendar day this sitting belongs to, in
      // the family's timezone. Stamped by the client and only stored here,
      // never derived — SQLite has no IANA timezone database, so the Worker
      // could not compute it even if §3 rule 3 let it (§9.2). A client that
      // has never received a plan sends nothing and the column stays null,
      // which reads as "before plans" and is backfilled on the phone (§9.6).
      isLocalDate(localDate) ? localDate : null
    ).run();

    accepted.push(sessionId);
  }

  // §15.4 — what this tablet currently has (word lists / focus areas, plus the
  // app's own category catalog), so parent.html can offer real choices without
  // carrying a second copy of the child apps' data model. Keyed by device as
  // well as child so two tablets sharing a childId don't overwrite each other;
  // the parent reads whichever is freshest.
  if (state && typeof state === 'object') {
    const serialized = JSON.stringify(state);
    if (serialized.length > MAX_CHILD_STATE_BYTES) {
      return json({ error: 'state too large' }, { status: 413 });
    }
    await env.DB.prepare(
      `INSERT INTO child_state (child_id, app, device_id, updated_at, state)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(child_id, app, device_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         state = excluded.state`
    ).bind(childId, app, device.id, now, serialized).run();
  }

  // Acks for commands this device applied since its last sync (§15.2). The
  // family guard in the SELECT is what stops a device acking — and so hiding
  // from its siblings' parent view — a command that isn't its family's.
  if (Array.isArray(applied)) {
    for (const commandId of applied.slice(0, 200)) {
      if (!commandId) continue;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO command_acks (command_id, device_id, applied_at)
         SELECT c.id, ?, ? FROM commands c WHERE c.id = ? AND c.family_id = ?`
      ).bind(device.id, now, String(commandId), device.family_id).run();
    }
  }

  // Everything queued for this child+app that this device has not yet applied.
  // Nothing is consumed by reading, so a device that crashes mid-apply simply
  // sees the command again next sync — the client's apply step is written to
  // be safe to repeat (§15.5).
  const { results: pending } = await env.DB.prepare(
    `SELECT c.id, c.kind, c.payload, c.created_at
     FROM commands c
     LEFT JOIN command_acks a ON a.command_id = c.id AND a.device_id = ?
     WHERE c.child_id = ? AND c.app = ? AND c.canceled = 0 AND a.command_id IS NULL
     ORDER BY c.created_at`
  ).bind(device.id, childId, app).all();

  // A child that adopted the shared childId (§6.2) leaves commands queued
  // against the id it used before. Sweep those in too, so an assignment made
  // while the dashboard was showing the old id still lands.
  const legacy = await legacyCommands(env, device, childId, app);

  const commands = [...pending, ...legacy].map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: safeParse(row.payload),
    createdAt: row.created_at,
  }));

  // Which revision of the plan this device is holding (§12, plan_state), for
  // the delivery status the Plan tab shows. Explicitly *not* an ack: a plan is
  // idempotent desired-state, so nothing is gated on this row and a device
  // that never reports self-heals on its next sync anyway (§6.1).
  if (Number.isInteger(planRevision)) {
    await env.DB.prepare(
      `INSERT INTO plan_state (child_id, device_id, revision, seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(child_id, device_id) DO UPDATE SET
         revision = excluded.revision,
         seen_at = excluded.seen_at`
    ).bind(childId, device.id, planRevision, now).run();
  }

  const plan = await currentPlan(env, device.family_id, childId);

  return json({ accepted, commands, ...(plan ? { plan } : {}) });
}

// The plan document that rides down beside commands[] (§6.2). No new endpoint
// and no ack: last-write-wins on a monotonic revision, which is what makes two
// tablets racing harmless and a missed delivery self-healing.
//
// Returned only once the family has a timezone, because the document's whole
// job on the tablet is to carry one (§9.5) — every app writes it to the shared
// starplan-<slug> key and stamps local dates from it. Until then there is
// nothing to deliver, and §9.6 makes "stamps nothing" the correct behaviour
// rather than an outage.
async function currentPlan(env, familyId, childId) {
  const family = await env.DB.prepare(
    'SELECT timezone, week_start FROM families WHERE id = ?'
  ).bind(familyId).first();
  if (!family || !family.timezone) return null;

  // A child with no plan row still gets a document, carrying the family's zone
  // and an empty item list — that is what makes a tablet stamp local dates
  // before a parent has set a single target (§9.5). Revision 0 is deliberately
  // below every revision /api/plan will ever allocate, so that empty document
  // can never overwrite a real plan already on a device under §7.1's
  // highest-revision-wins rule — the ordering holds without the client knowing
  // which is which.
  const row = await env.DB.prepare(
    'SELECT revision, items FROM plans WHERE child_id = ?'
  ).bind(childId).first();

  return {
    revision: row ? row.revision : 0,
    timezone: family.timezone,
    weekStart: family.week_start,
    items: row ? (safeParse(row.items) || []) : [],
  };
}

// A stamp the client computed. Validated for shape only — the server does not
// know the family's zone well enough to second-guess the value, and a client
// with a wrong clock is an accepted exposure (§9.7), not something to catch
// here. What this does stop is a malformed string reaching a column that a
// future aggregate will GROUP BY and compare as a plain string (§9.4).
function isLocalDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Commands queued against another of this family's children that this same
// device has already pushed sessions for — i.e. an earlier id for the very
// same child (§6.2). Scoped through `sessions.device_id`, which only this
// device can have written, so it cannot reach a sibling's queue.
async function legacyCommands(env, device, currentChildId, app) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.kind, c.payload, c.created_at
     FROM commands c
     LEFT JOIN command_acks a ON a.command_id = c.id AND a.device_id = ?
     WHERE c.family_id = ? AND c.app = ? AND c.canceled = 0 AND a.command_id IS NULL
       AND c.child_id != ?
       AND c.child_id IN (SELECT DISTINCT s.child_id FROM sessions s WHERE s.device_id = ? AND s.app = ?)
     ORDER BY c.created_at`
  ).bind(device.id, device.family_id, app, currentChildId, device.id, app).all();
  return results;
}

// Each app's own words for "which list / focus area was this?", mapped onto
// the shared envelope columns (§16.3). A session from a client that predates
// grades yields nulls, which read as "before grades" — the permanent and
// correct value for every session recorded up to that point.
//
// This is the one place the server knows anything app-specific, and it is
// deliberately confined to naming rather than meaning: it does not interpret
// a list, only recognize which field holds its id. §3 rule 3 stays intact.
function sessionScope(app, rest) {
  if (app === 'spelling') {
    return { grade: rest.listGrade || null, id: rest.listId || null, name: rest.listName || null };
  }
  if (app === 'math') {
    return { grade: rest.focusGrade || null, id: rest.focusId || null, name: rest.focusName || null };
  }
  if (app === 'reading') {
    // reading-star-spec.md §3.2: grade is the CHILD's school grade (stamped as
    // childGrade), not the book's difficulty band — that stays in payload
    // alongside bookTitle/author so it's still visible to a card reading off
    // /api/sessions, which does not select the scope columns.
    return { grade: rest.childGrade || null, id: rest.bookId || null, name: rest.bookTitle || null };
  }
  return { grade: null, id: null, name: null };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
