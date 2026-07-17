import test from "node:test";
import assert from "node:assert/strict";
import { buildRouteMeasure, estimateTrainPosition, interpolateAlongRoute } from "../js/positioning.js";

test("interpolation follows every segment of the route instead of a straight chord", () => {
  const measure = buildRouteMeasure([[0, 0], [0, 1], [1, 1]]);
  const midpoint = interpolateAlongRoute(measure, measure.totalKm / 2);
  assert.ok(Math.abs(midpoint[0]) < 0.01, `longitude ${midpoint[0]} should still be near the bend`);
  assert.ok(Math.abs(midpoint[1] - 1) < 0.01, `latitude ${midpoint[1]} should be near the bend`);
});

test("estimated position exposes confidence, error, method and last confirmation", () => {
  const route = { properties: { quality: 0.95 }, geometry: { type: "LineString", coordinates: [[24, 60], [24.5, 60.5], [25, 60]] } };
  const train = {
    schedule: [
      { id: "a", plannedAt: "2026-01-01T10:00:00Z", actualAt: "2026-01-01T10:02:00Z", eventStatus: "confirmed", coordinates: [24, 60] },
      { id: "b", plannedAt: "2026-01-01T11:00:00Z", delayMinutes: 2, eventStatus: "scheduled", coordinates: [25, 60] },
    ],
  };
  const position = estimateTrainPosition(train, route, new Date("2026-01-01T10:32:00Z"));
  assert.equal(position.status, "estimated");
  assert.ok(position.confidence > 0 && position.confidence < 1);
  assert.ok(position.errorKm > 0);
  assert.equal(position.method, "schedule-route-interpolation");
  assert.equal(position.lastConfirmedAt, "2026-01-01T10:02:00.000Z");
  assert.ok(position.sources.includes("rail-geometry"));
  assert.ok(position.coordinates[1] > 60.45, "position should follow the northern bend");
});

test("old direct position becomes stale", () => {
  const train = { position: { status: "confirmed", coordinates: [25, 60], updatedAt: "2026-01-01T09:00:00Z" } };
  const position = estimateTrainPosition(train, null, new Date("2026-01-01T10:00:00Z"));
  assert.equal(position.status, "stale");
  assert.ok(position.confidence <= 0.35);
});

test("missing route and schedule produces unknown, never a fabricated point", () => {
  const position = estimateTrainPosition({ schedule: [] }, null, new Date("2026-01-01T10:00:00Z"));
  assert.equal(position.status, "unknown");
  assert.equal(position.coordinates, null);
  assert.equal(position.confidence, 0);
});

