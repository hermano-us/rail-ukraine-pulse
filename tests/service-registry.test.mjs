import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canonicalServiceKey, fuseServiceUpdates, groupStationQueues, positionAdmission, stationQueueForUpdate,
} from "../js/service-registry.js";
import { OPERATION_LABELS } from "../js/formatters-ukraine.js";

const now = new Date("2026-08-01T10:00:00.000Z");
const base = {
  trainNumber: "091", route: "Київ → Львів", origin: "Київ", destination: "Львів",
  updatedAt: now.toISOString(), sourceId: "anytrain-uz-station-board",
};

test("canonical registry fuses the same dated direction but preserves opposite services", () => {
  const planned = { ...base, positionEvidence: "schedule-only", operationalStatus: "planned", boardStation: "Київ", scheduledStationAt: "2026-08-01T11:00:00.000Z" };
  const fact = { ...base, positionEvidence: "station-board-window", operationalStatus: "station", reportedStation: "Київ", boardStation: "Київ", sourceId: "uz-public-board" };
  const reverse = { ...base, route: "Львів → Київ", origin: "Львів", destination: "Київ", positionEvidence: "schedule-only", operationalStatus: "planned" };
  const fused = fuseServiceUpdates([planned, fact, reverse], now);
  assert.equal(fused.length, 2);
  const forward = fused.find((item) => item.origin === "Київ");
  assert.equal(forward.observationCount, 2);
  assert.equal(forward.hasOperationalObservation, true);
  assert.equal(forward.registryState, "at_station");
  assert.equal(forward.positionEvidence, "station-board-window");
  assert.deepEqual(new Set(forward.sourceIds), new Set(["anytrain-uz-station-board", "uz-public-board"]));
  assert.match(canonicalServiceKey(forward, now), /^uz:2026-08-01:091:/);
});

test("schedule-only service cannot fabricate a current position", () => {
  const admission = positionAdmission({ ...base, positionEvidence: "schedule-only", operationalStatus: "planned", forecastDeparture: "13:00" }, { hasRoute: true, sourceAgeMinutes: 5 });
  assert.equal(admission.allowed, false);
  assert.equal(admission.allowReported, false);
  assert.equal(admission.allowCalculated, false);
  assert.equal(admission.reasonCode, "planned_only");
});

test("moving service needs real rail geometry and a forecast before calculation", () => {
  const moving = { ...base, operationalStatus: "moving", positionEvidence: "none", forecastArrival: "15:00" };
  assert.equal(positionAdmission(moving, { hasRoute: false, sourceAgeMinutes: 5 }).reasonCode, "route_unavailable");
  assert.equal(positionAdmission(moving, { hasRoute: true, sourceAgeMinutes: 5 }).allowCalculated, true);
});

test("station queues distinguish confirmed depot from expected board departure", () => {
  const depot = stationQueueForUpdate({ ...base, operationalStatus: "depot", reportedStation: "Київ" }, now);
  const waiting = stationQueueForUpdate({ ...base, operationalStatus: "station", positionEvidence: "station-board-window", reportedStation: "Київ", boardType: "departure" }, now);
  assert.equal(depot.state, "depot");
  assert.equal(depot.evidence, "confirmed");
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.evidence, "station-window");

  const groups = groupStationQueues([
    { id: "a", trainNumber: "91", route: base.route, stationQueue: { ...depot, coordinates: [30.48, 50.44] }, liveUpdate: {} },
    { id: "b", trainNumber: "92", route: base.route, stationQueue: { ...waiting, coordinates: [30.48, 50.44] }, liveUpdate: {} },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[0].confirmedCount, 1);
  assert.equal(groups[0].waitingCount, 1);
});

test("public UI exposes registry diagnostics and expandable station groups", async () => {
  const [html, app, map, store] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../js/app-ukraine.js", import.meta.url), "utf8"),
    readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8"),
    readFile(new URL("../js/data-store-ukraine.js", import.meta.url), "utf8"),
  ]);
  assert.ok(OPERATION_LABELS.planned);
  assert.match(html, /diagnostic-observations/);
  assert.match(html, /diagnostic-planned/);
  assert.match(app, /positionAdmission\.reason/);
  assert.match(app, /state\.data\.stationQueues/);
  assert.match(map, /renderStationQueues/);
  assert.match(map, /station-queue-entry/);
  assert.doesNotMatch(store, /stationCoordinates\(update\.reportedStation,stationLookup\)\|\|origin/);
});
