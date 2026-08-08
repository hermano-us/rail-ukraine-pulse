import test from "node:test";
import assert from "node:assert/strict";
import { pruneOperationalStorage, STORAGE_RETENTION } from "../backend/src/storage-retention.js";

const snapshotRows = [
  { snapshot_id: "s-1", run_id: "run-1", captured_at: "2026-08-01T10:00:00Z", source_updated_at: "2026-08-01T09:59:00Z", update_json: '{"trainNumber":"1"}' },
  { snapshot_id: "s-2", run_id: "run-2", captured_at: "2026-08-01T10:15:00Z", source_updated_at: null, update_json: '{"trainNumber":"2"}' },
];

function database(rows = snapshotRows, timeline = []) {
  return { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; }, async all() {
    timeline.push("select"); return { results: /FROM run_snapshots/.test(sql) ? rows : [] };
  }, async run() {
    if (/DELETE FROM run_snapshots/.test(sql)) { timeline.push("delete"); return { meta: { changes: this.values.length } }; }
    timeline.push("health"); return { meta: { changes: 0 } };
  } }; } };
}

test("retention fails closed when the R2 binding is unavailable", async () => {
  const calls = [];
  const env = { DB: { prepare(sql) { calls.push(sql); return { bind() { return this; }, async run() { return { meta: { changes: 0 } }; } }; } } };
  const result = await pruneOperationalStorage(env, { snapshotPasses: 4 });
  assert.equal(result.status, "archive_unavailable");
  assert.equal(result.deletedRows, 0);
  assert.equal(result.snapshotRetentionDays, 2);
  assert.ok(calls.every((sql) => !/DELETE FROM run_snapshots/.test(sql)));
});

test("snapshots are deleted only after a self-describing R2 archive is committed", async () => {
  const timeline = []; const objects = [];
  const env = {
    DB: database(snapshotRows, timeline),
    ARCHIVE: { async put(key, body, options) { timeline.push("archive"); objects.push({ key, body, options }); return { key }; } },
    SNAPSHOT: { async put(key, value) { assert.equal(key, "storage:archive:last"); JSON.parse(value); } },
  };
  const result = await pruneOperationalStorage(env, { snapshotPasses: 1, batchSize: 250 });
  assert.equal(result.status, "online");
  assert.equal(result.archivedRows, 2);
  assert.equal(result.deletedRows, 2);
  assert.ok(timeline.indexOf("archive") < timeline.indexOf("delete"));
  assert.match(objects[0].key, /^run-snapshots\/2026\/08\/01\//);
  assert.equal(objects[0].options.customMetadata.records, "2");
  assert.equal(objects[0].options.customMetadata.identity, "snapshot_id");
  assert.match(objects[0].options.customMetadata.sha256, /^[a-f0-9]{64}$/);
  assert.ok(objects[0].body instanceof ArrayBuffer || typeof objects[0].body === "string");
  const archivedText = objects[0].options.customMetadata.encoding === "gzip"
    ? await new Response(new Blob([objects[0].body]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(objects[0].body);
  const archivedRows = archivedText.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(archivedRows.map((row) => row.snapshotId), ["s-1", "s-2"]);
  assert.equal(archivedRows[0].updateJson, snapshotRows[0].update_json);
});

test("an R2 failure preserves every D1 snapshot", async () => {
  const timeline = [];
  const env = { DB: database(snapshotRows, timeline), ARCHIVE: { async put() { timeline.push("archive_failed"); throw new Error("R2 unavailable"); } } };
  await assert.rejects(() => pruneOperationalStorage(env), /R2 unavailable/);
  assert.equal(timeline.includes("delete"), false);
});

test("archive maintenance never targets immutable events or audit", () => {
  const source = String(pruneOperationalStorage);
  assert.doesNotMatch(source, /DELETE FROM events|DELETE FROM secure_audit|DELETE FROM admin_audit/);
  assert.equal(STORAGE_RETENTION.archiveBatchSize, 250);
  assert.equal(STORAGE_RETENTION.deleteChunkSize, 50);
});
