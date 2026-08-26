// GET / PUT /api/family/settings — docs/assignment-spec.md §9.3, §9.4, §12.1.
// Parent-role only: the family's time policy is an instruction, and §3 keeps
// instructions flowing one way, from the phone down.
//
// A child tablet never calls this. It receives the same two values inside the
// plan document that rides down in /api/sync's response (§6.2), which is one
// round-trip it already makes — so there is no second endpoint for a tablet to
// poll, and no reason for a child-role token to reach this handler at all.
import { authenticate, json, normalizeTimezone, normalizeWeekStart } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }

  const family = await env.DB.prepare(
    'SELECT timezone, week_start FROM families WHERE id = ?'
  ).bind(device.family_id).first();

  return json({
    // Null rather than a guessed default: "this family has never set a zone"
    // is a state the Plan tab has to be able to see, because §9.6 makes it the
    // reason a tablet stamps nothing.
    timezone: (family && family.timezone) || null,
    weekStart: family ? family.week_start : 0,
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

  const { timezone, weekStart } = body || {};

  // Each field is optional and updated only when supplied, so the Devices
  // screen can change the week start without having to resend a timezone it
  // never showed — and so a client that predates one of them cannot blank it.
  const updates = [];
  const params = [];

  if (timezone !== undefined) {
    const tz = normalizeTimezone(timezone);
    if (!tz) return json({ error: 'timezone must be an IANA zone name' }, { status: 400 });
    updates.push('timezone = ?');
    params.push(tz);
  }

  if (weekStart !== undefined) {
    const ws = normalizeWeekStart(weekStart);
    if (ws === null) return json({ error: 'weekStart must be 0 (Sunday) or 1 (Monday)' }, { status: 400 });
    updates.push('week_start = ?');
    params.push(ws);
  }

  if (!updates.length) {
    return json({ error: 'nothing to update' }, { status: 400 });
  }

  // §6.5: the family is the token's own, never a body field, so there is no id
  // here to guess at and nothing to authorize beyond the role check above.
  await env.DB.prepare(
    `UPDATE families SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...params, device.family_id).run();

  const family = await env.DB.prepare(
    'SELECT timezone, week_start FROM families WHERE id = ?'
  ).bind(device.family_id).first();

  return json({
    timezone: (family && family.timezone) || null,
    weekStart: family ? family.week_start : 0,
  });
}
