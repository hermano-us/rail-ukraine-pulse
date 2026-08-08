import test from "node:test";
import assert from "node:assert/strict";
import { pruneOperationalStorage, STORAGE_RETENTION } from "../backend/src/storage-retention.js";

test("operational retention never targets immutable events or audit", async () => {
  const calls = [];
  const env = { DB: { prepare(sql) { return { bind(...values) { calls.push({ sql, values }); return this; }, async run() { return { meta: { changes: 0 } }; } }; } } };
  const result = await pruneOperationalStorage(env, { snapshotPasses: 4 });
  assert.equal(result.snapshotRetentionDays, 2);
  assert.equal(STORAGE_RETENTION.deleteBatchSize, 5_000);
  assert.ok(calls.some(({ sql }) => /run_snapshots/.test(sql)));
  assert.ok(calls.some(({ sql }) => /source_health_checks/.test(sql)));
  assert.ok(calls.every(({ sql }) => !/\bevents\b|secure_audit|admin_audit/.test(sql)));
});

test("large cleanup is split into bounded passes", async () => {
  let snapshotPass = 0;
  const env = { DB: { prepare(sql) { return { bind() { return this; }, async run() {
    if (/run_snapshots/.test(sql)) return { meta: { changes: ++snapshotPass < 3 ? 5_000 : 12 } };
    return { meta: { changes: 3 } };
  } }; } } };
  const result = await pruneOperationalStorage(env, { snapshotPasses: 5 });
  assert.equal(snapshotPass, 3);
  assert.equal(result.snapshotRows, 10_012);
  assert.equal(result.healthRows, 3);
});
