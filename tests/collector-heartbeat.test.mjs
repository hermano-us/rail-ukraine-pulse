import test from "node:test";
import assert from "node:assert/strict";
import { buildCollectorHeartbeat, sendCollectorHeartbeat } from "../scripts/send-collector-heartbeat.mjs";

const runtime = {
  generatedAt: "2026-07-29T09:20:00Z",
  sources: { "uz-public-board": {
    status: { status: "online", checkedAt: "2026-07-29T09:20:01Z", lastSuccessfulAt: "2026-07-29T09:20:01Z" },
    coverage: { records: 13 },
    scheduler: { selectedStation: "Kyiv", strategy: "information-gain-v1", requestBudget: 1 },
  } },
};

test("scheduled collector heartbeat reports the actual board state", () => {
  const payload = buildCollectorHeartbeat(runtime, { COLLECTOR_ID: "github-edge", COLLECTOR_RUNS: "42" });
  assert.equal(payload.status, "healthy");
  assert.equal(payload.collectorId, "github-edge");
  assert.equal(payload.recordsCount, 13);
  assert.equal(payload.runs, 42);
  assert.equal(payload.board.selectedStation, "Kyiv");
});

test("scheduled collector heartbeat is posted with ingest credentials", async () => {
  let request;
  const result = await sendCollectorHeartbeat({
    runtime,
    env: { RAIL_API_URL: "https://rail.example/", RAIL_INGEST_TOKEN: "a-secure-ingest-token-123456", COLLECTOR_ID: "github-edge" },
    fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } }); },
  });
  assert.equal(request.url, "https://rail.example/api/v1/collector/heartbeat");
  assert.match(request.options.headers.Authorization, /^Bearer /);
  assert.equal(JSON.parse(request.options.body).status, "healthy");
  assert.equal(result.response.accepted, true);
});