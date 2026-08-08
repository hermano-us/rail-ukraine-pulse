const SNAPSHOT_RETENTION_DAYS = 2;
const HEALTH_RETENTION_DAYS = 14;
const ARCHIVE_BATCH_SIZE = 250;
const DELETE_CHUNK_SIZE = 50;

function changes(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

function archiveFingerprint(rows) {
  let hash = 2166136261;
  for (const row of rows) {
    for (const char of `${row.snapshot_id}|${row.captured_at}\n`) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function archiveKey(rows) {
  const first = String(rows[0]?.captured_at || "unknown");
  const last = String(rows.at(-1)?.captured_at || first);
  const day = first.slice(0, 10).replaceAll("-", "/");
  const safeTime = (value) => value.replace(/[^0-9]/g, "").slice(0, 17);
  return `run-snapshots/${day}/${safeTime(first)}-${safeTime(last)}-${rows.length}-${archiveFingerprint(rows)}.ndjson.gz`;
}

async function gzipNdjson(rows) {
  const payload = `${rows.map((row) => JSON.stringify({
    schemaVersion: 1,
    snapshotId: row.snapshot_id,
    runId: row.run_id,
    capturedAt: row.captured_at,
    sourceUpdatedAt: row.source_updated_at,
    updateJson: row.update_json,
  })).join("\n")}\n`;
  if (typeof CompressionStream === "undefined") return { body: payload, encoding: "identity" };
  const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip"));
  return { body: await new Response(stream).arrayBuffer(), encoding: "gzip" };
}

async function deleteArchivedSnapshots(env, rows) {
  let removed = 0;
  for (let index = 0; index < rows.length; index += DELETE_CHUNK_SIZE) {
    const ids = rows.slice(index, index + DELETE_CHUNK_SIZE).map((row) => row.snapshot_id);
    const placeholders = ids.map((_, position) => `?${position + 1}`).join(",");
    const result = await env.DB.prepare(`DELETE FROM run_snapshots WHERE snapshot_id IN (${placeholders})`).bind(...ids).run();
    removed += changes(result);
  }
  return removed;
}

async function archiveSnapshotBatch(env, batchSize) {
  const result = await env.DB.prepare(`SELECT snapshot_id,run_id,captured_at,source_updated_at,update_json
    FROM run_snapshots WHERE captured_at < datetime('now', ?1)
    ORDER BY captured_at,snapshot_id LIMIT ?2`).bind(`-${SNAPSHOT_RETENTION_DAYS} days`, batchSize).all();
  const rows = result?.results || [];
  if (!rows.length) return { selected: 0, archived: 0, deleted: 0, key: null };
  const key = archiveKey(rows);
  const archive = await gzipNdjson(rows);
  const body = typeof archive.body === "string" ? new TextEncoder().encode(archive.body).buffer : archive.body;
  const checksum = await crypto.subtle.digest("SHA-256", body);
  const checksumHex = [...new Uint8Array(checksum)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const stored = await env.ARCHIVE.put(key, body, {
    sha256: checksum,
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: archive.encoding === "gzip" ? "gzip" : undefined },
    customMetadata: {
      schemaVersion: "1", recordType: "run_snapshots", records: String(rows.length),
      firstCapturedAt: String(rows[0].captured_at), lastCapturedAt: String(rows.at(-1).captured_at),
      identity: "snapshot_id", encoding: archive.encoding, sha256: checksumHex,
    },
  });
  if (!stored) throw new Error(`R2 archive write was not committed: ${key}`);
  const deleted = await deleteArchivedSnapshots(env, rows);
  return { selected: rows.length, archived: rows.length, deleted, key };
}

/**
 * Keeps the free D1 operational store bounded. Run snapshots are a derived
 * timeline cache; immutable rail events and security audit records are not
 * touched here. A snapshot is deleted only after its self-describing NDJSON
 * archive object has been committed to R2. Replays deduplicate by snapshotId.
 */
export async function pruneOperationalStorage(env, { snapshotPasses = 1, batchSize = ARCHIVE_BATCH_SIZE } = {}) {
  if (!env?.DB) return { archivedRows: 0, deletedRows: 0, healthRows: 0, status: "no_database" };
  let archivedRows = 0; let deletedRows = 0; const objects = [];
  const archiveEnabled = Boolean(env.ARCHIVE?.put);
  for (let pass = 0; pass < Math.max(1, snapshotPasses); pass += 1) {
    if (!archiveEnabled) break;
    const result = await archiveSnapshotBatch(env, Math.min(1_000, Math.max(1, batchSize)));
    archivedRows += result.archived; deletedRows += result.deleted;
    if (result.key) objects.push(result.key);
    if (result.selected < batchSize) break;
  }
  const health = await env.DB.prepare("DELETE FROM source_health_checks WHERE checked_at < datetime('now', ?1) LIMIT ?2")
    .bind(`-${HEALTH_RETENTION_DAYS} days`, 5_000).run();
  const summary = {
    status: archiveEnabled ? "online" : "archive_unavailable",
    checkedAt: new Date().toISOString(), archivedRows, deletedRows, healthRows: changes(health), objects,
    snapshotRetentionDays: SNAPSHOT_RETENTION_DAYS, healthRetentionDays: HEALTH_RETENTION_DAYS,
  };
  if (env.SNAPSHOT?.put) await env.SNAPSHOT.put("storage:archive:last", JSON.stringify(summary), { expirationTtl: 7 * 24 * 60 * 60 });
  return summary;
}

export const STORAGE_RETENTION = Object.freeze({ snapshotDays: SNAPSHOT_RETENTION_DAYS, healthDays: HEALTH_RETENTION_DAYS, archiveBatchSize: ARCHIVE_BATCH_SIZE, deleteChunkSize: DELETE_CHUNK_SIZE });
