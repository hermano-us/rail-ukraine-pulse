const SNAPSHOT_RETENTION_DAYS = 2;
const HEALTH_RETENTION_DAYS = 14;
const DELETE_BATCH_SIZE = 250;
const DELETE_CHUNK_SIZE = 50;
const CHECKPOINT_KEY = "storage:backup:checkpoint";
const STATUS_KEY = "storage:backup:last";

function changes(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

function validCheckpoint(value) {
  const capturedThrough = Date.parse(value?.capturedThrough || "");
  return value?.status === "verified"
    && Number.isFinite(capturedThrough)
    && /^[a-f0-9]{64}$/i.test(String(value?.sha256 || ""))
    && String(value?.archiveId || "").startsWith("github-draft://");
}

async function readCheckpoint(env) {
  if (!env?.SNAPSHOT?.get) return null;
  const checkpoint = await env.SNAPSHOT.get(CHECKPOINT_KEY, "json");
  return validCheckpoint(checkpoint) ? checkpoint : null;
}

export async function recordBackupCheckpoint(env, value) {
  if (!env?.SNAPSHOT?.put || !validCheckpoint(value)) throw new Error("invalid_backup_checkpoint");
  const previous = await readCheckpoint(env);
  if (previous && Date.parse(value.capturedThrough) < Date.parse(previous.capturedThrough)) {
    throw new Error("backup_checkpoint_regression");
  }
  const checkpoint = {
    status: "verified",
    provider: "github-draft-release",
    capturedThrough: new Date(value.capturedThrough).toISOString(),
    verifiedAt: new Date().toISOString(),
    archiveId: String(value.archiveId).slice(0, 500),
    sha256: String(value.sha256).toLowerCase(),
    bytes: Math.max(0, Number(value.bytes || 0)),
  };
  await env.SNAPSHOT.put(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  return checkpoint;
}

async function deleteProtectedSnapshots(env, checkpoint, batchSize) {
  const selected = await env.DB.prepare(`SELECT snapshot_id FROM run_snapshots
    WHERE captured_at < datetime('now', ?1) AND captured_at <= ?2
    ORDER BY captured_at,snapshot_id LIMIT ?3`)
    .bind(`-${SNAPSHOT_RETENTION_DAYS} days`, checkpoint.capturedThrough, batchSize).all();
  const rows = selected?.results || [];
  let deleted = 0;
  for (let index = 0; index < rows.length; index += DELETE_CHUNK_SIZE) {
    const ids = rows.slice(index, index + DELETE_CHUNK_SIZE).map((row) => row.snapshot_id);
    const placeholders = ids.map((_, position) => `?${position + 1}`).join(",");
    const result = await env.DB.prepare(`DELETE FROM run_snapshots WHERE snapshot_id IN (${placeholders})`).bind(...ids).run();
    deleted += changes(result);
  }
  return { selected: rows.length, deleted };
}

/**
 * Keeps D1 bounded without deleting unprotected history. A snapshot is eligible
 * only after an independently verified full D1 export covers its capture time.
 * Missing, invalid or regressed backup checkpoints stop snapshot deletion.
 */
export async function pruneOperationalStorage(env, { snapshotPasses = 1, batchSize = DELETE_BATCH_SIZE } = {}) {
  if (!env?.DB) return { deletedRows: 0, healthRows: 0, status: "no_database" };
  const checkpoint = await readCheckpoint(env);
  let deletedRows = 0;
  if (checkpoint) {
    for (let pass = 0; pass < Math.max(1, snapshotPasses); pass += 1) {
      const result = await deleteProtectedSnapshots(env, checkpoint, Math.min(1_000, Math.max(1, batchSize)));
      deletedRows += result.deleted;
      if (result.selected < batchSize) break;
    }
  }
  const health = await env.DB.prepare("DELETE FROM source_health_checks WHERE checked_at < datetime('now', ?1) LIMIT ?2")
    .bind(`-${HEALTH_RETENTION_DAYS} days`, 5_000).run();
  const summary = {
    status: checkpoint ? "online" : "backup_unavailable",
    provider: "github-draft-release",
    checkedAt: new Date().toISOString(),
    deletedRows,
    healthRows: changes(health),
    protectedThrough: checkpoint?.capturedThrough || null,
    lastVerifiedAt: checkpoint?.verifiedAt || null,
    archiveId: checkpoint?.archiveId || null,
    snapshotRetentionDays: SNAPSHOT_RETENTION_DAYS,
    healthRetentionDays: HEALTH_RETENTION_DAYS,
  };
  if (env.SNAPSHOT?.put) await env.SNAPSHOT.put(STATUS_KEY, JSON.stringify(summary), { expirationTtl: 7 * 24 * 60 * 60 });
  return summary;
}

export const STORAGE_RETENTION = Object.freeze({
  snapshotDays: SNAPSHOT_RETENTION_DAYS,
  healthDays: HEALTH_RETENTION_DAYS,
  deleteBatchSize: DELETE_BATCH_SIZE,
  deleteChunkSize: DELETE_CHUNK_SIZE,
  checkpointKey: CHECKPOINT_KEY,
});
