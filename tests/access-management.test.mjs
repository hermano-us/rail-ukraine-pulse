import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { handleSecurityRequest } from "../backend/src/security/api.js";

class D1Statement {
  constructor(statement) { this.statement=statement; this.values=[]; }
  bind(...values) { this.values=values; return this; }
  async run() { const result=this.statement.run(...this.values); return { success:true, meta:{ changes:Number(result.changes||0) } }; }
  async all() { return { results:this.statement.all(...this.values) }; }
  async first() { return this.statement.get(...this.values)||null; }
}
function databaseAdapter(database) {
  return { prepare(sql) { return new D1Statement(database.prepare(sql)); }, async batch(statements) { return Promise.all(statements.map((statement)=>statement.run())); } };
}
function request(path,token,method="GET",body=null) {
  const headers={};if(token)headers.Authorization=`Bearer ${token}`;if(body)headers["Content-Type"]="application/json";
  return new Request(`https://api.example${path}`,{method,headers,body:body?JSON.stringify(body):undefined});
}

test("access management covers user lifecycle and protects the active administrator", async () => {
  const sqlite=new DatabaseSync(":memory:");sqlite.exec(await readFile(new URL("../backend/migrations/0010_secure_core.sql",import.meta.url),"utf8"));
  const cache=new Map(),env={DB:databaseAdapter(sqlite),ADMIN_TOKEN:"a-secure-admin-token-1234567",SNAPSHOT:{async get(key){return cache.get(key)||null;},async put(key,value){cache.set(key,value);}}};
  const legacy=env.ADMIN_TOKEN;

  const adminCreate=await handleSecurityRequest(request("/api/admin/access/users",legacy,"POST",{login:"admin.one",displayName:"Admin One",role:"admin"}),env);
  assert.equal(adminCreate.status,201);const adminResult=await adminCreate.json();assert.match(adminResult.accessKey,/^rup_/);
  const curatorCreate=await handleSecurityRequest(request("/api/admin/access/users",legacy,"POST",{login:"curator.one",displayName:"Curator One",role:"observer"}),env);
  assert.equal(curatorCreate.status,201);const curatorResult=await curatorCreate.json();
  const duplicate=await handleSecurityRequest(request("/api/admin/access/users",legacy,"POST",{login:"CURATOR.ONE",displayName:"Duplicate",role:"observer"}),env);
  assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).error,"login_already_exists");

  const login=await handleSecurityRequest(request("/api/auth/session",null,"POST",{login:"admin.one",accessKey:adminResult.accessKey}),env);
  assert.equal(login.status,201);const adminSession=(await login.json()).token;
  const list=await handleSecurityRequest(request("/api/admin/access/users",adminSession),env);const listed=await list.json();
  assert.equal(listed.users.length,2);assert.ok(listed.rolePermissions.senior_curator.includes("evidence.review"));
  assert.equal(listed.users.find((user)=>user.user_id===adminResult.user.id).active_sessions,1);

  const update=await handleSecurityRequest(request(`/api/admin/access/users/${curatorResult.user.id}`,adminSession,"PATCH",{role:"senior_curator",status:"active"}),env);
  assert.equal(update.status,200);assert.equal((await update.json()).user.role,"senior_curator");
  const curatorLogin=await handleSecurityRequest(request("/api/auth/session",null,"POST",{login:"curator.one",accessKey:curatorResult.accessKey}),env);
  assert.equal(curatorLogin.status,201);const curatorSession=(await curatorLogin.json()).token;
  const rotate=await handleSecurityRequest(request(`/api/admin/access/users/${curatorResult.user.id}/rotate-key`,adminSession,"POST"),env);
  assert.equal(rotate.status,200);const rotatedKey=(await rotate.json()).accessKey;assert.match(rotatedKey,/^rup_/);
  const revokedSession=await handleSecurityRequest(request("/api/auth/me",curatorSession),env);
  assert.equal(revokedSession.status,401);
  const oldLogin=await handleSecurityRequest(request("/api/auth/session",null,"POST",{login:"curator.one",accessKey:curatorResult.accessKey}),env);assert.equal(oldLogin.status,401);
  const newLogin=await handleSecurityRequest(request("/api/auth/session",null,"POST",{login:"curator.one",accessKey:rotatedKey}),env);assert.equal(newLogin.status,201);
  sqlite.prepare("UPDATE access_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(curatorResult.user.id);
  const relist=await handleSecurityRequest(request("/api/admin/access/users",adminSession),env);const relisted=await relist.json();
  assert.equal(relisted.users.find((user)=>user.user_id===curatorResult.user.id).active_sessions,0);

  const selfBlock=await handleSecurityRequest(request(`/api/admin/access/users/${adminResult.user.id}`,adminSession,"PATCH",{status:"suspended"}),env);
  assert.equal(selfBlock.status,409);
  const selfDemote=await handleSecurityRequest(request(`/api/admin/access/users/${adminResult.user.id}`,adminSession,"PATCH",{role:"observer"}),env);
  assert.equal(selfDemote.status,409);
  const revoke=await handleSecurityRequest(request(`/api/admin/access/users/${curatorResult.user.id}/revoke-sessions`,adminSession,"POST"),env);assert.equal(revoke.status,200);
  const audit=await handleSecurityRequest(request("/api/admin/access/audit",adminSession),env);const auditBody=await audit.json();
  assert.ok(auditBody.audit.some((item)=>item.action==="user.key_rotated"));assert.ok(auditBody.audit.some((item)=>item.action==="user.sessions_revoked"));
  sqlite.close();
});
