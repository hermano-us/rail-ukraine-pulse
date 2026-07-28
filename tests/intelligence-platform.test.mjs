import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculateNodeActivity, classifyActivityAnomaly, evaluatePrediction, normalizeOperationalCoordinates, reconstructTrajectory } from "../backend/src/intelligence/service.js";

test("Node Activity Score is bounded and reacts to a material traffic spike", () => {
  const normal = calculateNodeActivity({ observations: 3, uniqueRuns: 2, baselinePerHour: 3, freshness: 1 });
  const spike = calculateNodeActivity({ observations: 18, uniqueRuns: 12, baselinePerHour: 3, freshness: 1 });
  assert.ok(normal.score >= 0 && normal.score <= 100);
  assert.ok(spike.score > normal.score);
  assert.equal(spike.changeRatio, 6);
  assert.deepEqual(classifyActivityAnomaly({ observations: 18, baselinePerHour: 3, changeRatio: 6 }), { type: "activity_spike", severity: "high", score: 0.75 });
});

test("activity collapse is detected only when a meaningful baseline exists", () => {
  assert.equal(classifyActivityAnomaly({ observations: 0, baselinePerHour: 1, changeRatio: 0 }), null);
  assert.deepEqual(classifyActivityAnomaly({ observations: 0, baselinePerHour: 5, changeRatio: 0 }), { type: "activity_drop", severity: "medium", score: 0.5 });
});

test("digital twin evaluation calculates MAE and P80 coverage from a later fact", () => {
  const prediction = { etaP50: "2026-07-27T12:30:00Z", etaP80Start: "2026-07-27T12:20:00Z", etaP80End: "2026-07-27T12:45:00Z" };
  assert.deepEqual(evaluatePrediction(prediction, "2026-07-27T12:38:00Z"), { absoluteErrorMinutes: 8, withinP80: true });
  assert.deepEqual(evaluatePrediction(prediction, "2026-07-27T13:00:00Z"), { absoluteErrorMinutes: 30, withinP80: false });
});

test("trajectory reconstruction is chronological and never invents coordinates", () => {
  const trajectory = reconstructTrajectory([
    { nodeId: "b", observedAt: "2026-07-27T12:20:00Z" },
    { nodeId: "a", observedAt: "2026-07-27T12:00:00Z", latitude: 50.45, longitude: 30.52 },
  ]);
  assert.deepEqual(trajectory.map((item) => item.nodeId), ["a", "b"]);
  assert.equal(trajectory[0].reconstructionMethod, "confirmed-coordinate");
  assert.equal(trajectory[1].reconstructionMethod, "station-graph-anchor");
  assert.equal("latitude" in trajectory[1], false);
});

test("Operations Center exposes all three protected platform surfaces", async () => {
  const [html, admin, css, worker, access] = await Promise.all([
    readFile(new URL("../rail-ops-center.html", import.meta.url), "utf8"),
    readFile(new URL("../js/admin.js", import.meta.url), "utf8"),
    readFile(new URL("../css/admin.css", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/worker.js", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/security/access.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Rail Intelligence/);
  assert.match(html, /Operations Hub/);
  assert.match(html, /Analytics Network/);
  assert.match(html, /operations-map/);
  assert.match(html, /<\/section>\s*<section class="panel">\s*<header[^>]*><div><p class="eyebrow">FUEL SAFETY WATCH/);
  assert.match(admin, /loadPlatformSuite/);
  assert.match(admin, /renderOperationsMap/);
  assert.match(admin, /FREIGHT_CORRIDOR_GEOMETRY/);
  assert.match(admin, /freightStationFacts/);
  assert.match(admin, /validUkraineOperationsPoint/);
  assert.match(admin, /coordinate-order-repaired|coordinateQuality/);
  assert.match(html, /freight-track-rows/);
  assert.match(html, /«Прочитано» закрывает только уведомление/);
  assert.match(admin, /ops-freight-arrow/);
  const api = await readFile(new URL("../backend/src/intelligence/api.js", import.meta.url), "utf8");
  assert.match(api, /freightCorridors:freightLayer\.corridors/);
  assert.match(admin, /if \(config\.apiBase\)[\s\S]*railIntelligenceEndpoint = new URL/);
  assert.doesNotMatch(admin, /async function refresh\(\)[\s\S]{0,180}new URL\([^\n]+base/);
  assert.doesNotMatch(admin, /function formatDate\([^)]*\)\s*\{\s*let operationsMap/);
  assert.match(css, /platform-tabs/);
  assert.match(css, /operations-map/);
  assert.match(worker, /handleIntelligencePlatformRequest/);
  assert.match(worker, /scheduledAutonomy/);
  assert.match(access, /rail\.intelligence\.read/);
  assert.match(access, /analytics\.network\.read/);
});

test("operational coordinate guard repairs swapped Ukraine coordinates and rejects foreign points", () => {
  assert.deepEqual(normalizeOperationalCoordinates({ lat: 30.52, lon: 50.45 }), { latitude: 50.45, longitude: 30.52, coordinateQuality: "coordinate-order-repaired", rejected: false });
  assert.deepEqual(normalizeOperationalCoordinates({ coordinates: [30.52, 50.45] }), { latitude: 50.45, longitude: 30.52, coordinateQuality: "geojson-pair", rejected: false });
  const rejected=normalizeOperationalCoordinates({ latitude: 25.1, longitude: 55.2 });
  assert.equal(rejected.latitude, null); assert.equal(rejected.longitude, null); assert.equal(rejected.coordinateQuality, "outside-ukraine-rejected"); assert.equal(rejected.rejected, true);
});
