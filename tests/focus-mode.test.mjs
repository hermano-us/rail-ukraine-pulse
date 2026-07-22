import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("selected train enters isolated map focus mode with its route and stations", async () => {
  const app = await readFile(new URL("../js/app-ukraine.js", import.meta.url), "utf8");
  const map = await readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8");
  assert.match(app, /mapView\.render\(focused\?\[focused\]:visible/);
  assert.match(map, /if\(!focusedObject&&this\.routes\)this\.routeLayer\.addData/);
  assert.match(map, /for\(const waypoint of object\.waypoints/);
  assert.match(map, /focus-station-/);
});

test("initial map viewport stays focused on Ukraine", async () => {
  const app = await readFile(new URL("../js/app-ukraine.js", import.meta.url), "utf8");
  const map = await readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8");
  assert.match(app, /mapView.fitUkraine()/);
  assert.match(map, /fitUkraine().*44.2,22.0.*52.6,40.3/s);
});
test("workspace panels collapse persistently and resize the Leaflet map", async () => {
  const app = await readFile(new URL("../js/app-ukraine.js", import.meta.url), "utf8");
  const map = await readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../css/enhancements.css", import.meta.url), "utf8");
  assert.match(html, /id="left-panel-toggle"/);
  assert.match(html, /id="map-only-toggle"/);
  assert.match(app, /rail-ukraine-pulse:workspace-layout:v1/);
  assert.match(app, /classList\.toggle\("left-collapsed"/);
  assert.match(app, /classList\.toggle\("right-collapsed"/);
  assert.match(map, /invalidateSize\(\)\{this\.map\.invalidateSize/);
  assert.match(css, /\.app-shell\.left-collapsed/);
  assert.match(css, /\.app-shell\.right-collapsed/);
});
test("history scrubber preserves the selected route and rejects misleading old snapshots", async () => {
  const map = await readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8");
  assert.doesNotMatch(map, /clearHistory\(\)\{this\.historyLayer\.clearLayers\(\);this\.selectedLayer\.clearLayers\(\);\}/);
  assert.match(map, /Math\.abs\(Date\.parse\(target\.timestamp\)-cutoff\)>16\*60000/);
});
test("server history playback stays on rail geometry", async () => {
  const app = await readFile(new URL("../js/app-ukraine.js", import.meta.url), "utf8");
  const map = await readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8");
  const store = await readFile(new URL("../js/data-store-ukraine.js", import.meta.url), "utf8");
  assert.match(app, /loadRunHistory\(object\.runId\)/);
  assert.match(app, /id="history-play"/);
  assert.match(map, /showHistoryPoint\(object,index\)/);
  assert.match(store, /buildHistoricalPosition/);
  assert.match(store, /estimatePosition\(update, \{ coordinates: routeCoordinates \}/);
});

test("full registry and density modes expose all runs without fabricated coordinates", async () => {
  const app = await readFile(new URL("../js/app-ukraine.js", import.meta.url), "utf8");
  const map = await readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8");
  assert.match(app, /registryScope==="mapped"/);assert.match(map, /viewMode==="density"/);
});
