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
  assert.match(build, /rail-ops-center\.html/);
  assert.doesNotMatch(build, /admin\.html/);
  assert.match(worker, /\["\/admin\.html", "\/rail-ops-center\.html"\]\.includes/);
  await assert.rejects(access(new URL("admin.html", root)));
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
});
