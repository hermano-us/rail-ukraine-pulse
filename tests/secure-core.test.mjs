import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../backend/src/worker.js";
import { createAccessKey, hasPermission, permissionsForRole, verifyAccessKey } from "../backend/src/security/access.js";

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() { this.database.runs.push({ sql: this.sql, values: this.values }); return { success: true }; }
  async all() {
    if (this.sql.includes("FROM feature_flags")) return { results: [{ flag_key: "FEATURE_RESTRICTED_EVIDENCE", enabled: 1 }] };
    if (this.sql.includes("FROM restricted_evidence")) return { results: [{ evidence_id: "evidence-1", review_status: "pending" }] };
    return { results: [] };
  }
  async first() {
    if (this.sql.includes("FROM restricted_evidence")) return { evidence_id: "evidence-1", domain: "rail_freight", sensitivity_level: "restricted" };
    return null;
  }
}

function environment() {
  const database = { runs: [], prepare(sql) { return new Statement(this, sql); }, async batch(statements) { for (const item of statements) await item.run(); } };
  const cache = new Map();
  return {
    DB: database,
    SNAPSHOT: { async get(key) { return cache.get(key) || null; }, async put(key, value) { cache.set(key, value); } },
    ADMIN_TOKEN: "a-secure-admin-token-1234567",
    AUTH_PEPPER: "test-only-pepper",
  };
}

const adminRequest = (url, init = {}) => new Request(url, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer a-secure-admin-token-1234567" } });

test("role permissions keep restricted evidence away from operational roles", () => {
  assert.equal(hasPermission({ permissions: permissionsForRole("senior_curator") }, "evidence.review"), true);
  assert.equal(hasPermission({ permissions: permissionsForRole("operator") }, "evidence.read"), false);
  assert.equal(hasPermission({ permissions: permissionsForRole("observer") }, "users.manage"), false);
});

test("high-entropy access keys are salted and verifiable", async () => {
  const env = environment(); const credentials = await createAccessKey(env, "rup_example-secret");
  assert.notEqual(credentials.hash, "rup_example-secret");
  assert.equal(await verifyAccessKey(env, { access_key_salt: credentials.salt, access_key_hash: credentials.hash }, "rup_example-secret"), true);
  assert.equal(await verifyAccessKey(env, { access_key_salt: credentials.salt, access_key_hash: credentials.hash }, "wrong"), false);
});

test("legacy admin token remains a compatible principal during migration", async () => {
  const response = await handleRequest(adminRequest("https://api.example/api/auth/me"), environment());
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.user.role, "admin"); assert.equal(body.user.authMethod, "legacy_token");
});

test("restricted evidence API denies anonymous access and serves curator data", async () => {
  const env = environment();
  assert.equal((await handleRequest(new Request("https://api.example/api/restricted/evidence"), env)).status, 401);
  const response = await handleRequest(adminRequest("https://api.example/api/restricted/evidence"), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).evidence[0].evidence_id, "evidence-1");
});

test("evidence review updates the queue, legacy freight status, and append-only audit", async () => {
  const env = environment();
  const response = await handleRequest(adminRequest("https://api.example/api/restricted/evidence/review", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evidenceId: "evidence-1", status: "corroborated", note: "two independent sources" }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(env.DB.runs.some((item) => item.sql.includes("UPDATE restricted_evidence")), true);
  assert.equal(env.DB.runs.some((item) => item.sql.includes("UPDATE freight_observations")), true);
  assert.equal(env.DB.runs.some((item) => item.sql.includes("INSERT INTO secure_audit")), true);
});

test("feature flags are private and manageable through the compatibility principal", async () => {
  const env = environment();
  assert.equal((await handleRequest(new Request("https://api.example/api/admin/feature-flags"), env)).status, 401);
  const response = await handleRequest(adminRequest("https://api.example/api/admin/feature-flags"), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).flags[0].enabled, 1);
});

test("safety quarantine cannot be promoted or linked into rail intelligence", async () => {
  const env = environment();
  const originalPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (sql.includes("SELECT domain,sensitivity_level FROM restricted_evidence")) statement.first = async () => ({ domain: "rail_freight_safety", sensitivity_level: "highly_restricted" });
    return statement;
  };
  const response = await handleRequest(adminRequest("https://api.example/api/restricted/evidence/review", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evidenceId: "safety-1", status: "corroborated", linkedRunId: "run-1" }),
  }), env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "safety_quarantine_cannot_be_promoted");
  assert.equal(env.DB.runs.some((item) => item.sql.includes("UPDATE restricted_evidence")), false);
});
