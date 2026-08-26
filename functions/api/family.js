// POST /api/family — docs/parent-sync-spec.md §6.4, §7 "First run".
// The only handler that ever reads env.SIGNUP_SECRET (§5).
import { json, normalizeTimezone, normalizeWeekStart, randomId, randomToken, sha256Hex } from './_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { signupSecret, deviceId, label, timezone, weekStart } = body || {};
  if (typeof signupSecret !== 'string' || signupSecret !== env.SIGNUP_SECRET) {
    return json({ error: 'invalid signup secret' }, { status: 401 });
  }
  if (!deviceId) {
    return json({ error: 'deviceId is required' }, { status: 400 });
  }

  const now = Date.now();

  // Sweep expired/used pairing codes (§7): cheap, runs rarely, here because
  // family creation is itself rare.
  await env.DB.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').bind(now).run();

  const familyId = randomId();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);

  // assignment-spec.md §9.3: the family's zone is set here, from the creating
  // phone's own Intl.DateTimeFormat().resolvedOptions().timeZone, because this
  // is the one moment a parent is guaranteed to be holding a device that knows
  // it. Optional and tolerant of a bad value — a family with no zone is a
  // supported state (§9.6), and failing family creation over a timezone would
  // be an absurd trade.
  const tz = normalizeTimezone(timezone);
  const ws = normalizeWeekStart(weekStart);

  await env.DB.batch([
    env.DB.prepare('INSERT INTO families (id, created_at, timezone, week_start) VALUES (?, ?, ?, ?)')
      .bind(familyId, now, tz, ws === null ? 0 : ws),
    env.DB.prepare(
      `INSERT INTO devices (id, family_id, token_hash, role, label, created_at, last_seen, rl_window, rl_count)
       VALUES (?, ?, ?, 'parent', ?, ?, ?, ?, 0)`
    ).bind(deviceId, familyId, tokenHash, label || null, now, now, Math.floor(now / 1000)),
  ]);

  return json({ token, familyId, role: 'parent', timezone: tz, weekStart: ws === null ? 0 : ws });
}
