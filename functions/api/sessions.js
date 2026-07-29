// GET /api/sessions?childId=&app=&since= — docs/parent-sync-spec.md §6.3,
// §6.4. Parent-role only; reassembles envelope columns + payload back into
// the session shape the client originally pushed.
import { authenticate, json } from './_lib/auth.js';

export async function onRequestGet({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }

  const url = new URL(request.url);
  const childId = url.searchParams.get('childId');
  const app = url.searchParams.get('app');
  const since = url.searchParams.get('since');

  if (!childId || !app) {
    return json({ error: 'childId and app query params are required' }, { status: 400 });
  }

  const child = await env.DB.prepare('SELECT family_id FROM children WHERE id = ?').bind(childId).first();
  if (!child || child.family_id !== device.family_id) {
    return json({ error: 'not found' }, { status: 404 });
  }

  let query = `SELECT session_id, device_id, occurred_at, received_at, mode, score, total, payload
               FROM sessions WHERE child_id = ? AND app = ? AND deleted = 0`;
  const params = [childId, app];
  if (since) {
    query += ' AND occurred_at >= ?';
    params.push(Number(since));
  }
  query += ' ORDER BY occurred_at';

  const { results } = await env.DB.prepare(query).bind(...params).all();

  const sessions = results.map((row) => ({
    id: row.session_id,
    date: new Date(row.occurred_at).toISOString(),
    deviceId: row.device_id,
    receivedAt: row.received_at,
    mode: row.mode,
    score: row.score,
    total: row.total,
    ...JSON.parse(row.payload),
  }));

  return json({ sessions });
}
