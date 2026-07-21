import test from "node:test";
import assert from "node:assert/strict";
import { estimatePosterior } from "../backend/src/domain/posterior.js";

test("posterior produces nested probability corridors along the route", () => {
  const result = estimatePosterior({
    now: "2026-07-20T10:30:00Z",
    routeLengthKm: 300,
    anchors: [{
      routeDistanceKm: 80, occurredAt: "2026-07-20T10:00:00Z",
      errorKm: 2, reliability: 0.9,
    }],
    schedule: [{ routeDistanceKm: 160, expectedAt: "2026-07-20T11:00:00Z", p10Minutes: 52, p90Minutes: 70 }],
  });
  assert.equal(result.status, "estimated");
  assert.equal(result.method, "rail-posterior-v3");
  assert.ok(result.distanceKm > 110 && result.distanceKm < 130);
  assert.ok(result.corridor.p90[0] <= result.corridor.p50[0]);
  assert.ok(result.corridor.p90[1] >= result.corridor.p50[1]);
  assert.ok(result.corridor.p80[0] <= result.corridor.p50[0]);
  assert.ok(result.corridor.p95[1] >= result.corridor.p90[1]);
  assert.ok(result.confidence > 0 && result.confidence < 1);
  assert.ok(result.errorKm > 0);
});

test("posterior freezes after 90 minutes and expires after 180", () => {
  const base = {
    routeLengthKm: 300,
    anchors: [{ routeDistanceKm: 80, occurredAt: "2026-07-20T10:00:00Z", reliability: 0.9 }],
  };
  assert.equal(estimatePosterior({ ...base, now: "2026-07-20T11:31:00Z" }).status, "stale");
  assert.equal(estimatePosterior({ ...base, now: "2026-07-20T13:01:00Z" }).status, "unknown");
});

test("posterior never invents a position without an anchor", () => {
  assert.equal(estimatePosterior({ now: "2026-07-20T10:00:00Z", routeLengthKm: 300 }).status, "unknown");
});

