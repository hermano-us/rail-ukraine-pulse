import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard direct TLS failure is reported as degraded when the fresh mirror is active", async () => {
  const worker = await readFile(new URL("../backend/src/worker.js", import.meta.url), "utf8");
  assert.match(worker, /sourceId:"uz-delay-dashboard-direct",status:"degraded"/);
  assert.match(worker, /GitHub mirror active/);
  assert.match(worker, /mirrorAge<=20\?"online":"stale"/);
});
