import test from "node:test";
import assert from "node:assert/strict";
import { assessUpdate, screenUpdates } from "../backend/src/domain/quality.js";
import { parseEdgeDelayDashboard, parseRelayDelayMarkdown } from "../backend/src/adapters/delay-dashboard.js";

test("quality gate quarantines impossible updates but keeps incomplete public evidence", () => {
  const now = Date.parse("2026-07-21T06:00:00Z");
  const valid = { trainNumber: "91", updatedAt: "2026-07-21T05:55:00Z", delayMinutes: 12 };
  assert.equal(assessUpdate(valid, now).accepted, true);
  const result = screenUpdates([valid, { ...valid, trainNumber: "bad", delayMinutes: 9000 }], now);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.quarantined.length, 1);
  assert.deepEqual(result.quarantined[0].errors, ["invalid_train_number", "impossible_delay"]);
});

test("edge parser extracts an official dashboard update without a browser", () => {
  const html = `<table><tr><td>№ 159/160</td><td>Київ → Трускавець</td><td>+1:05</td><td>В дорозі</td><td>—</td><td>19:42</td></tr></table>`;
  const updates = parseEdgeDelayDashboard(html, "2026-07-21T06:00:00Z");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].trainNumber, "159/160");
  assert.equal(updates[0].delayMinutes, 65);
  assert.equal(updates[0].sourceEvidence, "official-public-dashboard-edge");
});

test("posterior v3 exposes historical calibration metadata", async () => {
  const { estimatePosterior } = await import("../shared/rail-posterior.js");
  const result = estimatePosterior({
    now: "2026-07-21T06:30:00Z", routeLengthKm: 300,
    anchors: [{ routeDistanceKm: 80, occurredAt: "2026-07-21T06:00:00Z", reliability: 0.9 }],
    schedule: [{ routeDistanceKm: 180, expectedAt: "2026-07-21T07:00:00Z" }],
    historicalSamples: 12, historicalSpreadMinutes: 18,
  });
  assert.equal(result.method, "rail-posterior-v3");
  assert.deepEqual(result.calibration, { historicalSamples: 12, historicalSpreadMinutes: 18 });
});

test("relay markdown preserves official dashboard provenance",()=>{
  const markdown="| №15/16 | Харків-Пас.→ Івано-Франківськ | +3:24 | В дорозі | — | 10:21 | Середня | технічна причина |";
  const updates=parseRelayDelayMarkdown(markdown,"2026-07-21T07:00:00Z");assert.equal(updates.length,1);assert.equal(updates[0].delayMinutes,204);assert.equal(updates[0].sourceEvidence,"official-public-dashboard-relay");
});