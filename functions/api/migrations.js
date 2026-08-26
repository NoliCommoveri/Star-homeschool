// GET / POST /api/migrations — the in-app half of the migration runner.
//
// Parent-role only, using the device token parent.html already holds. That is
// the right gate here and not a weaker one than the /admin page's secret: this
// endpoint is only reachable by a device a parent has already paired, and
// applying a migration is a strictly smaller power than the Assign tab's
// existing ability to rewrite a child's word lists.
//
// Note this authenticates against `devices`, a table that exists in every
// version of this schema. A runner that needed a migration to have already run
// before it would authorize running one would be useless exactly when it is
// needed.
import { authenticate, json } from './_lib/auth.js';
import { applyPendingMigrations, migrationStatus } from './_lib/migrations.js';

export async function onRequestGet({ request, env }) {
  try {
    await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }
  if (!env.DB) return json({ error: 'the D1 binding "DB" is not configured on this Worker' }, { status: 500 });

  return json(await migrationStatus(env));
}

export async function onRequestPost({ request, env }) {
  try {
    await authenticate(request, env, ['parent']);
  } catch (response) {
    return response;
  }
  if (!env.DB) return json({ error: 'the D1 binding "DB" is not configured on this Worker' }, { status: 500 });

  const result = await applyPendingMigrations(env);
  const status = await migrationStatus(env);

  // 207 when a migration stopped part-way: some of the run succeeded and some
  // did not, and a flat 200 or 500 would misreport one half of that.
  return json({ ...result, ...status }, { status: result.failed ? 207 : 200 });
}
