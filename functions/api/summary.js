// GET /api/summary?childId=&childId=&app=&mode= — docs/parent-sync-spec.md §16.
// Parent-role only.
//
// The multi-year record: the best graded sitting on each list, per grade. It
// exists because the obvious alternative — fetching the sessions and reducing
// them on the phone — moves about 25 MB for five years of history, since
// /api/sessions spreads every payload. Grouped here, the same five years is a
// few hundred rows and a few KB.
//
// `mode` is a parameter rather than a constant because "the graded sitting"
// is a different word in each app — a Test in Spelling Star, a Drill in Math
// Star. parent.html already knows which, from the MODES table that drives its
// badges, so the server does not need to learn it (§3 rule 3).
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
  const mode = url.searchParams.get('mode');
  const childIds = await familyChildIds(env, device.family_id, url.searchParams.getAll('childId'));

  if (!app || !mode) return json({ error: 'app and mode query params are required' }, { status: 400 });
  if (!childIds.length) return json({ error: 'not found' }, { status: 404 });

  const placeholders = childIds.map(() => '?').join(',');

  // A merged child can hold the same sitting under more than one childId and
  // more than one device (§6.2, §9), so the aggregate runs over a de-duplicated
  // inner select keyed on the session's real identity — (device_id,
  // session_id) — rather than over the rows directly. Without it a re-push
  // under an adopted id would inflate `attempts`.
  const { results } = await env.DB.prepare(
    `SELECT grade,
            scope_id,
            MAX(scope_name)                AS scope_name,
            MAX(ratio)                     AS best,
            COUNT(*)                       AS attempts,
            MIN(occurred_at)               AS first_at,
            MAX(occurred_at)               AS last_at
     FROM (
       SELECT DISTINCT device_id, session_id, grade, scope_id, scope_name,
              occurred_at, (score * 1.0 / total) AS ratio
       FROM sessions
       WHERE app = ? AND mode = ? AND total > 0 AND deleted = 0
         AND child_id IN (${placeholders})
     )
     GROUP BY grade, scope_id
     ORDER BY grade, MAX(occurred_at) DESC`
  ).bind(app, mode, ...childIds).all();

  const lists = results.map((row) => ({
    grade: row.grade,                 // null = recorded before grades existed
    scopeId: row.scope_id,
    scopeName: row.scope_name,
    best: row.best,                   // 0..1; the client formats it
    attempts: row.attempts,
    firstAt: row.first_at,
    lastAt: row.last_at,
  }));

  return json({ lists });
}
