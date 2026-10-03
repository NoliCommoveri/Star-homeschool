// GET / POST /admin/families — the operator's way into any family on this
// deployment, gated on SIGNUP_SECRET like /admin/migrations.
//
// Two jobs, both ending in the same thing: a parent pairing code, which the
// parent app's existing "Join family" form redeems.
//
//   - Recovery. A family whose only parent phone is lost or wiped has no
//     device left that can mint a code for a new one, and nothing on a tablet
//     can. Everything that matters lives server-side under the family id, so
//     pairing a new parent phone into that same family brings the dashboard,
//     plans, and history back as they were. Creating a fresh family would not:
//     it starts empty and the tablets stay paired to the old one.
//   - A second family. "Create family" here hands back a parent code instead
//     of asking for the secret on someone else's phone, so the secret never
//     leaves whoever set the Worker up.
//
// If the secret itself is lost: it cannot be read back, but it can be
// overwritten — Worker → Settings → Variables and secrets → SIGNUP_SECRET.
// Nothing stores it, so replacing it locks no existing device out.
//
// Server-rendered and JavaScript-free for the same reason the migrations page
// is: it has to work on whatever browser is to hand when the usual phone is
// gone. The secret is asked for on every action rather than echoed back into
// the page as a hidden field.
import { mintPairingCode, randomId, timingSafeEqual } from '../api/_lib/auth.js';

export async function onRequestGet({ env }) {
  if (!env.DB) return page({ error: 'The D1 binding "DB" is not configured on this Worker.' }, 500);
  return page({});
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return page({ error: 'The D1 binding "DB" is not configured on this Worker.' }, 500);

  const form = await request.formData();
  const secret = String(form.get('secret') || '');
  const action = String(form.get('action') || 'list');

  if (!env.SIGNUP_SECRET || !timingSafeEqual(secret, env.SIGNUP_SECRET)) {
    return page({ error: 'Incorrect signup secret.' }, 401);
  }

  let issued = null;
  if (action === 'create') {
    if (form.get('confirm') !== 'yes') {
      return page({ families: await listFamilies(env), error: 'Tick the box to create a family.' });
    }
    // No timezone: the creating browser is the operator's, not the family's.
    // The new family's own parent phone is asked for it on the Plan tab, which
    // is the first place it matters (assignment-spec.md §9.6).
    const familyId = randomId();
    await env.DB.prepare('INSERT INTO families (id, created_at, timezone, week_start) VALUES (?, ?, NULL, 0)')
      .bind(familyId, Date.now()).run();
    issued = { familyId, created: true, ...(await mintPairingCode(env, familyId, 'parent')) };
  } else if (action === 'parent-code') {
    const familyId = String(form.get('familyId') || '');
    const family = await env.DB.prepare('SELECT id FROM families WHERE id = ?').bind(familyId).first();
    if (!family) return page({ families: await listFamilies(env), error: 'No such family.' }, 404);
    issued = { familyId, created: false, ...(await mintPairingCode(env, familyId, 'parent')) };
  }

  return page({ families: await listFamilies(env), issued });
}

// Enough to tell families apart and to see which one lost its parent phone —
// names and counts, never session content.
async function listFamilies(env) {
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.created_at, f.timezone,
       (SELECT GROUP_CONCAT(DISTINCT c.name) FROM children c
          WHERE c.family_id = f.id AND c.name <> '') AS children,
       (SELECT GROUP_CONCAT(COALESCE(d.label, 'unnamed'), '; ') FROM devices d
          WHERE d.family_id = f.id AND d.role = 'parent' AND d.revoked = 0) AS parents,
       (SELECT COUNT(*) FROM devices d
          WHERE d.family_id = f.id AND d.role = 'child' AND d.revoked = 0) AS tablets,
       (SELECT MAX(d.last_seen) FROM devices d
          WHERE d.family_id = f.id AND d.role = 'parent' AND d.revoked = 0) AS parent_seen,
       (SELECT COUNT(*) FROM sessions s JOIN children c ON c.id = s.child_id
          WHERE c.family_id = f.id AND s.deleted = 0) AS sessions
     FROM families f
     ORDER BY f.created_at`
  ).all();
  return results;
}

function when(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never';
}

function secretField() {
  return `<input type="password" name="secret" required autocomplete="current-password" placeholder="Signup secret">`;
}

function page({ families, issued, error } = {}, status = 200) {
  let banner = '';
  if (issued) {
    banner = `<div class="code">
  <p>${issued.created ? 'New family created. ' : ''}Parent code for family <strong>${esc(issued.familyId.slice(0, 8))}</strong>:</p>
  <p class="big">${esc(issued.code)}</p>
  <p>On the phone that should become this family's parent: open <code>/parent.html</code> →
  <strong>Join family</strong> → enter the code. It works once, until ${esc(when(issued.expiresAt))}.</p>
</div>`;
  }

  let list = '';
  if (families) {
    const rows = families.map((f) => `<tr>
  <td><strong>${esc(f.id.slice(0, 8))}</strong><br><small>since ${esc(when(f.created_at).slice(0, 10))}</small></td>
  <td>${esc(f.children ? f.children.split(',').join(', ') : '—')}</td>
  <td>${esc(f.parents || 'none')}<br><small>last seen ${esc(when(f.parent_seen))}</small></td>
  <td>${f.tablets} tablet(s)<br><small>${f.sessions} session(s)</small></td>
  <td><form method="post" action="/admin/families">
    <input type="hidden" name="action" value="parent-code">
    <input type="hidden" name="familyId" value="${esc(f.id)}">
    ${secretField()}
    <button type="submit">Parent code</button>
  </form></td>
</tr>`).join('\n');
    list = `<h2>Families (${families.length})</h2>
<table>
<thead><tr><th>Family</th><th>Children</th><th>Parent phones</th><th>Tablets</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>Add a family</h2>
<p>Creates an empty family and gives you a parent code for it. Their tablets
are paired afterwards from their own parent phone, as usual.</p>
<form method="post" action="/admin/families">
  <input type="hidden" name="action" value="create">
  <label>${secretField()}</label>
  <label><input type="checkbox" name="confirm" value="yes" required> Create a new, empty family.</label>
  <button type="submit">Create family</button>
</form>`;
  } else {
    list = `<form method="post" action="/admin/families">
  <input type="hidden" name="action" value="list">
  <label>Signup secret ${secretField()}</label>
  <button type="submit">Show families</button>
</form>`;
  }

  const body = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Families — Star Homeschool</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { padding: .4rem .5rem; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  small { color: #666; }
  .err { color: #a11; font-weight: 600; }
  .code { padding: 1rem; border: 2px solid #2a5d9f; border-radius: 6px; background: #eef4fb; }
  .big { font-size: 2rem; font-weight: 700; letter-spacing: .25em; margin: .25rem 0; }
  form { margin: 0; }
  label { display: block; margin: .5rem 0; }
  input[type=password] { width: 100%; max-width: 260px; padding: .4rem; box-sizing: border-box; }
  button { margin-top: .4rem; padding: .45rem .9rem; }
  @media (max-width: 640px) {
    thead { display: none; }
    tr, td { display: block; border: 0; padding: .15rem 0; }
    tr { border-bottom: 1px solid #ddd; padding: .6rem 0; }
  }
</style>
</head>
<body>
<h1>Families</h1>
<p>Get a parent phone back into a family — after a lost or wiped phone — or
set up a new family, without losing anything already synced.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
${banner}
${list}
<p><small>Lost the signup secret? It cannot be read back, but you can replace
it: Cloudflare → the Worker → Settings → Variables and secrets →
<code>SIGNUP_SECRET</code>. No paired device uses it, so nothing is signed out.</small></p>
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
