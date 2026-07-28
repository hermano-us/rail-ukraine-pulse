import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard direct TLS failure is reported as degraded when the fresh mirror is active", async () => {
  const [worker, workflow] = await Promise.all([
    readFile(new URL("../backend/src/worker.js", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/update-data.yml", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /sourceId:"uz-delay-dashboard-direct",status:"degraded"/);
  assert.match(worker, /GitHub mirror active/);
  assert.match(worker, /mirrorAge<=20\?"online":"stale"/);
  assert.match(worker, /usableSources\s*>\s*0/);
  assert.match(worker, /freshSources\s*>\s*0\?"success":"degraded"/);
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
  assert.match(workflow, /cron: "17,47 \* \* \* \*"/);
  assert.match(workflow, /SKIP_BROWSER_SOURCE/);
});
