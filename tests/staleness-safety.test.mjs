import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRunIdentity } from "../js/data-store-ukraine.js";

test("run identity follows the source event date, not the viewer date", () => {
  const identity = buildRunIdentity({
    trainNumber: "121/122",
    origin: "Миколаїв Пас.",
    destination: "Київ-Пас.",
    updatedAt: "2026-07-17T16:08:13Z",
  }, new Date("2026-07-20T12:00:00Z"));
  assert.equal(identity.serviceDate, "2026-07-17");
  assert.match(identity.runId, /^uz:2026-07-17:/);
});

test("stale public snapshots cannot create calculated or reported positions", async () => {
  const source = await readFile(new URL("../js/data-store-ukraine.js", import.meta.url), "utf8");
  assert.match(source, /if\(!freshness\.canPosition\)return null/);
  assert.match(source, /freshness\.canPosition&&update\.operationalStatus/);
  assert.match(source, /source-snapshot-expired/);
});
