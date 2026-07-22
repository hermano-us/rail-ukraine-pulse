import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("fuel map is a separate real-data product with fast rail switch", async () => {
  const html = await readFile(new URL("../fuel/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../fuel/js/app.js", import.meta.url), "utf8");
  const rail = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../fuel/js/api-client.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build-web.mjs", import.meta.url), "utf8");
  assert.match(html, /href="\.\.\/"/); assert.match(rail, /href="fuel\/"/); assert.match(build, /"fuel"/);
  assert.match(app, /api\/fuel\/v1\/stations/); assert.doesNotMatch(app, /demo|mockStation|sampleStation/i);
  assert.match(client, /fetch\("\.\.\/data\/runtime-config\.json"/);
});

test("OSM importer refuses empty catalogs and has no demo fallback", async () => {
  const importer = await readFile(new URL("../scripts/import-osm-fuel.mjs", import.meta.url), "utf8");
  assert.match(importer, /amenity.*fuel/); assert.match(importer, /refusing to publish an empty catalog/); assert.doesNotMatch(importer, /fallbackStations|demoData/i);
});
