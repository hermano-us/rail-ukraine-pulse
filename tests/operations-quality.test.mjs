import test from "node:test";
import assert from "node:assert/strict";
import { detectMovementChanges, evaluateQualityGate } from "../backend/src/intelligence/operations-quality.js";

test("operations hub records material prediction changes only", () => {
  const previous={last_station:"Fastiv",route:"Kyiv - Odesa",eta:"2026-07-29T12:00:00Z",confidence:.8,metadata:{uncertaintyKm:20}};
  const current={movementId:"run-1",runId:"run-1",trainNumber:"105",lastStation:"Koziatyn",route:"Kyiv - Lviv",eta:"2026-07-29T12:35:00Z",confidence:.5,lastObservedAt:"2026-07-29T10:00:00Z",metadata:{uncertaintyKm:55}};
  const changes=detectMovementChanges(previous,current,"2026-07-29T10:01:00Z");
  assert.deepEqual(new Set(changes.map(item=>item.type)),new Set(["station_fact","route_changed","eta_changed","confidence_drop","uncertainty_expanded"]));
  assert.equal(new Set(changes.map(item=>item.changeId)).size,changes.length);
  assert.equal(detectMovementChanges(null,current).length,0);
});

test("quality gate stays neutral without evidence and degrades only on measured regression", () => {
  assert.equal(evaluateQualityGate([{absolute_error_minutes:4,within_p80:1}]).status,"insufficient-evidence");
  const healthy=Array.from({length:40},()=>({absolute_error_minutes:10,within_p80:1}));
  assert.equal(evaluateQualityGate(healthy).status,"healthy");
  const degraded=[...Array.from({length:20},()=>({absolute_error_minutes:30,within_p80:0})),...Array.from({length:20},()=>({absolute_error_minutes:10,within_p80:1}))];
  const gate=evaluateQualityGate(degraded);
  assert.equal(gate.status,"degraded");
  assert.equal(gate.samples,20);
});
