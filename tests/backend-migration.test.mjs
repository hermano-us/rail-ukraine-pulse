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
  database.exec(historySql);
  database.exec(sql);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  assert.ok(tables.includes("runs"));
  assert.ok(tables.includes("events"));
  assert.ok(tables.includes("source_health"));
  assert.ok(tables.includes("run_snapshots"));
  assert.ok(tables.includes("segment_stats"));
  database.close();
});

