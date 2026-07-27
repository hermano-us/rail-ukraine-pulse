import { createAccessKey, createSession, generateAccessKey, hasPermission, permissionsForRole, resolvePrincipal, revokeSession, verifyAccessKey, writeSecureAudit } from "./access.js";

const json = (value, status = 200) => new Response(`${JSON.stringify(value)}\n`, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const rows = (result) => result?.results || [];
const VALID_ROLES = new Set(["admin", "senior_curator", "logistics_coordinator", "operator", "observer"]);

async function rateLimited(env, request) {
  if (!env.SNAPSHOT) return false;
  const key = `auth-attempt:${request.headers.get("CF-Connecting-IP") || "unknown"}`;
  const count = Number(await env.SNAPSHOT.get(key) || 0) + 1;
  await env.SNAPSHOT.put(key, String(count), { expirationTtl: 60 });
  return count > 8;
}

export async function handleSecurityRequest(request, env) {
  const url = new URL(request.url); const path = url.pathname;
  if (request.method === "POST" && path === "/api/auth/session") {
    if (await rateLimited(env, request)) return json({ error: "rate_limited" }, 429);
    const body = await request.json(); const login = String(body.login || "").trim(); const accessKey = String(body.accessKey || "");
    const user = login ? await env.DB.prepare("SELECT * FROM access_users WHERE login=?1 COLLATE NOCASE").bind(login).first() : null;
    if (!user || user.status !== "active" || !(await verifyAccessKey(env, user, accessKey))) return json({ error: "invalid_credentials" }, 401);
    const session = await createSession(env, user, request);
    await writeSecureAudit(env, { id: user.user_id, role: user.role }, "session.created", "access_session", null, { login: user.login });
    return json({ ...session, user: { id: user.user_id, login: user.login, displayName: user.display_name, role: user.role } }, 201);
  }
  const principal = await resolvePrincipal(request, env);
  if (request.method === "GET" && path === "/api/auth/me") return principal ? json({ user: principal }) : json({ error: "unauthorized" }, 401);
  if (request.method === "DELETE" && path === "/api/auth/session") {
    if (!principal) return json({ error: "unauthorized" }, 401);
    await revokeSession(env, principal); await writeSecureAudit(env, principal, "session.revoked", "access_session", principal.sessionId || null);
    return json({ ok: true });
  }
  if (path === "/api/admin/access/users") {
    if (!hasPermission(principal, "users.manage")) return json({ error: "forbidden" }, principal ? 403 : 401);
    if (request.method === "GET") {
      const result = await env.DB.prepare(`SELECT u.user_id,u.login,u.display_name,u.role,u.status,u.created_at,u.updated_at,u.last_login_at,
        (SELECT COUNT(*) FROM access_sessions s WHERE s.user_id=u.user_id AND s.revoked_at IS NULL AND julianday(s.expires_at)>julianday('now')) active_sessions
        FROM access_users u ORDER BY u.login`).all();
      const rolePermissions=Object.fromEntries([...VALID_ROLES].map((role)=>[role,permissionsForRole(role)]));
      return json({ users: rows(result), roles: [...VALID_ROLES], rolePermissions });
    }
    if (request.method === "POST") {
      const body = await request.json(); const login = String(body.login || "").trim().toLowerCase(); const role = String(body.role || "observer");
      if (!/^[a-z0-9._-]{3,64}$/.test(login) || !VALID_ROLES.has(role)) return json({ error: "invalid_user" }, 400);
      const existing = await env.DB.prepare("SELECT user_id FROM access_users WHERE login=?1 COLLATE NOCASE").bind(login).first();
      if (existing) return json({ error: "login_already_exists" }, 409);
      const accessKey = generateAccessKey(); const credentials = await createAccessKey(env, accessKey); const now = new Date().toISOString(); const userId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO access_users(user_id,login,display_name,role,status,access_key_salt,access_key_hash,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,'active',?5,?6,?7,?7,?8)")
        .bind(userId, login, String(body.displayName || login).trim().slice(0, 120), role, credentials.salt, credentials.hash, now, principal.id).run();
      await writeSecureAudit(env, principal, "user.created", "access_user", userId, { login, role });
      return json({ user: { id: userId, login, role }, accessKey, warning: "Access key is shown once" }, 201);
    }
  }
  const userRoute = path.match(/^\/api\/admin\/access\/users\/([^/]+)(?:\/(rotate-key|revoke-sessions))?$/);
  if (userRoute) {
    if (!hasPermission(principal, "users.manage")) return json({ error: "forbidden" }, principal ? 403 : 401);
    const userId=decodeURIComponent(userRoute[1]),action=userRoute[2]||null;
    const current=await env.DB.prepare("SELECT user_id,login,display_name,role,status FROM access_users WHERE user_id=?1").bind(userId).first();
    if(!current)return json({error:"user_not_found"},404);
    if(request.method==="PATCH"&&!action){
      const body=await request.json();const role=body.role==null?current.role:String(body.role),status=body.status==null?current.status:String(body.status),displayName=body.displayName==null?current.display_name:String(body.displayName).trim().slice(0,120);
      if(!VALID_ROLES.has(role)||!["active","suspended","archived"].includes(status)||!displayName)return json({error:"invalid_user_update"},400);
      if(principal.id===userId&&(role!=="admin"||status!=="active"))return json({error:"cannot_remove_own_admin_access"},409);
      const now=new Date().toISOString();
      await env.DB.prepare("UPDATE access_users SET display_name=?1,role=?2,status=?3,updated_at=?4 WHERE user_id=?5").bind(displayName,role,status,now,userId).run();
      if(role!==current.role||status!==current.status)await env.DB.prepare("UPDATE access_sessions SET revoked_at=?1 WHERE user_id=?2 AND revoked_at IS NULL").bind(now,userId).run();
      await writeSecureAudit(env,principal,"user.updated","access_user",userId,{before:{role:current.role,status:current.status},after:{role,status}});
      return json({ok:true,user:{id:userId,login:current.login,displayName,role,status}});
    }
    if(request.method==="POST"&&action==="rotate-key"){
      const accessKey=generateAccessKey(),credentials=await createAccessKey(env,accessKey),now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE access_users SET access_key_salt=?1,access_key_hash=?2,updated_at=?3 WHERE user_id=?4").bind(credentials.salt,credentials.hash,now,userId),
        env.DB.prepare("UPDATE access_sessions SET revoked_at=?1 WHERE user_id=?2 AND revoked_at IS NULL").bind(now,userId),
      ]);
      await writeSecureAudit(env,principal,"user.key_rotated","access_user",userId,{login:current.login});
      return json({ok:true,userId,accessKey,warning:"Access key is shown once"});
    }
    if(request.method==="POST"&&action==="revoke-sessions"){
      if(principal.id===userId)return json({error:"use_logout_for_current_session"},409);
      const now=new Date().toISOString();const result=await env.DB.prepare("UPDATE access_sessions SET revoked_at=?1 WHERE user_id=?2 AND revoked_at IS NULL").bind(now,userId).run();
      await writeSecureAudit(env,principal,"user.sessions_revoked","access_user",userId,{login:current.login});
      return json({ok:true,userId,revoked:Number(result?.meta?.changes||0)});
    }
    return json({error:"method_not_allowed"},405);
  }
  if(request.method==="GET"&&path==="/api/admin/access/audit"){
    if(!hasPermission(principal,"users.manage"))return json({error:"forbidden"},principal?403:401);
    const limit=Math.max(1,Math.min(200,Number(url.searchParams.get("limit"))||100));
    return json({audit:rows(await env.DB.prepare(`SELECT * FROM secure_audit ORDER BY occurred_at DESC LIMIT ${limit}`).all())});
  }
  if (path === "/api/admin/feature-flags") {
    if (!hasPermission(principal, "flags.manage")) return json({ error: "forbidden" }, principal ? 403 : 401);
    if (request.method === "GET") return json({ flags: rows(await env.DB.prepare("SELECT * FROM feature_flags ORDER BY flag_key").all()) });
    if (request.method === "POST") {
      const body = await request.json(); const key = String(body.key || "");
      if (!/^FEATURE_[A-Z0-9_]{3,80}$/.test(key)) return json({ error: "invalid_flag" }, 400);
      await env.DB.prepare("UPDATE feature_flags SET enabled=?1,config_json=?2,updated_at=?3,updated_by=?4 WHERE flag_key=?5").bind(body.enabled ? 1 : 0, JSON.stringify(body.config || {}), new Date().toISOString(), principal.id, key).run();
      await writeSecureAudit(env, principal, "feature_flag.updated", "feature_flag", key, { enabled: Boolean(body.enabled) });
      return json({ ok: true, key, enabled: Boolean(body.enabled) });
    }
  }
  return null;
}
