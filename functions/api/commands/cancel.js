// POST /api/commands/cancel — docs/parent-sync-spec.md §15.2. Parent-role only.
//
// Undo for a command that hasn't reached the tablet yet. Cancellation is a
// flag, not a delete, for the same reason §6's deletes are tombstones: the row
// is the record that the parent asked and then thought better of it, and the
// GET in commands.js still shows it. A command already applied by a device
// cannot be un-applied from here — that is a new command, not a cancellation.
import { authenticate, json } from './../_lib/auth.js';

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

  const ids = (Array.isArray(body?.commandIds) ? body.commandIds : [body?.commandId])
    .filter(Boolean).map(String);
  if (!ids.length) {
    return json({ error: 'commandId or commandIds[] is required' }, { status: 400 });
  }

  // family_id in the WHERE clause is the whole authorization check (§6.5): a
  // command id from another family matches nothing and reports zero canceled,
  // rather than confirming the id exists.
  let canceled = 0;
  for (const id of ids.slice(0, 50)) {
    const res = await env.DB.prepare(
      `UPDATE commands SET canceled = 1
       WHERE id = ? AND family_id = ?
         AND NOT EXISTS (SELECT 1 FROM command_acks a WHERE a.command_id = commands.id)`
    ).bind(id, device.family_id).run();
    canceled += res.meta.changes;
  }

  return json({ canceled });
}
