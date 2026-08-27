// /api/plan — docs/assignment-spec.md §4, §6, §12.1. Parent-role only.
//
//   GET  ?childId=&childId=            the current plan for one (merged) child
//   PUT  { childIds, items, effectiveFrom }   revise it
//
// A plan is an instruction, not a record (§3), which is why it may live
// server-side without inverting the one-way rule. It is *not* a command: a
// command is an event with a lifecycle, a plan is a document that is edited
// repeatedly and read back, and only its current value is interesting (§6.1).
// So there is no ack here, no delivery state, and no retention sweep — a
// device that misses a revision self-heals on its next sync, because the
// document is idempotent desired-state and the highest revision wins (§7.1).
//
// The child never calls this. The plan rides down inside /api/sync's response
// (§6.2), which is a round-trip the tablet already makes.
import { authenticate, familyChildIds, json, normalizeTimezone } from './_lib/auth.js';

// §4.1: a match may reference only envelope columns, and this is the list of
// them. It is the constraint that keeps one predicate evaluable in three
// places — as JavaScript on the tablet, as JavaScript in parent.html, and as
// SQL in a future aggregate — so it is enforced here rather than left to the
// editor. A match on a payload field would be evaluable in exactly one of
// those, and the feature would quietly become two features.
const MATCH_KEYS = ['app', 'modes', 'scopeId'];

// The five apps in the registry (§5), not the three the Plan tab currently
// offers. §11 keeps Geography and Logic out of the *editor* because the phone
// cannot verify their sessions yet — that is a statement about what a parent
// should be shown, not about what the model can hold. §14 says that when those
// two land, "an app id becomes selectable in the editor, and nothing else
// moves"; accepting them here is what makes that true.
const PLAN_APPS = ['spelling', 'math', 'reading', 'geography', 'logic'];

// Ceilings in the spirit of §15.6's payload caps. A real family plan is a
// handful of items; anything near these is a bug or an abuse, and a D1 row
// that rides down to every tablet on every sync is not the place to find out.
const MAX_ITEMS = 40;
const MAX_ITEMS_BYTES = 32 * 1024;
const MAX_LABEL_LENGTH = 80;
const MAX_ID_LENGTH = 64;
const MAX_MODES = 12;
const MAX_COUNT = 50;

export async function onRequestGet({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }

  const url = new URL(request.url);
  const childIds = await familyChildIds(env, device.family_id, url.searchParams.getAll('childId'));
  if (!childIds.length) return json({ error: 'not found' }, { status: 404 });

  const family = await familySettings(env, device.family_id);
  const current = await highestPlan(env, childIds);
  const delivery = await deliveryStatus(env, device.family_id, childIds);

  return json({
    // Revision 0 with no items is the same document /api/sync hands a tablet
    // before any plan exists (§17 step 1), so "never planned" and "planned,
    // then emptied" read alike to a client and differently to nobody.
    revision: current ? current.revision : 0,
    items: current ? current.items : [],
    timezone: family.timezone,
    weekStart: family.weekStart,
    delivery,
  });
}

export async function onRequestPut({ request, env }) {
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

  const requestedIds = Array.isArray(body?.childIds) ? body.childIds : [body?.childId];

  // §6.5 step 4: client-supplied childIds are selectors. An id from another
  // family is silently not addressed rather than 403'd — a 403 would confirm
  // the id exists.
  const childIds = await familyChildIds(env, device.family_id, requestedIds);
  if (!childIds.length) return json({ error: 'not found' }, { status: 404 });

  const family = await familySettings(env, device.family_id);

  // §9: without the family's timezone a plan is inert in every direction at
  // once, and silently. /api/sync hands down no plan document at all until a
  // zone exists (§9.6), so no tablet ever receives it; no session carries a
  // local_date, so no bucket can be formed; and the phone's own progress bars
  // read 0 of 3 forever with nothing wrong anywhere to point at.
  //
  // §12 states this narrowly — "the Plan tab asks for it before it will accept
  // a day-period item" — but the reason it gives applies to a weekly target
  // just as completely, so the gate is the whole plan rather than one period
  // kind. Emptying a plan stays available either way: a parent must always be
  // able to take a target back off a child.
  if (Array.isArray(body?.items) && body.items.length && !family.timezone) {
    return json({
      error: "Set the family's timezone under Devices first — until it's set, "
        + 'a target has no day or week to count within.',
    }, { status: 400 });
  }

  const validated = validateItems(body?.items);
  if (validated.error) return json({ error: validated.error }, { status: 400 });
  const items = validated.items;

  const serialized = JSON.stringify(items);
  if (serialized.length > MAX_ITEMS_BYTES) {
    return json({ error: 'plan too large' }, { status: 413 });
  }

  // The local date this revision takes effect from (§6.3), so a past period
  // still evaluates against the plan that was in force. Supplied by the phone
  // when it has an intent — "from Monday" — and otherwise computed here rather
  // than defaulted to a UTC day: the Workers runtime carries the full timezone
  // database even though D1 does not (§9.2), so this is the one place on the
  // server where a family-local day is actually knowable.
  //
  // A supplied-but-unusable value is an error rather than a fallback: silently
  // substituting today would put a date this revision did not take effect on
  // into the one column §6.3 exists to make trustworthy.
  if (body?.effectiveFrom !== undefined && !normalizeLocalDate(body.effectiveFrom)) {
    return json({ error: 'effectiveFrom must be a YYYY-MM-DD local date' }, { status: 400 });
  }
  // The UTC fallback is reachable only when clearing a plan for a family that
  // has no zone, which is the one case above that does not need one.
  const effectiveFrom = normalizeLocalDate(body?.effectiveFrom)
    || familyToday(family.timezone)
    || new Date().toISOString().slice(0, 10);

  // Allocated here, never accepted from the client (§12.1). Two phones editing
  // concurrently then resolve to last-write-wins instead of to a silently lost
  // edit — the second write gets its own revision rather than colliding with a
  // number the first already used.
  //
  // Taken across every id the merged child has synced under (§6.2) so the ids
  // stay in step: a tablet pushing under one id and a tablet pushing under
  // another must never see two different documents claiming the same revision,
  // because §7.1 resolves ties by *not* writing.
  const revision = (await highestRevision(env, childIds)) + 1;
  const now = Date.now();

  for (const childId of childIds) {
    await env.DB.prepare(
      `INSERT INTO plans (child_id, family_id, revision, items, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(child_id) DO UPDATE SET
         revision = excluded.revision,
         items = excluded.items,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).bind(childId, device.family_id, revision, serialized, now, device.id).run();

    await env.DB.prepare(
      `INSERT INTO plan_revisions (child_id, revision, items, effective_from, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(child_id, revision) DO NOTHING`
    ).bind(childId, revision, serialized, effectiveFrom, now, device.id).run();
  }

  return json({ revision, effectiveFrom, items });
}

// ------------------------------------------------------------- validation ---

// Returns { items } or { error }. Every rejection names the field, because the
// one thing worse than refusing a plan is refusing it with "invalid item".
function validateItems(items) {
  if (!Array.isArray(items)) return { error: 'items must be an array' };
  if (items.length > MAX_ITEMS) return { error: `a plan may hold at most ${MAX_ITEMS} items` };

  const seen = new Set();
  const clean = [];

  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'each item must be an object' };
    }

    // §4.2: identity is `id`, not position. It has to survive a revision for
    // "she has missed her Friday test three weeks running" to be answerable,
    // so a duplicate within one document is a real error rather than something
    // to quietly de-dup — two items sharing an id are one item's history.
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || id.length > MAX_ID_LENGTH) {
      return { error: `item id must be a string of 1–${MAX_ID_LENGTH} characters` };
    }
    if (seen.has(id)) return { error: `duplicate item id "${id}"` };
    seen.add(id);

    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label || label.length > MAX_LABEL_LENGTH) {
      return { error: `item "${id}" needs a label of 1–${MAX_LABEL_LENGTH} characters` };
    }

    const match = validateMatch(raw.match, id);
    if (match.error) return match;

    if (!Number.isInteger(raw.count) || raw.count < 1 || raw.count > MAX_COUNT) {
      return { error: `item "${id}" needs a whole count between 1 and ${MAX_COUNT}` };
    }

    const period = validatePeriod(raw.period, id);
    if (period.error) return period;

    // Rebuilt field by field rather than spread, so an unknown top-level key
    // is dropped instead of stored. Storing it would put a field in the
    // document that rides down to every tablet and that nothing has agreed on
    // the meaning of.
    clean.push({ id, label, match: match.match, count: raw.count, period: period.period });
  }

  return { items: clean };
}

function validateMatch(match, id) {
  if (match === undefined || match === null) {
    return { error: `item "${id}" needs a match` };
  }
  if (typeof match !== 'object' || Array.isArray(match)) {
    return { error: `item "${id}"'s match must be an object` };
  }

  // §4.4. This would already be caught by the unknown-key check below, but the
  // generic message would be the wrong answer to the right question: a score
  // floor is the first thing a parent asks for and it is refused on purpose,
  // not overlooked. "3 drills at 80% or better" shows a child who honestly did
  // three drills a bar reading 0 of 3, and creates an incentive to abandon a
  // sitting that is going badly rather than finish it — which corrupts the very
  // history the dashboard reads. Targets count effort; the dashboard already
  // shows quality, in the same card, from the same sessions.
  if ('minScorePct' in match || 'minScore' in match) {
    return {
      error: `item "${id}": a target cannot carry a score floor. Targets count effort — `
        + 'the dashboard shows how the sittings went.',
    };
  }

  for (const key of Object.keys(match)) {
    if (!MATCH_KEYS.includes(key)) {
      return {
        error: `item "${id}": a match may only name ${MATCH_KEYS.join(', ')} — "${key}" is not one of them.`,
      };
    }
  }

  // Omitted means "any app": a cross-app target matches on mode alone (§4).
  let app = null;
  if (match.app !== undefined && match.app !== null) {
    if (!PLAN_APPS.includes(match.app)) {
      return { error: `item "${id}": unknown app "${match.app}"` };
    }
    app = match.app;
  }

  // Shape-checked, never checked for membership in the mode registry. The
  // registry lives in the clients (§5), and Spelling Star ships a new mode
  // every time it ships a game — a list here would mean a backend deploy
  // before a parent could target one, which is the coupling commands.js
  // already refuses for the same reason.
  let modes = null;
  if (match.modes !== undefined && match.modes !== null) {
    if (!Array.isArray(match.modes) || !match.modes.length) {
      return { error: `item "${id}": modes must be a non-empty array, or omitted for any mode` };
    }
    if (match.modes.length > MAX_MODES) {
      return { error: `item "${id}": at most ${MAX_MODES} modes` };
    }
    if (!match.modes.every((m) => typeof m === 'string' && m.trim() && m.length <= 40)) {
      return { error: `item "${id}": each mode must be a short string` };
    }
    modes = match.modes.map((m) => m.trim());
  }

  let scopeId = null;
  if (match.scopeId !== undefined && match.scopeId !== null) {
    if (typeof match.scopeId !== 'string' || !match.scopeId.trim() || match.scopeId.length > 120) {
      return { error: `item "${id}": scopeId must be a short string, or omitted` };
    }
    scopeId = match.scopeId.trim();
  }

  return { match: { app, modes, scopeId } };
}

function validatePeriod(period, id) {
  // Both bucket against local_date; the family timezone that makes that column
  // exist is checked once, for the whole plan, in onRequestPut.
  if (period === 'week') return { period: 'week' };
  if (period === 'day') return { period: 'day' };

  // §4.3: an explicit local-date range, inclusive — an assignment with a
  // deadline. The editor does not compose these until §17 step 5; the model
  // and the evaluator take them now so that step is UI only.
  if (period && typeof period === 'object' && !Array.isArray(period)) {
    for (const key of Object.keys(period)) {
      if (key !== 'from' && key !== 'to') {
        return { error: `item "${id}": a dated period may only name from and to` };
      }
    }
    const from = normalizeLocalDate(period.from);
    const to = normalizeLocalDate(period.to);
    if (!from || !to) {
      return { error: `item "${id}": a dated period needs from and to as YYYY-MM-DD local dates` };
    }
    // String comparison is the whole of date arithmetic once a date is
    // YYYY-MM-DD (§9.4), which is why that format was chosen.
    if (from > to) return { error: `item "${id}": the period ends before it starts` };
    return { period: { from, to } };
  }

  // Deliberately no "schoolweek": whether a week includes Saturday is a
  // question about the family's week, and weekStart already answers it (§4.3).
  return { error: `item "${id}": period must be "day", "week", or { from, to }` };
}

// Shape only, but a real shape check: local_date is compared as a plain string
// by every bucket (§9.4), so "2026-3-4" would sort before "2026-03-05" and
// match nothing while looking like a date.
function normalizeLocalDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  // Catches 2026-02-31 and 2026-13-01, which pass the pattern and are not days.
  const date = new Date(text + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === text ? text : null;
}

// ----------------------------------------------------------------- reads ---

async function familySettings(env, familyId) {
  const row = await env.DB.prepare(
    'SELECT timezone, week_start FROM families WHERE id = ?'
  ).bind(familyId).first();
  return {
    // Null rather than a guessed default, matching /api/family/settings:
    // "this family has never set a zone" is a state the Plan tab has to see,
    // because it is the reason a tablet stamps nothing (§9.6).
    timezone: (row && normalizeTimezone(row.timezone)) || null,
    weekStart: row ? row.week_start : 0,
  };
}

// §11's delivery status: which of this child's tablets is holding which
// revision, from the plan_state rows /api/sync writes (§12).
//
// A field on GET rather than the third endpoint §12.1 might suggest, for the
// same reason §11 gives for progress — "no new endpoint, no new request". The
// card is only ever read beside the plan it describes, so a request of its own
// would be a second round trip for one line of the same screen.
//
// Still not an ack (§6.1). Nothing is gated on these rows, nothing retries on
// them, and a device that never reports one self-heals on its next sync
// anyway. They answer a question a parent asks — "has it got there yet?" —
// that the protocol itself has no need of.
async function deliveryStatus(env, familyId, childIds) {
  const placeholders = childIds.map(() => '?').join(',');

  // Highest across the merged child's ids (§6.2). A tablet holds exactly one
  // document — the shared starplan-<slug> key is per child, not per id (§7) —
  // so rows under several ids are that one document reported under whichever
  // id the app happened to sync with, and the highest is what it is holding.
  const { results: held } = await env.DB.prepare(
    `SELECT device_id, MAX(revision) AS revision, MAX(seen_at) AS seen_at
       FROM plan_state WHERE child_id IN (${placeholders})
      GROUP BY device_id`
  ).bind(...childIds).all();

  // Every tablet that has ever synced for this child, so that one which has
  // never reported a revision at all still gets a row. That absence is the
  // failure this card exists to make visible: an app old enough not to send
  // planRevision syncs its sessions perfectly, receives the plan, and reports
  // nothing — and without a row the parent sees a shorter list rather than a
  // problem.
  //
  // Read from child_state rather than from sessions: three rows per device
  // rather than one per sitting, written by the same request (§15.4).
  const { results: synced } = await env.DB.prepare(
    `SELECT DISTINCT device_id FROM child_state WHERE child_id IN (${placeholders})`
  ).bind(...childIds).all();

  // Child devices only — a parent phone edits a plan, it never holds one — and
  // not revoked ones: a revoked tablet is not a delivery running late, it is a
  // tablet that is gone, and listing it as behind forever would train a parent
  // to ignore the card.
  const { results: devices } = await env.DB.prepare(
    `SELECT id, label, last_seen FROM devices
      WHERE family_id = ? AND role = 'child' AND revoked = 0`
  ).bind(familyId).all();

  const byId = new Map(held.map((row) => [row.device_id, row]));
  const known = new Set([...byId.keys(), ...synced.map((row) => row.device_id)]);

  return devices
    .filter((d) => known.has(d.id))
    .map((d) => {
      const row = byId.get(d.id);
      return {
        id: d.id,
        label: d.label || null,
        lastSeen: d.last_seen || null,
        // Null is "has never reported one", which is a different state from
        // holding revision 0 — the empty document every zoned family's tablet
        // receives before a single target exists — and reads differently on
        // the card.
        revision: row ? row.revision : null,
        seenAt: row ? row.seen_at : null,
      };
    })
    // Furthest behind first. The card exists to surface the tablet that has
    // not caught up, and a family with four of them should not have to hunt
    // for it. Null sorts below revision 0, which is where it belongs.
    .sort((a, b) => {
      const ar = a.revision === null ? -1 : a.revision;
      const br = b.revision === null ? -1 : b.revision;
      return ar - br || String(a.label || '').localeCompare(String(b.label || ''));
    });
}

// The plan carrying the highest revision across a merged child's ids. They are
// written in step, so this normally reads whichever id comes back first; it is
// a MAX rather than a pick so that a child merged *after* one id was already
// planned resolves to the real plan instead of an empty one.
async function highestPlan(env, childIds) {
  const placeholders = childIds.map(() => '?').join(',');
  const row = await env.DB.prepare(
    `SELECT revision, items FROM plans WHERE child_id IN (${placeholders})
     ORDER BY revision DESC LIMIT 1`
  ).bind(...childIds).first();
  if (!row) return null;
  return { revision: row.revision, items: safeParse(row.items) || [] };
}

// Over plan_revisions, not plans: revisions are append-only, so this is
// monotonic even for an id whose current plan row was overwritten by a
// concurrent write. Starting from 0 makes the first allocation 1, which is
// above the revision-0 placeholder /api/sync hands a tablet with no plan —
// so a real plan can never lose to it under §7.1's highest-wins rule.
async function highestRevision(env, childIds) {
  const placeholders = childIds.map(() => '?').join(',');
  const row = await env.DB.prepare(
    `SELECT MAX(revision) AS revision FROM plan_revisions WHERE child_id IN (${placeholders})`
  ).bind(...childIds).first();
  return (row && row.revision) || 0;
}

// The family's own calendar day. Intl is available in the Workers runtime even
// though it is not in SQLite (§9.2) — that asymmetry is the whole reason
// local_date is a stamped column rather than a query-time derivation.
function familyToday(timezone) {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    return null;
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
