import test from "node:test";
import assert from "node:assert/strict";
import { estimatePosition, buildStationPlan } from "../js/data-store-ukraine.js";

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

  assert.equal(position.method, "rail-posterior-v3");
  assert.equal(position.calculation.model, "station-anchored-posterior-v3");
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

  assert.equal(position.method, "rail-corridor-v6");
  assert.ok(position.errorKm >= 18);
});


test("digital twin builds a dated station plan with one next station", () => {
  const position={calculatedAt:"2026-07-21T07:00:00Z",calculation:{totalKm:200,progress:.42}};
  const plan=buildStationPlan([{name:"A",distanceKm:0},{name:"B",distanceKm:100},{name:"C",distanceKm:200}],{sourceId:"uz-delay-dashboard",reportedStation:"A",updatedAt:"2026-07-21T06:00:00Z"},position,"2026-07-21T09:00:00Z");
  assert.equal(plan.length,3);assert.equal(plan[0].status,"confirmed");assert.equal(plan.filter(item=>item.status==="model-next").length,1);
});