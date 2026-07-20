import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGeometricWaypoints,
  buildOfficialEvents,
  buildUncertaintyCorridor,
  hydrateSourceRegistry,
  sourceRegistrySummary,
} from "../js/evidence-engine.js";

const route = [[30, 50], [31, 50], [32, 50]];

test("official update becomes traceable events without inventing a position event", () => {
  const events = buildOfficialEvents({
    updatedAt: "2026-07-20T10:00:00Z",
    publicStatus: "В дорозі",
    delayLabel: "+0:25",
    delayMinutes: 25,
    forecastArrival: "16:40",
    reason: "Технічна причина",
  }, "uz:run");
  assert.deepEqual(events.map((event) => event.type), ["movement_status", "delay", "forecast_arrival", "disruption_reason"]);
  assert.ok(events.every((event) => event.authority === "official"));
  assert.ok(events.every((event) => event.type !== "position"));
});

test("uncertainty corridor is bounded by route and wider than a point", () => {
  const corridor = buildUncertaintyCorridor({
    errorKm: 20,
    calculation: { progress: 0.5 },
  }, route);
  assert.ok(corridor.fromKm >= 0);
  assert.ok(corridor.toKm <= corridor.totalKm);
  assert.ok(corridor.widthKm > 0);
  assert.ok(corridor.coordinates.length >= 2);
});

test("geometric waypoints are explicitly classified around the model corridor", () => {
  const corridor = buildUncertaintyCorridor({ errorKm: 10, calculation: { progress: 0.5 } }, route);
  const result = buildGeometricWaypoints(route, [
    { id: "a", name: "A", coordinates: [30.25, 50] },
    { id: "b", name: "B", coordinates: [31, 50] },
    { id: "c", name: "C", coordinates: [31.75, 50] },
  ], corridor);
  assert.equal(result.previous?.name, "A");
  assert.equal(result.next?.name, "C");
  assert.ok(result.waypoints.some((station) => station.phase === "inside-corridor"));
  assert.ok(result.waypoints.every((station) => station.evidence === "rail-geometry"));
});

test("source registry distinguishes connected sources from candidates", () => {
  const sources = hydrateSourceRegistry([
    { id: "live", state: "planned", authority: "official", capabilities: ["forecast"] },
    { id: "candidate", state: "candidate", authority: "official" },
    { id: "snapshot", state: "snapshot", authority: "community" },
  ], { live: { status: "online", checkedAt: "2026-07-20T09:55:00Z" } }, new Date("2026-07-20T10:00:00Z"));
  assert.equal(sources.find((source) => source.id === "live").ageMinutes, 5);
  assert.deepEqual(sourceRegistrySummary(sources), { total: 3, connected: 2, official: 2, realtime: 0 });
});
