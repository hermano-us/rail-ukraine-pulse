import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTwinHypotheses, calculateNodeActivity, classifyActivityAnomaly, evaluatePrediction, interpolateRailGeometry, normalizeOperationalCoordinates, reconstructTrajectory } from "../backend/src/intelligence/service.js";

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
  assert.match(html, /<\/section>\s*<section id="fuel-safety-panel" class="panel collapsible-panel">\s*<header[^>]*><div><p class="eyebrow">FUEL SAFETY WATCH/);
  assert.match(admin, /loadPlatformSuite/);
  assert.match(admin, /renderOperationsMap/);
  assert.match(admin, /FREIGHT_CORRIDOR_GEOMETRY/);
  assert.match(admin, /freightStationFacts/);
  assert.match(admin, /validUkraineOperationsPoint/);
  assert.match(admin, /entityResolutionRows:\s*document\.querySelector\("#entity-resolution-rows"\)/);
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

test("probabilistic twin v2 keeps alternatives, freshness and strict rail geometry", () => {
  const geometry={type:"LineString",coordinates:[[30,50],[31,50]]};
  const midpoint=interpolateRailGeometry(geometry,.5);
  assert.ok(Math.abs(midpoint.longitude-30.5)<.01);
  assert.equal(interpolateRailGeometry({type:"LineString",coordinates:[[55,25],[56,26]]},.5),null);
  const event={event_id:"event-1",run_id:"run-1",train_number:"91",station:"Київ",occurred_at:"2026-07-28T10:00:00Z",reliability:.9};
  const candidates=[
    {from_station_id:"київ",to_station_id:"львів",train_family:"91",sample_count:30,p10_minutes:290,p50_minutes:320,p90_minutes:370,reliability:.9,geometry_json:JSON.stringify(geometry),distance_km:540},
    {from_station_id:"київ",to_station_id:"вінниця",train_family:"generic",sample_count:18,p10_minutes:120,p50_minutes:150,p90_minutes:190,reliability:.75},
  ];
  const result=buildTwinHypotheses({event,candidates,now:"2026-07-28T10:30:00Z",routeHint:"Київ Львів"});
  assert.equal(result.state.method,"station-graph-probabilistic-twin-v2");
  assert.equal(result.state.positionStatus,"estimated");
  assert.equal(result.hypotheses.length,2);
  assert.ok(Math.abs(result.hypotheses.reduce((sum,item)=>sum+item.probability,0)-1)<.001);
  assert.ok(result.hypotheses[0].probability>result.hypotheses[1].probability);
  assert.ok(Number.isFinite(result.hypotheses[0].latitude));
  assert.equal(result.hypotheses[1].latitude,null,"no coordinate is invented without rail geometry");
  const stale=buildTwinHypotheses({event,candidates,now:"2026-07-28T12:00:00Z"});
  assert.equal(stale.state.positionStatus,"stale");
  const unknown=buildTwinHypotheses({event,candidates,now:"2026-07-28T15:00:00Z"});
  assert.equal(unknown.state.positionStatus,"unknown");
  assert.equal(unknown.state.latitude,null);
});

test("Operations Center exposes persistent collapsible registries and v2 state", async () => {
  const [html,admin,css,migration,api]=await Promise.all([
    readFile(new URL("../rail-ops-center.html",import.meta.url),"utf8"),
    readFile(new URL("../js/admin.js",import.meta.url),"utf8"),
    readFile(new URL("../css/admin.css",import.meta.url),"utf8"),
    readFile(new URL("../backend/migrations/0013_rail_intelligence_v2.sql",import.meta.url),"utf8"),
    readFile(new URL("../backend/src/intelligence/api.js",import.meta.url),"utf8"),
  ]);
  assert.match(html,/data-collapse-key="rail-twins"/);
  assert.match(html,/data-collapse-key="event-ledger"/);
  assert.match(admin,/initializeCollapsibleLists/);
  assert.match(html,/class="section-jump"/);
  assert.match(html,/id="platform-suite" class="platform-suite panel collapsible-panel"/);
  assert.match(admin,/initializeLargePanels/);
  assert.match(admin,/rail-ops-panel:/);
  assert.match(css,/\.collapsible-panel\.panel-collapsed/);
  assert.match(admin,/localStorage\.setItem/);
  assert.match(css,/\.collapsible-list>summary/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS twin_states/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS twin_hypotheses/);
  assert.match(api,/activeHypotheses/);
  assert.match(admin,/renderSelectedTwinLayer/);
  assert.match(html,/data-collapse-key="entity-resolution"/);
  assert.match(admin,/resolveObservationLink/);
  assert.match(admin,/estimatedCompletionAt/);
  assert.match(css,/entity-resolution-actions/);
});
