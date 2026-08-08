import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("public map exposes freight as its own filter and diagnostic", async () => {
  const [html, app, formatters] = await Promise.all([
    source("../index.html"), source("../js/app-ukraine.js"), source("../js/formatters-ukraine.js"),
  ]);
  assert.match(html, /data-transport="freight"/);
  assert.match(html, /id="diagnostic-freight"/);
  assert.match(app, /object\.type==="freight"/);
  assert.match(app, /freightDetailTemplate/);
  assert.match(formatters, /freight\s*:/);
  assert.match(formatters, /OPERATION_LABELS\.freight_activity/);
  assert.match(formatters, /OPERATION_COLORS\.freight_activity/);
});

test("freight uses a dedicated corridor layer and never enters ordinary marker rendering", async () => {
  const map = await source("../js/map-view-ukraine.js");
  assert.match(map, /this\.freightLayer=L\.layerGroup\(\)\.addTo\(this\.map\)/);
  assert.match(map, /renderFreightCorridors\(objects\.filter\(\(object\)=>object\.type==="freight"\)/);
  assert.match(map, /if\(object\.type==="freight"\)return/);
  assert.match(map, /агрегированная грузовая активность, не точная позиция/);
  assert.match(map, /задержкой не менее 24 часов/);
});

test("freight snapshot is loaded separately from passenger fusion and remains non-positioned", async () => {
  const [client, store, materializer] = await Promise.all([
    source("../js/live-data-client.js"), source("../js/data-store-ukraine.js"), source("../js/freight-public-layer.js"),
  ]);
  assert.match(client, /loadFreightSnapshot/);
  assert.match(client, /freightPath/);
  assert.match(store, /materializePublicFreight/);
  assert.match(store, /freightRuns/);
  assert.match(materializer, /coordinates:\s*null/);
  assert.match(materializer, /freight_corridor_only/);
  assert.doesNotMatch(materializer, /latitude|longitude/);
});
