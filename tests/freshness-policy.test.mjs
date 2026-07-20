import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFreshness,
  freshnessConfidenceFactor,
  sourceAgeMinutes,
} from "../js/freshness-policy.js";

test("freshness policy separates current, warning, frozen and expired data", () => {
  assert.equal(evaluateFreshness(10).key, "fresh");
  assert.equal(evaluateFreshness(45).key, "watch");
  assert.equal(evaluateFreshness(75).key, "degraded");
  assert.deepEqual(
    { key: evaluateFreshness(120).key, frozen: evaluateFreshness(120).frozen, modelAgeMinutes: evaluateFreshness(120).modelAgeMinutes },
    { key: "stale", frozen: true, modelAgeMinutes: 90 },
  );
  assert.equal(evaluateFreshness(181).canPosition, false);
});

test("confidence decay is monotonic and reaches zero after expiry", () => {
  const samples = [0, 30, 60, 90, 120, 180, 181].map(freshnessConfidenceFactor);
  assert.ok(samples.every((value, index) => index === 0 || value <= samples[index - 1]));
  assert.equal(samples.at(-1), 0);
});

test("source age is calculated independently from model calculation time", () => {
  assert.equal(sourceAgeMinutes("2026-07-20T10:00:00Z", new Date("2026-07-20T11:14:00Z")), 74);
});
