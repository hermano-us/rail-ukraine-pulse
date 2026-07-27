const ROLE_PERMISSIONS = Object.freeze({
  admin: ["*"],
  senior_curator: ["admin.overview", "evidence.read", "evidence.review", "evidence.assign", "fuel.review", "rail.correct", "rail.intelligence.read", "rail.observations.write", "restricted.map", "operations.hub.read", "operations.hub.write", "operations.notifications.manage", "analytics.network.read", "shipments.read", "shipments.write"],
  logistics_coordinator: ["evidence.read_conclusion", "restricted.map_conclusion", "rail.intelligence.read", "operations.hub.read", "operations.hub.write", "operations.notifications.manage", "analytics.network.read", "shipments.read", "shipments.write"],
  operator: ["evidence.create", "rail.intelligence.read", "rail.observations.write", "operations.hub.read", "operations.notifications.manage", "shipments.read", "shipments.update"],
  observer: ["rail.intelligence.read", "operations.hub.read", "analytics.network.read", "shipments.read"],
});

const encoder = new TextEncoder();
const bytesToHex = (bytes) => [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
const randomToken = (size = 32) => {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
async function sha256(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}
function equalText(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function permissionsForRole(role) { return ROLE_PERMISSIONS[role] || []; }
export function hasPermission(principal, permission) {
  return Boolean(principal && (principal.permissions.includes("*") || principal.permissions.includes(permission)));
}

export async function resolvePrincipal(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const legacy = String(env.ADMIN_TOKEN || "");
  if (legacy.length >= 24 && equalText(token, legacy)) {
    return { id: "legacy-admin", login: "legacy-admin", displayName: "Legacy administrator", role: "admin", permissions: ["*"], authMethod: "legacy_token" };
  }
  if (token.length < 32) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT s.session_id,s.expires_at,u.user_id,u.login,u.display_name,u.role,u.status
    FROM access_sessions s JOIN access_users u ON u.user_id=s.user_id
    WHERE s.token_hash=?1 AND s.revoked_at IS NULL AND s.expires_at>?2
  `).bind(tokenHash, new Date().toISOString()).first();
  if (!row?.user_id || row.status !== "active") return null;
  env.DB.prepare("UPDATE access_sessions SET last_seen_at=?1 WHERE session_id=?2").bind(new Date().toISOString(), row.session_id).run().catch(() => {});
  return { id: row.user_id, login: row.login, displayName: row.display_name, role: row.role, permissions: permissionsForRole(row.role), authMethod: "session", sessionId: row.session_id };
}

export async function createAccessKey(env, accessKey) {
  const salt = randomToken(18);
  const hash = await sha256(`${salt}:${accessKey}:${String(env.AUTH_PEPPER || env.ADMIN_TOKEN || "")}`);
  return { salt, hash };
}
export async function verifyAccessKey(env, row, accessKey) {
  const actual = await sha256(`${row.access_key_salt}:${accessKey}:${String(env.AUTH_PEPPER || env.ADMIN_TOKEN || "")}`);
  return equalText(actual, row.access_key_hash);
}
export async function createSession(env, user, request) {
  const token = randomToken(32); const now = new Date(); const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const sessionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO access_sessions(session_id,token_hash,user_id,created_at,expires_at,last_seen_at,user_agent) VALUES(?1,?2,?3,?4,?5,?4,?6)").bind(sessionId, await sha256(token), user.user_id, now.toISOString(), expires.toISOString(), String(request.headers.get("User-Agent") || "").slice(0, 300)),
    env.DB.prepare("UPDATE access_users SET last_login_at=?1 WHERE user_id=?2").bind(now.toISOString(), user.user_id),
  ]);
  return { token, expiresAt: expires.toISOString() };
}
export async function revokeSession(env, principal) {
  if (principal?.authMethod !== "session") return false;
  await env.DB.prepare("UPDATE access_sessions SET revoked_at=?1 WHERE session_id=?2").bind(new Date().toISOString(), principal.sessionId).run();
  return true;
}
export function generateAccessKey() { return `rup_${randomToken(30)}`; }

export async function writeSecureAudit(env, principal, action, entityType, entityId = null, details = {}) {
  await env.DB.prepare("INSERT INTO secure_audit(audit_id,occurred_at,actor_id,actor_role,action,entity_type,entity_id,details_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")
    .bind(crypto.randomUUID(), new Date().toISOString(), principal?.id || "system", principal?.role || "system", action, entityType, entityId, JSON.stringify(details)).run();
}
