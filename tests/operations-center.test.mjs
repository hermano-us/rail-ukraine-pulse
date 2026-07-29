import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("operations center is custom, private-by-default and buildable", async () => {
  const html = await readFile(new URL("rail-ops-center.html", root), "utf8");
  const build = await readFile(new URL("scripts/build-web.mjs", root), "utf8");
  const worker = await readFile(new URL("backend/src/worker.js", root), "utf8");
  assert.match(html, /OPERATIONS CENTER/);
  assert.match(html, /noindex,nofollow,noarchive/);
  assert.match(html, /fuel-review-dialog/);
  assert.match(html, /freight-source-rows/);
  assert.match(html, /data-operations-filter="decision"/);
  assert.match(html, /data-operations-filter="changed"/);
  assert.match(build, /rail-ops-center\.html/);
  assert.match(build, /rm\(new URL\("data\/freight-telegram-sources\.json", output\)/);
  assert.doesNotMatch(build, /admin\.html/);
  assert.match(worker, /\["\/admin\.html", "\/rail-ops-center\.html"\]\.includes/);
  const productionConfig = await readFile(new URL("backend/wrangler.production.jsonc", root), "utf8");
  assert.match(productionConfig, /"run_worker_first": true/);
  await assert.rejects(access(new URL("admin.html", root)));
});

test("operations hub v2 exposes stable filters and quality feedback", async () => {
  const [html,admin,api,migration]=await Promise.all([
    readFile(new URL("rail-ops-center.html",root),"utf8"),
    readFile(new URL("js/admin.js",root),"utf8"),
    readFile(new URL("backend/src/intelligence/api.js",root),"utf8"),
    readFile(new URL("backend/migrations/0021_operations_hub_v2.sql",root),"utf8"),
  ]);
  assert.match(html,/operations-filter-count/);
  assert.match(admin,/filterOperationsMovements/);
  assert.match(admin,/operationsMapFingerprint/);
  assert.match(admin,/QUALITY GATE/);
  assert.match(api,/ops_prediction_changes/);
  assert.match(api,/evaluateQualityGate/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS ops_prediction_changes/);
});

test("public client combines event stream with fallback polling", async () => {
  const client = await readFile(new URL("js/live-data-client.js", root), "utf8");
  const app = await readFile(new URL("js/app-ukraine.js", root), "utf8");
  assert.match(client, /new EventSource/);
  assert.match(client, /streamPath/);
  assert.match(app, /subscribeToLiveUpdates/);
  assert.match(app, /refreshIntervalMs/);
});

test("collector has bounded retries, timeout and readiness freshness", async () => {
  const collector = await readFile(new URL("scripts/collector-daemon.mjs", root), "utf8");
  assert.match(collector, /COLLECTOR_ATTEMPTS/);
  assert.match(collector, /COLLECTOR_SCRIPT_TIMEOUT_MS/);
  assert.match(collector, /staleAfterMs/);
  assert.match(collector, /\/ready/);
  assert.match(collector, /\/api\/v1\/collector\/heartbeat/);
  assert.match(collector, /COLLECTOR_ID/);
  assert.match(collector, /\/api\/v1\/collector\/board-priorities/);
  assert.match(collector, /BOARD_COVERAGE_PRIORITIES_JSON/);
});
