// GET / POST /admin/migrations — the fallback surface, adapted from the
// Scheduling App's page of the same name.
//
// The parent app's Database card (Devices tab) is the one to use normally.
// This page exists for when parent.html will not start, which is exactly when
// a schema problem is most likely: it is server-rendered, runs no JavaScript,
// loads no stylesheet, and needs nothing from the client but a form post.
//
// It is gated on SIGNUP_SECRET rather than a device token because a human has
// to be able to type it. That makes family.js no longer the only handler that
// reads the secret — worth knowing, since parent-sync-spec.md §5 says it is.
// The two uses are the same kind of thing: a deployment-level password for a
// deployment-level action, held by whoever set the Worker up.
import { applyPendingMigrations, migrationStatus } from '../api/_lib/migrations.js';

export async function onRequestGet({ env }) {
  if (!env.DB) return page({ error: 'The D1 binding "DB" is not configured on this Worker.' }, 500);
  const { migrations } = await migrationStatus(env);
  return page({ migrations });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return page({ error: 'The D1 binding "DB" is not configured on this Worker.' }, 500);

  const form = await request.formData();
  const secret = String(form.get('secret') || '');
  const confirmed = form.get('confirm') === 'yes';

  if (!env.SIGNUP_SECRET || !timingSafeEqual(secret, env.SIGNUP_SECRET)) {
    const { migrations } = await migrationStatus(env);
    return page({ migrations, error: 'Incorrect signup secret.' }, 401);
  }
  if (!confirmed) {
    const { migrations } = await migrationStatus(env);
    return page({ migrations, error: 'Tick the confirm box to apply.' });
  }

  const result = await applyPendingMigrations(env);
  const { migrations } = await migrationStatus(env);
  return page({ migrations, result }, result.failed ? 207 : 200);
}

// Length-independent comparison. The secret is low-value and an attacker needs
// a great many requests to learn anything from timing, but this costs three
// lines and removes the question.
function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function page({ migrations = [], result, error } = {}, status = 200) {
  const pending = migrations.filter((m) => !m.applied).length;
  const rows = migrations
    .map((m) => `<tr><td>${esc(m.name)}</td><td>${m.applied ? 'applied' : 'pending'}</td></tr>`)
    .join('\n');

  let outcome = '';
  if (result) {
    if (result.failed) {
      outcome = `<p class="err">Stopped on <strong>${esc(result.failed.name)}</strong>: ${esc(result.failed.error)}</p>
        <pre>${esc(result.failed.statement)}</pre>`;
    } else if (!result.ran.length) {
      outcome = '<p>Nothing was pending.</p>';
    } else {
      outcome = '<p>Applied:</p><ul>' + result.ran.map((r) =>
        `<li>${esc(r.name)} — ${r.changed} statement(s) run${r.skipped ? `, ${r.skipped} already present` : ''}</li>`
      ).join('') + '</ul>';
    }
  }

  const body = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Migrations — Star Homeschool</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  td { padding: .35rem .5rem; border-bottom: 1px solid #ddd; }
  pre { background: #f4f4f4; padding: .5rem; overflow-x: auto; }
  .err { color: #a11; font-weight: 600; }
  form { margin-top: 1.5rem; padding: 1rem; border: 1px solid #ccc; border-radius: 6px; }
  label { display: block; margin: .5rem 0; }
  input[type=password] { width: 100%; padding: .4rem; box-sizing: border-box; }
  button { margin-top: .75rem; padding: .5rem 1rem; }
</style>
</head>
<body>
<h1>Database migrations</h1>
<p>${pending} pending of ${migrations.length}.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
${outcome}
<table><tbody>${rows}</tbody></table>
<form method="post" action="/admin/migrations">
  <label>Signup secret
    <input type="password" name="secret" required autocomplete="off">
  </label>
  <label>
    <input type="checkbox" name="confirm" value="yes"> I understand this applies pending migrations to the live database.
  </label>
  <button type="submit">Apply pending migrations</button>
</form>
<p>Safe to press twice: a migration whose tables and columns are already there
reports them as already present and changes nothing.</p>
<p>No JavaScript runs on this page, so it works even when the parent dashboard
does not.</p>
</body>
</html>`;

  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
