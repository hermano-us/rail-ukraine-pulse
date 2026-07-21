import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, ingestPayload, scheduledRefresh } from "../backend/src/worker.js";

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

test("admin overview is private and serves aggregate diagnostics", async () => {
  const env = environment();
  env.ADMIN_TOKEN = "a-secure-admin-token-1234567";
  const denied = await handleRequest(new Request("https://api.example/api/admin/overview"), env);
  assert.equal(denied.status, 401);
  const allowed = await handleRequest(new Request("https://api.example/api/admin/overview", {
    headers: { Authorization: "Bearer " + env.ADMIN_TOKEN },
  }), env);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).status, "unavailable");
});

test("worker delegates static requests to the asset binding", async () => {
  const env = environment();
  env.ASSETS = { fetch: async () => new Response("map", { status: 200 }) };
  const response = await handleRequest(new Request("https://api.example/index.html"), env);
  assert.equal(await response.text(), "map");
});
test("ingestion endpoint rejects missing credentials", async () => {
  const response = await handleRequest(new Request("https://api.example/api/v1/ingest", {
    method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" },
  }), environment());
  assert.equal(response.status, 401);
});


test("health reports snapshot freshness instead of unconditional ok", async () => {
  const env = environment();
  await ingestPayload(env, { ...payload, generatedAt: new Date().toISOString() });
  const response = await handleRequest(new Request("https://api.example/api/health"), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.version, "intelligence-v3");
  assert.equal(body.snapshot.updates, 1);
});

test("snapshot event stream advertises reconnect and current generation", async () => {
  const env = environment();
  await ingestPayload(env, { ...payload, generatedAt: new Date().toISOString() });
  const response = await handleRequest(new Request("https://api.example/api/v1/stream"), env);
  const body = await response.text();
  assert.match(response.headers.get("Content-Type"), /text\/event-stream/);
  assert.match(body, /retry: 10000/);
  assert.match(body, /event: snapshot/);
});

test("custom operations route replaces the legacy admin page", async () => {
  const env = environment();
  env.ASSETS = { fetch: async (request) => new Response(new URL(request.url).pathname) };
  const custom = await handleRequest(new Request("https://api.example/rail-ops"), env);
  assert.equal(await custom.text(), "/rail-ops-center.html");
  assert.match(custom.headers.get("X-Robots-Tag"), /noindex/);
  const legacy = await handleRequest(new Request("https://api.example/admin.html"), env);
  assert.equal(legacy.status, 404);
  const directAsset = await handleRequest(new Request("https://api.example/rail-ops-center.html"), env);
  assert.equal(directAsset.status, 404);
});

test("scheduled edge collector refreshes the snapshot independently of GitHub cron", async () => {
  const env = environment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<table><tr><td>№ 91</td><td>Київ → Львів</td><td>+0:12</td><td>В дорозі</td><td>—</td><td>12:30</td></tr></table>`);
  try {
    const result = await scheduledRefresh(env);
    assert.equal(result.edge, true);
    assert.equal(result.snapshot.updates.length, 1);
    assert.equal(result.snapshot.sourceStatus.status, "online");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
