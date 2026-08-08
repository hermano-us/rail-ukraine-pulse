import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildPublicFreightProjection } from "../backend/src/freight/public-projection.js";
import { FREIGHT_PUBLIC_POLICY } from "../shared/freight-public-policy.js";

test("legacy freight fallback keeps its no-position policy while dynamic publication remains aggregate-only", async () => {
  const freight = JSON.parse(await readFile(new URL("../data/freight-aggregates.json", import.meta.url), "utf8"));
  assert.equal(freight.dataMode, "aggregate-archive");
  assert.equal(freight.privacy.positionPrecision, "none");
  assert.equal(freight.privacy.liveRoutes, false);
  assert.ok(Array.isArray(freight.objects));
  assert.ok(freight.objects.every((item) => !Array.isArray(item.position?.coordinates)));

  const projection = buildPublicFreightProjection([], "2026-08-08T12:00:00.000Z");
  assert.equal(projection.dataMode, "delayed-probabilistic-freight");
  assert.equal(projection.policy.exactPositions, false);
  assert.equal(projection.policy.individualPublicPositions, false);
  assert.equal(FREIGHT_PUBLIC_POLICY.minimumDelayMinutes, 24 * 60);
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
