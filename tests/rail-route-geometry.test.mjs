import test from "node:test";
import assert from "node:assert/strict";
import { buildRailGraph, railPath, railPathViaAnchor } from "../js/data-store-ukraine.js";

const feature = (coordinates) => ({ geometry: { type: "LineString", coordinates } });

test("reported station becomes a route anchor when the detour is credible", () => {
  const graph = buildRailGraph([
    feature([[30, 50], [32, 50]]),
    feature([[30, 50], [31, 50.1], [32, 50]]),
  ]);
  const direct = railPath(graph, [30, 50], [32, 50]);
  const anchored = railPathViaAnchor(graph, [30, 50], [32, 50], [31, 50.1]);
  assert.ok(direct.totalKm < anchored.totalKm);
  assert.equal(anchored.viaAnchor, true);
  assert.ok(anchored.coordinates.some(([lng, lat]) => lng === 31 && lat === 50.1));
});

test("implausible reported station cannot distort the route", () => {
  const graph = buildRailGraph([feature([[30, 50], [31, 50], [32, 50]])]);
  const direct = railPath(graph, [30, 50], [32, 50]);
  const result = railPathViaAnchor(graph, [30, 50], [32, 50], [35, 52]);
  assert.deepEqual(result.coordinates, direct.coordinates);
  assert.equal(result.viaAnchor, undefined);
});
