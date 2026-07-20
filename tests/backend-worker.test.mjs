import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, ingestPayload } from "../backend/src/worker.js";

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() { this.database.runs.push({ sql: this.sql, values: this.values }); return { success: true }; }
  async all() { return { results: [] }; }
  async first() { return { runs: 0 }; }
}

function environment() {
  const database = {
    runs: [], batches: [],
    prepare(sql) { return new Statement(this, sql); },
    async batch(statements) { this.batches.push(statements); return statements.map(() => ({ success: true })); },
  };
  const cache = new Map();
  return {
    DB: database,
    SNAPSHOT: {
      async put(key, value) { cache.set(key, value); },
      async get(key, type) { const value = cache.get(key); return type === "json" && value ? JSON.parse(value) : value || null; },
    },
    INGEST_TOKEN: "a-secure-ingest-token-123456",
    ALLOWED_ORIGIN: "https://hermano-us.github.io",
  };
}

const payload = {
  generatedAt: "2026-07-20T10:01:00Z",
  sourceStatus: { sourceId: "uz-public-fusion", status: "online", checkedAt: "2026-07-20T10:01:00Z" },
  updates: [{
    trainNumber: "91", route: "Київ — Львів", updatedAt: "2026-07-20T10:00:00Z",
    sourceId: "uz-public-board", reportedStation: "Козятин-1",
    positionEvidence: "station-board-window",
  }],
};

test("backend ingests runs and events and publishes a compatible snapshot", async () => {
  const env = environment();
  const result = await ingestPayload(env, payload, "2026-07-20T10:01:00Z");
  assert.equal(result.runs, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.snapshot.updates.length, 1);
  assert.equal(env.DB.batches.length, 1);
  assert.equal(env.DB.batches[0].length, 2);

  const response = await handleRequest(new Request("https://api.example/api/v1/snapshot", {
    headers: { Origin: "https://hermano-us.github.io" },
  }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).schemaVersion, 6);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://hermano-us.github.io");
});

test("ingestion endpoint rejects missing credentials", async () => {
  const response = await handleRequest(new Request("https://api.example/api/v1/ingest", {
    method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" },
  }), environment());
  assert.equal(response.status, 401);
});

