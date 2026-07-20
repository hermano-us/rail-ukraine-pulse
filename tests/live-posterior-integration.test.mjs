import test from "node:test";
import assert from "node:assert/strict";
import { estimatePosition } from "../js/data-store-ukraine.js";

const routeResult = {
  coordinates: [[30, 50], [30.5, 50.2], [31, 50.4]],
  anchorErrorKm: 1,
};

test("station evidence uses posterior positioning in the live data store", () => {
  const position = estimatePosition({
    trainNumber: "91",
    updatedAt: "2026-07-20T10:00:00Z",
    operationalStatus: "moving",
    positionEvidence: "reported-station-passage",
    sourceId: "uz-public-board",
    forecastArrival: "13:00",
  }, routeResult, new Date("2026-07-20T10:20:00Z"), 20, [30.25, 50.1]);

  assert.equal(position.method, "rail-posterior-v1");
  assert.equal(position.calculation.model, "station-anchored-posterior");
  assert.ok(position.probabilityCorridor.p90[0] <= position.probabilityCorridor.p50[0]);
  assert.ok(position.coordinates);
});

test("forecast-only live run retains the conservative corridor fallback", () => {
  const position = estimatePosition({
    trainNumber: "91",
    updatedAt: "2026-07-20T10:00:00Z",
    operationalStatus: "moving",
    reliability: "Висока",
    forecastArrival: "13:00",
  }, routeResult, new Date("2026-07-20T10:20:00Z"), 20);

  assert.equal(position.method, "rail-corridor-v5");
  assert.ok(position.errorKm >= 18);
});

