var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/_lib/auth.js
var PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
var RATE_LIMIT_WINDOW_SECONDS = 3600;
var RATE_LIMIT_MAX_PER_WINDOW = 300;
function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...init.headers || {} }
  });
}
__name(json, "json");
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomHex, "randomHex");
function randomId() {
  return randomHex(16);
}
__name(randomId, "randomId");
function randomToken() {
  return randomHex(32);
}
__name(randomToken, "randomToken");
function randomPairingCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]).join("");
}
__name(randomPairingCode, "randomPairingCode");
async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
var COMMAND_KINDS = [
  "assign-list",
  // spelling: add/replace a word list, optionally make it active
  "set-active-list",
  // spelling: switch which existing list is assigned
  "assign-focus",
  // math: add/replace a focus area, optionally make it active
  "set-active-focus",
  // math: switch which existing focus area is assigned
  "delete-session",
  // both: drop sessions from the tablet's own history
  "assign-book",
  // reading: add/replace a catalog book (parent editor, §4.3)
  "delete-book"
  // reading: retire a catalog overlay entry
];
var MAX_COMMAND_PAYLOAD_BYTES = 64 * 1024;
var MAX_CHILD_STATE_BYTES = 128 * 1024;
async function familyChildIds(env, familyId, ids) {
  const wanted = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id FROM children WHERE family_id = ? AND id IN (${placeholders})`
  ).bind(familyId, ...wanted).all();
  return results.map((r) => r.id);
}
__name(familyChildIds, "familyChildIds");
async function authenticate(request, env, allowedRoles) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw json({ error: "missing bearer token" }, { status: 401 });
  const tokenHash = await sha256Hex(token);
  const device = await env.DB.prepare(
    "SELECT id, family_id, role, revoked, rl_window, rl_count FROM devices WHERE token_hash = ?"
  ).bind(tokenHash).first();
  if (!device || device.revoked) throw json({ error: "invalid or revoked token" }, { status: 401 });
  if (allowedRoles && !allowedRoles.includes(device.role)) {
    throw json({ error: "forbidden for this role" }, { status: 403 });
  }
  const nowSeconds = Math.floor(Date.now() / 1e3);
  let rlWindow = device.rl_window;
  let rlCount = device.rl_count;
  if (nowSeconds - rlWindow > RATE_LIMIT_WINDOW_SECONDS) {
    rlWindow = nowSeconds;
    rlCount = 1;
  } else {
    rlCount += 1;
  }
  if (rlCount > RATE_LIMIT_MAX_PER_WINDOW) {
    throw json({ error: "rate limited" }, { status: 429 });
  }
  await env.DB.prepare(
    "UPDATE devices SET last_seen = ?, rl_window = ?, rl_count = ? WHERE id = ?"
  ).bind(Date.now(), rlWindow, rlCount, device.id).run();
  return device;
}
__name(authenticate, "authenticate");

// api/commands/cancel.js
async function onRequestPost({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const ids = (Array.isArray(body?.commandIds) ? body.commandIds : [body?.commandId]).filter(Boolean).map(String);
  if (!ids.length) {
    return json({ error: "commandId or commandIds[] is required" }, { status: 400 });
  }
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
__name(onRequestPost, "onRequestPost");

// api/devices/revoke.js
async function onRequestPost2({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { deviceId } = body || {};
  if (!deviceId) return json({ error: "deviceId is required" }, { status: 400 });
  const result = await env.DB.prepare(
    "UPDATE devices SET revoked = 1 WHERE id = ? AND family_id = ?"
  ).bind(deviceId, device.family_id).run();
  if (!result.meta.changes) {
    return json({ error: "not found" }, { status: 404 });
  }
  return json({ revoked: true });
}
__name(onRequestPost2, "onRequestPost");

// api/sessions/delete.js
async function onRequestPost3({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { app, sessionIds } = body || {};
  const requestedIds = Array.isArray(body?.childIds) ? body.childIds : [body?.childId];
  if (!app || !Array.isArray(sessionIds) || !sessionIds.length) {
    return json({ error: "app and a non-empty sessionIds[] are required" }, { status: 400 });
  }
  const childIds = await familyChildIds(env, device.family_id, requestedIds);
  if (!childIds.length) return json({ error: "not found" }, { status: 404 });
  const ids = [...new Set(sessionIds.map(String))].slice(0, 100);
  const now = Date.now();
  const childPlaceholders = childIds.map(() => "?").join(",");
  const sessionPlaceholders = ids.map(() => "?").join(",");
  const tombstoned = await env.DB.prepare(
    `UPDATE sessions SET deleted = 1
     WHERE app = ? AND child_id IN (${childPlaceholders}) AND session_id IN (${sessionPlaceholders})`
  ).bind(app, ...childIds, ...ids).run();
  const payload = JSON.stringify({ sessionIds: ids });
  const commands = [];
  for (const childId of childIds) {
    const id = randomId();
    await env.DB.prepare(
      `INSERT INTO commands (id, family_id, child_id, app, kind, payload, created_at, created_by)
       VALUES (?, ?, ?, ?, 'delete-session', ?, ?, ?)`
    ).bind(id, device.family_id, childId, app, payload, now, device.id).run();
    commands.push({ id, childId });
  }
  return json({ deleted: ids, rows: tombstoned.meta.changes, commands });
}
__name(onRequestPost3, "onRequestPost");

// api/child-state.js
async function onRequestGet({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  const url = new URL(request.url);
  const app = url.searchParams.get("app");
  const childIds = await familyChildIds(env, device.family_id, url.searchParams.getAll("childId"));
  if (!app) return json({ error: "app query param is required" }, { status: 400 });
  if (!childIds.length) return json({ error: "not found" }, { status: 404 });
  const placeholders = childIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT s.child_id, s.device_id, s.updated_at, s.state, d.label
     FROM child_state s
     LEFT JOIN devices d ON d.id = s.device_id
     WHERE s.app = ? AND s.child_id IN (${placeholders})
     ORDER BY s.updated_at DESC`
  ).bind(app, ...childIds).all();
  const snapshots = results.map((row) => ({
    childId: row.child_id,
    deviceId: row.device_id,
    deviceLabel: row.label,
    updatedAt: row.updated_at,
    state: safeParse(row.state)
  })).filter((s) => s.state);
  return json({ snapshots });
}
__name(onRequestGet, "onRequestGet");
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
__name(safeParse, "safeParse");

// api/children.js
async function onRequestGet2({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at FROM children WHERE family_id = ? ORDER BY created_at"
  ).bind(device.family_id).all();
  return json({ children: results });
}
__name(onRequestGet2, "onRequestGet");

// api/commands.js
var COMMAND_RETENTION_MS = 30 * 864e5;
async function onRequestPost4({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { app, kind, payload } = body || {};
  const requestedIds = Array.isArray(body?.childIds) ? body.childIds : [body?.childId];
  if (!app || !kind) {
    return json({ error: "app and kind are required" }, { status: 400 });
  }
  if (!COMMAND_KINDS.includes(kind)) {
    return json({ error: "unknown command kind" }, { status: 400 });
  }
  const serialized = JSON.stringify(payload ?? {});
  if (serialized.length > MAX_COMMAND_PAYLOAD_BYTES) {
    return json({ error: "payload too large" }, { status: 413 });
  }
  const childIds = await familyChildIds(env, device.family_id, requestedIds);
  if (!childIds.length) {
    return json({ error: "not found" }, { status: 404 });
  }
  const now = Date.now();
  await env.DB.prepare("DELETE FROM command_acks WHERE command_id IN (SELECT id FROM commands WHERE created_at < ?)").bind(now - COMMAND_RETENTION_MS).run();
  await env.DB.prepare("DELETE FROM commands WHERE created_at < ?").bind(now - COMMAND_RETENTION_MS).run();
  const created = [];
  for (const childId of childIds) {
    const id = randomId();
    await env.DB.prepare(
      `INSERT INTO commands (id, family_id, child_id, app, kind, payload, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, device.family_id, childId, app, kind, serialized, now, device.id).run();
    created.push({ id, childId });
  }
  return json({ commands: created, createdAt: now });
}
__name(onRequestPost4, "onRequestPost");
async function onRequestGet3({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  const url = new URL(request.url);
  const app = url.searchParams.get("app");
  const childIds = await familyChildIds(env, device.family_id, url.searchParams.getAll("childId"));
  if (!app) return json({ error: "app query param is required" }, { status: 400 });
  if (!childIds.length) return json({ error: "not found" }, { status: 404 });
  const placeholders = childIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.child_id, c.kind, c.payload, c.created_at, c.canceled,
            (SELECT COUNT(*) FROM command_acks a WHERE a.command_id = c.id) AS ack_count,
            (SELECT MIN(a.applied_at) FROM command_acks a WHERE a.command_id = c.id) AS first_applied_at
     FROM commands c
     WHERE c.app = ? AND c.child_id IN (${placeholders})
     ORDER BY c.created_at DESC
     LIMIT 40`
  ).bind(app, ...childIds).all();
  const commands = results.map((row) => ({
    id: row.id,
    childId: row.child_id,
    kind: row.kind,
    payload: safeParse2(row.payload),
    createdAt: row.created_at,
    canceled: !!row.canceled,
    ackCount: row.ack_count,
    firstAppliedAt: row.first_applied_at
  }));
  return json({ commands });
}
__name(onRequestGet3, "onRequestGet");
function safeParse2(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
__name(safeParse2, "safeParse");

// api/delete.js
async function onRequestPost5({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["child"]);
  } catch (response) {
    return response;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { app, childId, sessionIds } = body || {};
  if (!app || !childId || !Array.isArray(sessionIds)) {
    return json({ error: "app, childId, and sessionIds[] are required" }, { status: 400 });
  }
  const child = await env.DB.prepare("SELECT family_id FROM children WHERE id = ?").bind(childId).first();
  if (!child || child.family_id !== device.family_id) {
    return json({ error: "not found" }, { status: 404 });
  }
  const deleted = [];
  for (const sessionId of sessionIds) {
    await env.DB.prepare(
      "UPDATE sessions SET deleted = 1 WHERE device_id = ? AND app = ? AND session_id = ?"
    ).bind(device.id, app, String(sessionId)).run();
    deleted.push(String(sessionId));
  }
  return json({ deleted });
}
__name(onRequestPost5, "onRequestPost");

// api/devices.js
async function onRequestGet4({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  const { results } = await env.DB.prepare(
    "SELECT id, role, label, created_at, last_seen, revoked FROM devices WHERE family_id = ? ORDER BY created_at"
  ).bind(device.family_id).all();
  return json({ devices: results });
}
__name(onRequestGet4, "onRequestGet");

// api/family.js
async function onRequestPost6({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { signupSecret, deviceId, label } = body || {};
  if (typeof signupSecret !== "string" || signupSecret !== env.SIGNUP_SECRET) {
    return json({ error: "invalid signup secret" }, { status: 401 });
  }
  if (!deviceId) {
    return json({ error: "deviceId is required" }, { status: 400 });
  }
  const now = Date.now();
  await env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").bind(now).run();
  const familyId = randomId();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO families (id, created_at) VALUES (?, ?)").bind(familyId, now),
    env.DB.prepare(
      `INSERT INTO devices (id, family_id, token_hash, role, label, created_at, last_seen, rl_window, rl_count)
       VALUES (?, ?, ?, 'parent', ?, ?, ?, ?, 0)`
    ).bind(deviceId, familyId, tokenHash, label || null, now, now, Math.floor(now / 1e3))
  ]);
  return json({ token, familyId, role: "parent" });
}
__name(onRequestPost6, "onRequestPost");

// api/pair.js
async function onRequestPost7({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { code, deviceId, role, label } = body || {};
  if (!code || !deviceId || role !== "child" && role !== "parent") {
    return json({ error: 'code, deviceId, and role ("child" | "parent") are required' }, { status: 400 });
  }
  const now = Date.now();
  const codeHash = await sha256Hex(code);
  const pairing = await env.DB.prepare(
    "SELECT family_id, role, child_id FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?"
  ).bind(codeHash, now).first();
  if (!pairing) return json({ error: "invalid or expired code" }, { status: 401 });
  if (pairing.role !== role) return json({ error: "role does not match this code" }, { status: 400 });
  const redeemed = await env.DB.prepare(
    "UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL"
  ).bind(now, codeHash).run();
  if (!redeemed.meta.changes) {
    return json({ error: "code already used" }, { status: 401 });
  }
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO devices (id, family_id, token_hash, role, label, created_at, last_seen, rl_window, rl_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       family_id = excluded.family_id,
       token_hash = excluded.token_hash,
       role = excluded.role,
       label = excluded.label,
       last_seen = excluded.last_seen,
       revoked = 0`
  ).bind(deviceId, pairing.family_id, tokenHash, role, label || null, now, now, Math.floor(now / 1e3)).run();
  return json({ token, role, childId: pairing.child_id || void 0 });
}
__name(onRequestPost7, "onRequestPost");

// api/pairing-code.js
async function onRequestPost8({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { role, childId, childName } = body || {};
  if (role !== "child" && role !== "parent") {
    return json({ error: 'role must be "child" or "parent"' }, { status: 400 });
  }
  const now = Date.now();
  let boundChildId = null;
  if (role === "child" && childId) {
    const existing = await env.DB.prepare(
      "SELECT id FROM children WHERE id = ? AND family_id = ?"
    ).bind(childId, device.family_id).first();
    if (!existing) return json({ error: "not found" }, { status: 404 });
    boundChildId = existing.id;
  } else if (role === "child" && childName && String(childName).trim()) {
    boundChildId = randomId();
    await env.DB.prepare(
      "INSERT INTO children (id, family_id, name, created_at) VALUES (?, ?, ?, ?)"
    ).bind(boundChildId, device.family_id, String(childName).trim(), now).run();
  }
  const code = randomPairingCode();
  const codeHash = await sha256Hex(code);
  const expiresAt = now + 10 * 60 * 1e3;
  await env.DB.prepare(
    "INSERT INTO pairing_codes (code_hash, family_id, role, child_id, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(codeHash, device.family_id, role, boundChildId, expiresAt).run();
  return json({ code, expiresAt });
}
__name(onRequestPost8, "onRequestPost");

// api/sessions.js
async function onRequestGet5({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  const url = new URL(request.url);
  const childId = url.searchParams.get("childId");
  const app = url.searchParams.get("app");
  const since = url.searchParams.get("since");
  if (!childId || !app) {
    return json({ error: "childId and app query params are required" }, { status: 400 });
  }
  const child = await env.DB.prepare("SELECT family_id FROM children WHERE id = ?").bind(childId).first();
  if (!child || child.family_id !== device.family_id) {
    return json({ error: "not found" }, { status: 404 });
  }
  let query = `SELECT session_id, device_id, occurred_at, received_at, mode, score, total, payload
               FROM sessions WHERE child_id = ? AND app = ? AND deleted = 0`;
  const params = [childId, app];
  if (since) {
    query += " AND occurred_at >= ?";
    params.push(Number(since));
  }
  query += " ORDER BY occurred_at";
  const { results } = await env.DB.prepare(query).bind(...params).all();
  const sessions = results.map((row) => ({
    id: row.session_id,
    date: new Date(row.occurred_at).toISOString(),
    deviceId: row.device_id,
    receivedAt: row.received_at,
    mode: row.mode,
    score: row.score,
    total: row.total,
    ...JSON.parse(row.payload)
  }));
  return json({ sessions });
}
__name(onRequestGet5, "onRequestGet");

// api/summary.js
async function onRequestGet6({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["parent"]);
  } catch (response) {
    return response;
  }
  const url = new URL(request.url);
  const app = url.searchParams.get("app");
  const mode = url.searchParams.get("mode");
  const childIds = await familyChildIds(env, device.family_id, url.searchParams.getAll("childId"));
  if (!app || !mode) return json({ error: "app and mode query params are required" }, { status: 400 });
  if (!childIds.length) return json({ error: "not found" }, { status: 404 });
  const placeholders = childIds.map(() => "?").join(",");
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
    grade: row.grade,
    // null = recorded before grades existed
    scopeId: row.scope_id,
    scopeName: row.scope_name,
    best: row.best,
    // 0..1; the client formats it
    attempts: row.attempts,
    firstAt: row.first_at,
    lastAt: row.last_at
  }));
  return json({ lists });
}
__name(onRequestGet6, "onRequestGet");

// api/sync.js
async function onRequestPost9({ request, env }) {
  let device;
  try {
    device = await authenticate(request, env, ["child"]);
  } catch (response) {
    return response;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { app, childId, childName, sessions, state, applied } = body || {};
  if (!app || !childId || !Array.isArray(sessions)) {
    return json({ error: "app, childId, and sessions[] are required" }, { status: 400 });
  }
  const now = Date.now();
  const existingChild = await env.DB.prepare(
    "SELECT family_id FROM children WHERE id = ?"
  ).bind(childId).first();
  if (existingChild && existingChild.family_id !== device.family_id) {
    return json({ error: "not found" }, { status: 404 });
  }
  if (existingChild) {
    if (childName) {
      await env.DB.prepare("UPDATE children SET name = ? WHERE id = ?").bind(childName, childId).run();
    }
  } else {
    await env.DB.prepare(
      "INSERT INTO children (id, family_id, name, created_at) VALUES (?, ?, ?, ?)"
    ).bind(childId, device.family_id, childName || "", now).run();
  }
  const accepted = [];
  for (const session of sessions) {
    if (!session || session.id == null) continue;
    const sessionId = String(session.id);
    const { id, date, mode, score, total, ...rest } = session;
    const occurredAt = Date.parse(date);
    const scope = sessionScope(app, rest);
    await env.DB.prepare(
      `INSERT INTO sessions (child_id, app, device_id, session_id, occurred_at, received_at, mode, score, total, payload, grade, scope_id, scope_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      scope.name
    ).run();
    accepted.push(sessionId);
  }
  if (state && typeof state === "object") {
    const serialized = JSON.stringify(state);
    if (serialized.length > MAX_CHILD_STATE_BYTES) {
      return json({ error: "state too large" }, { status: 413 });
    }
    await env.DB.prepare(
      `INSERT INTO child_state (child_id, app, device_id, updated_at, state)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(child_id, app, device_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         state = excluded.state`
    ).bind(childId, app, device.id, now, serialized).run();
  }
  if (Array.isArray(applied)) {
    for (const commandId of applied.slice(0, 200)) {
      if (!commandId) continue;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO command_acks (command_id, device_id, applied_at)
         SELECT c.id, ?, ? FROM commands c WHERE c.id = ? AND c.family_id = ?`
      ).bind(device.id, now, String(commandId), device.family_id).run();
    }
  }
  const { results: pending } = await env.DB.prepare(
    `SELECT c.id, c.kind, c.payload, c.created_at
     FROM commands c
     LEFT JOIN command_acks a ON a.command_id = c.id AND a.device_id = ?
     WHERE c.child_id = ? AND c.app = ? AND c.canceled = 0 AND a.command_id IS NULL
     ORDER BY c.created_at`
  ).bind(device.id, childId, app).all();
  const legacy = await legacyCommands(env, device, childId, app);
  const commands = [...pending, ...legacy].map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: safeParse3(row.payload),
    createdAt: row.created_at
  }));
  return json({ accepted, commands });
}
__name(onRequestPost9, "onRequestPost");
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
__name(legacyCommands, "legacyCommands");
function sessionScope(app, rest) {
  if (app === "spelling") {
    return { grade: rest.listGrade || null, id: rest.listId || null, name: rest.listName || null };
  }
  if (app === "math") {
    return { grade: rest.focusGrade || null, id: rest.focusId || null, name: rest.focusName || null };
  }
  if (app === "reading") {
    return { grade: rest.childGrade || null, id: rest.bookId || null, name: rest.bookTitle || null };
  }
  return { grade: null, id: null, name: null };
}
__name(sessionScope, "sessionScope");
function safeParse3(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
__name(safeParse3, "safeParse");

// ../.wrangler/tmp/pages-huVsz3/functionsRoutes-0.17993921506756405.mjs
var routes = [
  {
    routePath: "/api/commands/cancel",
    mountPath: "/api/commands",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  },
  {
    routePath: "/api/devices/revoke",
    mountPath: "/api/devices",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost2]
  },
  {
    routePath: "/api/sessions/delete",
    mountPath: "/api/sessions",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost3]
  },
  {
    routePath: "/api/child-state",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/api/children",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/api/commands",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet3]
  },
  {
    routePath: "/api/commands",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost4]
  },
  {
    routePath: "/api/delete",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost5]
  },
  {
    routePath: "/api/devices",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet4]
  },
  {
    routePath: "/api/family",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost6]
  },
  {
    routePath: "/api/pair",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost7]
  },
  {
    routePath: "/api/pairing-code",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost8]
  },
  {
    routePath: "/api/sessions",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet5]
  },
  {
    routePath: "/api/summary",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet6]
  },
  {
    routePath: "/api/sync",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost9]
  }
];

// ../node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
