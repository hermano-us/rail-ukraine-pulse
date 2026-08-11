import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { handleEvidenceRequest } from "../backend/src/evidence/api.js";

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  run() { return this.database.prepare(this.sql).run(...this.values); }
}
class D1Adapter { constructor(database) { this.database = database; } prepare(sql) { return new Statement(this.database, sql); } }

async function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of ["0001_initial.sql", "0009_freight_intelligence.sql", "0010_secure_core.sql"]) {
    database.exec(await readFile(new URL(`../backend/migrations/${file}`, import.meta.url), "utf8"));
  }
  const now = new Date().toISOString();
  database.prepare("INSERT INTO restricted_evidence(evidence_id,domain,source_id,occurred_at,received_at,evidence_excerpt,classification_json,confidence,sensitivity_level,review_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("evidence-1", "rail_freight", "freight-test", now, now, "Freight observation", "{}", 0.6, "restricted", "pending", now, now);
  database.prepare("INSERT INTO freight_observations(observation_id,source_id,source_url,occurred_at,received_at,corridor_code,freight_type,confidence,content_fingerprint,evidence_excerpt) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("evidence-1", "freight-test", "https://example.test/source", now, now, "test-corridor", "general_freight", 0.6, "fingerprint", "Freight observation");
  return database;
}

test("legacy administrator can review evidence without violating access_users foreign key", async () => {
  const database = await fixture();
  const principal = { id: "legacy-admin", role: "admin", permissions: ["*"], authMethod: "legacy_token" };
  const response = await handleEvidenceRequest(new Request("https://example.test/api/restricted/evidence/review", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evidenceId: "evidence-1", status: "corroborated" }),
  }), { DB: new D1Adapter(database) }, principal);
  assert.equal(response.status, 200);
  const evidence = database.prepare("SELECT review_status,reviewed_by FROM restricted_evidence WHERE evidence_id='evidence-1'").get();
  assert.equal(evidence.review_status, "corroborated");
  assert.equal(evidence.reviewed_by, null);
  assert.equal(database.prepare("SELECT moderation_status FROM freight_observations WHERE observation_id='evidence-1'").get().moderation_status, "corroborated");
  assert.equal(database.prepare("SELECT actor_id FROM secure_audit WHERE action='evidence.reviewed'").get().actor_id, "legacy-admin");
  database.close();
});

test("session administrator remains the persisted evidence reviewer", async () => {
  const database = await fixture();
  const now = new Date().toISOString();
  database.prepare("INSERT INTO access_users(user_id,login,display_name,role,status,access_key_hash,access_key_salt,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("user-1", "curator", "Curator", "senior_curator", "active", "hash", "salt", now, now, "test");
  const principal = { id: "user-1", role: "senior_curator", permissions: ["evidence.read", "evidence.review"], authMethod: "session" };
  const response = await handleEvidenceRequest(new Request("https://example.test/api/restricted/evidence/review", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evidenceId: "evidence-1", status: "needs_context" }),
  }), { DB: new D1Adapter(database) }, principal);
  assert.equal(response.status, 200);
  assert.equal(database.prepare("SELECT reviewed_by FROM restricted_evidence WHERE evidence_id='evidence-1'").get().reviewed_by, "user-1");
  database.close();
});
