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
  assert.match(importer, /fetchWithRetry/);
});

test("fuel map keeps dense catalogs clustered and uses the rail dark treatment", async () => {
  const api = await readFile(new URL("../backend/src/fuel/api.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../fuel/js/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../fuel/css/fuel.css", import.meta.url), "utf8");
  const importer = await readFile(new URL("../scripts/import-osm-fuel.mjs", import.meta.url), "utf8");
  assert.match(api, /zoom < 11/); assert.match(api, /cellByZoom/);
  assert.match(app, /Math\.min\(11/); assert.match(app, /station-hero/);
  assert.match(css, /leaflet-tile-pane.*brightness\(\.57\)/);
  assert.match(css, /\.details\{position:absolute;[^}]*top:72px;[^}]*bottom:18px;[^}]*max-height:none/);
  assert.match(css, /@media\(max-width:850px\).*\.details\{top:64px;[^}]*bottom:8px/s);
  assert.match(importer, /wikimedia_commons/); assert.match(importer, /upload\.wikimedia\.org/);
});
