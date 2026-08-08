const SNAPSHOT_RETENTION_DAYS = 2;
const HEALTH_RETENTION_DAYS = 14;
const DELETE_BATCH_SIZE = 5_000;

function changes(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

/**
 * Keeps the free D1 operational store bounded. Run snapshots are a derived
 * timeline cache; immutable rail events and security audit records are not
 * touched here. Deletes are deliberately batched and run before new writes.
 */
export async function pruneOperationalStorage(env, { snapshotPasses = 1, batchSize = DELETE_BATCH_SIZE } = {}) {
  if (!env?.DB) return { snapshotRows: 0, healthRows: 0 };
  let snapshotRows = 0;
  for (let pass = 0; pass < Math.max(1, snapshotPasses); pass += 1) {
    const result = await env.DB.prepare("DELETE FROM run_snapshots WHERE captured_at < datetime('now', ?1) LIMIT ?2")
      .bind(`-${SNAPSHOT_RETENTION_DAYS} days`, batchSize).run();
    const removed = changes(result);
    snapshotRows += removed;
    if (removed < batchSize) break;
  }
  const health = await env.DB.prepare("DELETE FROM source_health_checks WHERE checked_at < datetime('now', ?1) LIMIT ?2")
    .bind(`-${HEALTH_RETENTION_DAYS} days`, batchSize).run();
  return { snapshotRows, healthRows: changes(health), snapshotRetentionDays: SNAPSHOT_RETENTION_DAYS, healthRetentionDays: HEALTH_RETENTION_DAYS };
}

export const STORAGE_RETENTION = Object.freeze({ snapshotDays: SNAPSHOT_RETENTION_DAYS, healthDays: HEALTH_RETENTION_DAYS, deleteBatchSize: DELETE_BATCH_SIZE });
