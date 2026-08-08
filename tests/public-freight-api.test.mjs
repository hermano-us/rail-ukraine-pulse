import test from "node:test";
import assert from "node:assert/strict";
import { handleFreightRequest } from "../backend/src/freight/api.js";
import { handleRequest } from "../backend/src/worker.js";

function publicRows(now = Date.now()) {
  return [{
    evidence_id: "private-evidence-1", domain: "rail_freight", source_id: "freight-tg-irpin",
    occurred_at: new Date(now - 25 * 3_600_000).toISOString(), content_fingerprint: "fp-1",
    classification_json: JSON.stringify({ freightType: "bulk", locomotive: "ВЛ80Т-1445", entityKey: "locomotive:ВЛ80Т-1445", entityConfidence: 0.92 }),
    corridor_code: "kyiv-korosten", confidence: 0.55, sensitivity_level: "restricted", review_status: "pending",
  },
  {
    evidence_id: "private-evidence-2", domain: "rail_freight", source_id: "freight-tg-korosten",
    occurred_at: new Date(now - 25 * 3_600_000 + 15 * 60_000).toISOString(), content_fingerprint: "fp-2",
    classification_json: JSON.stringify({ freightType: "bulk", locomotive: "ВЛ80Т-1445", entityKey: "locomotive:ВЛ80Т-1445", entityConfidence: 0.92 }),
    corridor_code: "kyiv-korosten", confidence: 0.6, sensitivity_level: "restricted", review_status: "pending",
  }];
}

function database(results = publicRows()) {
  return {
    queries: [],
    prepare(sql) {
      this.queries.push(sql);
      return { all: async () => ({ results }) };
    },
  };
}

test("public freight endpoint needs no credential and returns only a cached sanitized projection", async () => {
  const DB = database();
  const response = await handleFreightRequest(
    new Request("https://example.test/api/v1/freight/public"),
    { DB, PUBLIC_FREIGHT_LAYER: "enabled" },
    { authorized: () => false, authorizedAdmin: () => false },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(response.headers.get("Cache-Control"), /max-age=60/);
  assert.match(DB.queries[0], /domain='rail_freight'/);
  assert.match(DB.queries[0], /received_at/);
  assert.equal(body.dataMode, "delayed-probabilistic-freight");
  assert.equal(body.policy.individualPublicPositions, false);
  assert.equal(body.objects.length, 1);
  assert.equal(body.objects[0].position, null);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /private-evidence|t\.me|ВЛ80Т-1445/);
});

test("disabled public freight feature fails closed without touching D1", async () => {
  let touched = false;
  const env = {
    PUBLIC_FREIGHT_LAYER: "disabled",
    DB: { prepare() { touched = true; throw new Error("must not query"); } },
  };
  const response = await handleFreightRequest(
    new Request("https://example.test/api/v1/freight/public"), env,
    { authorized: () => false, authorizedAdmin: () => false },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(touched, false);
  assert.equal(body.disabled, true);
  assert.deepEqual(body.objects, []);
  assert.deepEqual(body.corridors, []);
});

test("public freight database failure exposes no operational detail", async () => {
  const env = { PUBLIC_FREIGHT_LAYER: "enabled", DB: { prepare() { return { all: async () => { throw new Error("secret D1 detail"); } }; } } };
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await handleFreightRequest(
      new Request("https://example.test/api/v1/freight/public"), env,
      { authorized: () => false, authorizedAdmin: () => false },
    );
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.match(text, /freight_projection_unavailable/);
    assert.doesNotMatch(text, /secret D1 detail/);
  } finally {
    console.error = originalError;
  }
});

test("worker routes the public freight endpoint before static assets", async () => {
  const env = {
    PUBLIC_FREIGHT_LAYER: "disabled",
    ASSETS: { fetch: async () => new Response("static asset") },
  };
  const response = await handleRequest(new Request("https://example.test/api/v1/freight/public"), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.disabled, true);
  assert.notEqual(await Promise.resolve(body), "static asset");
});
