import test from "node:test";
import assert from "node:assert/strict";
import { collectorCircuit, dynamicRequestBudget, enrichPriorities, priorityTier } from "../backend/src/intelligence/data-reliability.js";
import { fuseObservationRowsV4 } from "../backend/src/intelligence/observation-fusion-v3.js";
import { applyCalibrationV4, applyCalibrationV5, calibrationDimensionsV4 } from "../backend/src/intelligence/calibration-v4.js";
import { scoreRunCandidateDetails } from "../backend/src/intelligence/observation-linker.js";

test("data reliability tiers urgent stations and opens a bounded circuit", () => {
  assert.equal(priorityTier({ silentRuns: 2, priorityScore: 30 }), "critical");
  assert.equal(priorityTier({ expectedRuns: 1, priorityScore: 20 }), "corridor");
  assert.deepEqual(collectorCircuit({ consecutiveFailures: 5, now: "2026-07-29T12:00:00Z" }), { state: "open", retryAfterMinutes: 5 });
  assert.equal(dynamicRequestBudget({ urgentStations: 20, activeCollectors: 2 }), 4);
  const [enriched] = enrichPriorities([{ stationId: "kyiv", priorityScore: 75 }], [{ station_id: "kyiv", consecutive_failures: 5, updated_at: "2026-07-29T11:59:00Z" }], "2026-07-29T12:00:00Z");
  assert.equal(enriched.priorityTier, "critical");
  assert.equal(enriched.circuitState, "open");
  assert.ok(enriched.nextEligibleAt);
});

test("fusion v5 does not count correlated Telegram feeds as independent evidence", () => {
  const events = [
    { event_id: "a", run_id: "r", train_number: "91", station: "Kyiv", occurred_at: "2026-07-29T10:00:00Z", source_id: "telegram-one", authority: "reference", reliability: .8 },
    { event_id: "b", run_id: "r", train_number: "91", station: "Kyiv", occurred_at: "2026-07-29T10:03:00Z", source_id: "telegram-two", authority: "reference", reliability: .8 },
  ];
  const [group] = fuseObservationRowsV4(events);
  assert.equal(group.explanation.independentSources, 2);
  assert.equal(group.explanation.independentDomains, 1);
  assert.equal(group.evidenceGrade, "single-source");
  assert.match(group.fusionId, /^fusion-v5:/);
});

test("fusion v5 reports excessive temporal spread instead of hiding it", () => {
  const [group] = fuseObservationRowsV4([
    { event_id: "a", run_id: "r", train_number: "91", station: "Kyiv", occurred_at: "2026-07-29T10:00:00Z", source_id: "uz-public-board", authority: "official", reliability: .9 },
    { event_id: "b", run_id: "r", train_number: "91", station: "Kyiv", occurred_at: "2026-07-29T10:18:00Z", source_id: "operations-hub", authority: "operator", reliability: .9 },
  ]);
  assert.equal(group.ambiguous, true);
  assert.ok(group.explanation.conflicts.includes("temporal-spread"));
});

test("entity resolution can rank a numberless station fact and respects negative evidence", () => {
  const event = { station: "Fastiv", occurred_at: "2026-07-29T10:00:00Z", service_date: "2026-07-29" };
  const candidate = { run_id: "run-91", train_number: "91", service_date: "2026-07-29", origin: "Kyiv", destination: "Odesa", metadata_json: JSON.stringify({ stationCalls: [{ station: "Fastiv", scheduledAt: "2026-07-29T10:10:00Z" }] }) };
  const normal = scoreRunCandidateDetails(event, candidate);
  const excluded = scoreRunCandidateDetails({ ...event, negative_evidence: ["run-91"] }, candidate);
  assert.ok(normal.score > .3);
  assert.ok(excluded.score < normal.score);
});

test("calibration v4 prefers prospective multidimensional profiles", () => {
  const edge = { from_station_id: "kyiv", to_station_id: "fastiv", train_family: "91", p10_minutes: 40, p50_minutes: 50, p90_minutes: 70 };
  const context = { sourceId: "uz-board", trainFamily: "91", predictedAt: "2026-07-29T10:00:00Z" };
  const dimension = calibrationDimensionsV4({ source_id: context.sourceId, train_number: "91", from_station_id: "kyiv", to_station_id: "fastiv", evaluated_at: context.predictedAt, horizon_minutes: 50 })[0];
  const profiles = new Map([[dimension.profileId, { ...dimension, prospectiveCount: 12, evaluationCount: 12, residualP10: 2, residualP50: 5, residualP90: 8, uncertaintyMultiplier: 1.1, readiness: "operational", maeMinutes: 4, p80Coverage: 82, biasMinutes: 5 }]]);
  const result = applyCalibrationV4(edge, profiles, context);
  assert.equal(result.p50_minutes, 55);
  assert.equal(result.calibration_profile.version, "v4");
  assert.equal(result.calibration_profile.dimension, "source-train-segment-time-horizon");
});


test("fusion v5 exposes run identity conflicts and consensus confidence", () => {
  const [group] = fuseObservationRowsV4([
    { event_id: "id-a", run_id: "run-a", train_number: "91", station: "Kyiv", occurred_at: "2026-07-29T10:00:00Z", source_id: "uz-official-board", authority: "official", reliability: .95 },
    { event_id: "id-b", run_id: "run-b", train_number: "91", station: "Kyiv", occurred_at: "2026-07-29T10:01:00Z", source_id: "operations-hub", authority: "operator", reliability: .9 },
  ]);
  assert.equal(group.ambiguous, true);
  assert.ok(group.explanation.conflicts.includes("run-identity-conflict"));
  assert.ok(group.explanation.consensusScore > 0 && group.explanation.consensusScore < 1);
});

test("calibration v5 blends hierarchical prospective profiles and expands weak coverage", () => {
  const context = { sourceId: "uz-live", trainFamily: "91", predictedAt: "2026-07-29T10:00:00Z" };
  const edge = { train_family: "91", from_station_id: "kyiv", to_station_id: "fastiv", p10_minutes: 50, p50_minutes: 60, p90_minutes: 70 };
  const dimensions = calibrationDimensionsV4({ source_id: context.sourceId, train_number: "91", from_station_id: "kyiv", to_station_id: "fastiv", evaluated_at: context.predictedAt, horizon_minutes: 60 });
  const profiles = new Map(dimensions.slice(0,2).map((dimension,index) => [dimension.profileId, { ...dimension, prospectiveCount: 12-index*3, evaluationCount: 14, residualP10: 1, residualP50: 5, residualP90: 10, uncertaintyMultiplier: 1.1, readiness: "operational", maeMinutes: 7, p80Coverage: 55 }]));
  const result = applyCalibrationV5(edge, profiles, context);
  assert.equal(result.calibration_profile.version, "v5");
  assert.equal(result.calibration_profile.blendedProfiles, 2);
  assert.ok(result.p50_minutes > edge.p50_minutes);
  assert.ok(result.p90_minutes-result.p10_minutes > edge.p90_minutes-edge.p10_minutes);
});
