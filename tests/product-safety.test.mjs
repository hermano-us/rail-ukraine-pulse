import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("freight layer is aggregate-only and has no operational positions", async () => {
  const freight = JSON.parse(await readFile(new URL("../data/freight-aggregates.json", import.meta.url), "utf8"));
  assert.equal(freight.dataMode, "aggregate-archive");
  assert.equal(freight.privacy.positionPrecision, "none");
  assert.equal(freight.privacy.liveRoutes, false);
  assert.deepEqual(freight.objects, []);
});

test("oblast polygons cannot change filters by map click", async () => {
  const source = await readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8");
  assert.match(source, /interactive:\s*false/);
  assert.doesNotMatch(source, /onRegionSelect|layer\.on\("click"/);
});

test("public status snapshot does not collapse directional services", async () => {
  const live = JSON.parse(await readFile(new URL("../data/live.json", import.meta.url), "utf8"));
  const keys = live.updates.map((update) => `${update.trainNumber}|${update.origin}|${update.destination}`);
  assert.equal(new Set(keys).size, keys.length);
});


test("fuel public API contains no stock quantities or supply movement endpoints", async () => {
  const api = await readFile(new URL("../backend/src/fuel/api.js", import.meta.url), "utf8");
  const domain = await readFile(new URL("../backend/src/fuel/domain.js", import.meta.url), "utf8");
  assert.doesNotMatch(api, /stock[_-]?(amount|quantity)|tanker|delivery[_-]?route/i);
  assert.match(domain, /damaged_reported/);
  assert.match(api, /public_status/);
});
