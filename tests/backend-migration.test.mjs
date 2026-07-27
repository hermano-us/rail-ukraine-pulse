import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const sqlite = await import("node:sqlite").catch(() => null);

test("D1 migration creates the event backend schema", {
  skip: sqlite ? false : "node:sqlite is unavailable on this supported Node version",
}, async () => {
  const sql = await readFile(new URL("../backend/migrations/0001_initial.sql", import.meta.url), "utf8");
  const historySql = await readFile(new URL("../backend/migrations/0003_run_history.sql", import.meta.url), "utf8");
  const database = new sqlite.DatabaseSync(":memory:");
  const observabilitySql = await readFile(new URL("../backend/migrations/0004_model_observability.sql", import.meta.url), "utf8");
  const fuelSql = await readFile(new URL("../backend/migrations/0005_fuel_platform.sql", import.meta.url), "utf8");
  const incidentSql = await readFile(new URL("../backend/migrations/0008_fuel_incidents.sql", import.meta.url), "utf8");
  const freightSql = await readFile(new URL("../backend/migrations/0009_freight_intelligence.sql", import.meta.url), "utf8");
  const secureCoreSql = await readFile(new URL("../backend/migrations/0010_secure_core.sql", import.meta.url), "utf8");
  const intelligencePlatformSql = await readFile(new URL("../backend/migrations/0011_intelligence_platform.sql", import.meta.url), "utf8");
  database.exec(historySql);
  database.exec(sql);
  database.exec(observabilitySql);
  database.exec(fuelSql);
  database.exec(incidentSql);
  database.exec(freightSql);
  database.exec(secureCoreSql);
  database.exec(intelligencePlatformSql);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  assert.ok(tables.includes("runs"));
  assert.ok(tables.includes("events"));
  assert.ok(tables.includes("source_health"));
  assert.ok(tables.includes("run_snapshots"));
  assert.ok(tables.includes("segment_stats"));
  assert.ok(tables.includes("model_evaluations"));
  assert.ok(tables.includes("source_health_checks"));
  assert.ok(tables.includes("fuel_stations"));
  assert.ok(tables.includes("fuel_current_state"));
  assert.ok(tables.includes("fuel_moderation_queue"));
  assert.ok(tables.includes("fuel_incident_signals"));
  assert.ok(tables.includes("freight_observations"));
  assert.ok(tables.includes("freight_source_health"));
  assert.ok(tables.includes("access_users"));
  assert.ok(tables.includes("access_sessions"));
  assert.ok(tables.includes("feature_flags"));
  assert.ok(tables.includes("restricted_evidence"));
  assert.ok(tables.includes("secure_audit"));
  assert.ok(tables.includes("rail_nodes"));
  assert.ok(tables.includes("rail_edges"));
  assert.ok(tables.includes("rail_observations"));
  assert.ok(tables.includes("twin_predictions"));
  assert.ok(tables.includes("trajectory_points"));
  assert.ok(tables.includes("ops_movements"));
  assert.ok(tables.includes("ops_workflows"));
  assert.ok(tables.includes("ops_notifications"));
  assert.ok(tables.includes("node_activity_scores"));
  assert.ok(tables.includes("network_anomalies"));
  assert.ok(tables.includes("international_corridors"));
  assert.ok(tables.includes("intelligence_cycles"));
  database.close();
});

