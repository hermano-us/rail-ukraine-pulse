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

test("public status snapshot keeps both train directions", async () => {
  const live = JSON.parse(await readFile(new URL("../data/live.json", import.meta.url), "utf8"));
  const train7980 = live.updates.filter((update) => update.trainNumber === "79/80");
  assert.equal(train7980.length, 2);
  assert.notEqual(train7980[0].origin, train7980[1].origin);
});

