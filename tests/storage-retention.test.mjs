import test from "node:test";
import assert from "node:assert/strict";
import { pruneOperationalStorage, recordBackupCheckpoint, STORAGE_RETENTION } from "../backend/src/storage-retention.js";

const snapshotRows = [
  { snapshot_id: "s-1", captured_at: "2026-08-01T10:00:00Z" },
  { snapshot_id: "s-2", captured_at: "2026-08-01T10:15:00Z" },
];

const checkpoint = {
  status: "verified",
  capturedThrough: "2026-08-08T10:00:00Z",
  verifiedAt: "2026-08-08T10:05:00Z",
  archiveId: "github-draft://hermano-us/rail-ukraine-pulse/d1-vault-2026-08/backup.enc",
  sha256: "a".repeat(64),
  bytes: 1234,
};

function kv(initial = null) {
  const values = new Map(initial ? [[STORAGE_RETENTION.checkpointKey, JSON.stringify(initial)]] : []);
  return {
    values,
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value || null;
    },
    async put(key, value) { values.set(key, value); },
  };
}

function database(rows = snapshotRows, timeline = []) {
  return {
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() {
          timeline.push({ type: "select", sql, values: this.values });
          return { results: /FROM run_snapshots/.test(sql) ? rows : [] };
        },
        async run() {
          if (/DELETE FROM run_snapshots/.test(sql)) {
            timeline.push({ type: "delete", sql, values: this.values });
            return { meta: { changes: this.values.length } };
          }
          timeline.push({ type: "health", sql, values: this.values });
          return { meta: { changes: 0 } };
        },
      };
    },
  };
}

test("retention fails closed without a verified GitHub backup checkpoint", async () => {
  const timeline = [];
  const result = await pruneOperationalStorage({ DB: database(snapshotRows, timeline), SNAPSHOT: kv() }, { snapshotPasses: 4 });
  assert.equal(result.status, "backup_unavailable");
  assert.equal(result.deletedRows, 0);
  assert.equal(result.snapshotRetentionDays, 2);
  assert.equal(timeline.some((item) => item.type === "delete"), false);
  assert.equal(timeline.some((item) => item.type === "select"), false);
});

test("snapshots are deleted only when a verified full backup covers them", async () => {
  const timeline = [];
  const store = kv(checkpoint);
  const result = await pruneOperationalStorage({ DB: database(snapshotRows, timeline), SNAPSHOT: store }, { snapshotPasses: 1 });
  assert.equal(result.status, "online");
  assert.equal(result.provider, "github-draft-release");
  assert.equal(result.deletedRows, 2);
  assert.equal(result.protectedThrough, checkpoint.capturedThrough);
  const selection = timeline.find((item) => item.type === "select");
  assert.match(selection.sql, /captured_at <= \?2/);
  assert.equal(selection.values[1], checkpoint.capturedThrough);
  assert.ok(timeline.findIndex((item) => item.type === "select") < timeline.findIndex((item) => item.type === "delete"));
  assert.ok(store.values.has("storage:backup:last"));
});

test("backup checkpoints are validated and cannot move backwards", async () => {
  const store = kv();
  await assert.rejects(() => recordBackupCheckpoint({ SNAPSHOT: store }, { status: "verified" }), /invalid_backup_checkpoint/);
  const saved = await recordBackupCheckpoint({ SNAPSHOT: store }, checkpoint);
  assert.equal(saved.provider, "github-draft-release");
  assert.equal(saved.sha256, "a".repeat(64));
  await assert.rejects(() => recordBackupCheckpoint({ SNAPSHOT: store }, {
    ...checkpoint,
    capturedThrough: "2026-08-07T10:00:00Z",
    archiveId: "github-draft://hermano-us/rail-ukraine-pulse/d1-vault-2026-08/older.enc",
  }), /backup_checkpoint_regression/);
});

test("backup-gated maintenance never targets immutable events or audit", () => {
  const source = String(pruneOperationalStorage);
  assert.doesNotMatch(source, /DELETE FROM events|DELETE FROM secure_audit|DELETE FROM admin_audit/);
  assert.equal(STORAGE_RETENTION.deleteBatchSize, 250);
  assert.equal(STORAGE_RETENTION.deleteChunkSize, 50);
});
