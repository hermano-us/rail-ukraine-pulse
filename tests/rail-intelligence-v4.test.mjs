import test from "node:test";
import assert from "node:assert/strict";
import { fuseObservationRowsV3 } from "../backend/src/intelligence/observation-fusion-v3.js";
import { calculateStationPriority } from "../backend/src/intelligence/station-coverage.js";
import { buildTwinHypotheses } from "../backend/src/intelligence/service.js";
import { chooseCanonicalRun } from "../backend/src/intelligence/observation-linker.js";

test("fusion v3 canonicalizes aliases and corroborates independent sources", () => {
  const events=[
    {event_id:"a",run_id:"run-1",train_number:"091",station:"Kyiv Passenger",occurred_at:"2026-07-29T10:00:00Z",source_id:"official",authority:"official",reliability:.95,raw_update_json:"{}"},
    {event_id:"b",run_id:"run-1",train_number:"091",station:"Kyiv-Pas",occurred_at:"2026-07-29T10:04:00Z",source_id:"witness",authority:"public",reliability:.8,raw_update_json:"{}"},
  ];
  const aliases=new Map([["kyiv-passenger","kyiv"],["kyiv-pas","kyiv"]]);
  const groups=fuseObservationRowsV3(events,{canonicalStation:(value)=>aliases.get(String(value).toLowerCase().replace(/[^a-z]+/g,"-").replace(/^-|-$/g,""))});
  assert.equal(groups.length,1);
  assert.equal(groups[0].stationId,"kyiv");
  assert.equal(groups[0].evidenceGrade,"corroborated");
  assert.equal(groups[0].sourceIds.length,2);
  assert.ok(groups[0].effectiveReliability>.9);
  assert.ok(Date.parse(groups[0].canonicalOccurredAt)>=Date.parse(events[0].occurred_at));
});

test("fusion v3 exposes source conflicts instead of manufacturing certainty", () => {
  const groups=fuseObservationRowsV3([
    {event_id:"a",run_id:"run-1",train_number:"091",station:"Kyiv",occurred_at:"2026-07-29T10:00:00Z",source_id:"a",authority:"public",reliability:.8,raw_update_json:JSON.stringify({origin:"Kyiv",destination:"Lviv"})},
    {event_id:"b",run_id:"run-1",train_number:"091",station:"Kyiv",occurred_at:"2026-07-29T10:03:00Z",source_id:"b",authority:"public",reliability:.8,raw_update_json:JSON.stringify({origin:"Lviv",destination:"Kyiv"})},
  ]);
  assert.equal(groups[0].evidenceGrade,"conflict");
  assert.equal(groups[0].ambiguous,true);
  assert.ok(groups[0].effectiveReliability<.8);
});

test("adaptive coverage prioritizes silent and overdue station demand", () => {
  const routine=calculateStationPriority({expectedRuns:2,minutesSinceFact:30});
  const urgent=calculateStationPriority({expectedRuns:2,silentRuns:2,ambiguousTwins:1,overdueTwins:1,minutesSinceFact:360});
  assert.ok(urgent.score>routine.score+50);
  assert.ok(urgent.reasons.length>=4);
});

test("digital twin v4 tightens a corroborated corridor and records evidence", () => {
  const candidate={to_station_id:"fastiv",p10_minutes:45,p50_minutes:60,p90_minutes:75,sample_count:30,reliability:.9,distance_km:65,train_family:"091",geometry_json:JSON.stringify({type:"LineString",coordinates:[[30.5,50.4],[29.9,50.1]]})};
  const base={run_id:"run-1",event_id:"event-1",train_number:"091",station_id:"kyiv",occurred_at:"2026-07-29T10:00:00Z",reliability:.9};
  const single=buildTwinHypotheses({event:{...base,evidence_grade:"single-source",independent_sources:1},candidates:[candidate],now:"2026-07-29T10:20:00Z"});
  const fused=buildTwinHypotheses({event:{...base,evidence_grade:"corroborated",independent_sources:2,fusion_reliability:.97,fusion_id:"fusion-1"},candidates:[candidate],now:"2026-07-29T10:20:00Z"});
  assert.equal(fused.state.method,"station-graph-probabilistic-twin-v4");
  assert.ok(fused.state.confidence>single.state.confidence);
  assert.ok(fused.state.uncertaintyKm<single.state.uncertaintyKm);
  assert.equal(fused.hypotheses[0].reasons.fusionId,"fusion-1");
});

test("entity resolution v3 lowers thresholds only for corroborated evidence", () => {
  const candidate={run_id:"r1",train_number:"091",service_date:"2026-07-29",origin:"Kyiv",destination:"Lviv",route:"Kyiv Lviv",last_observed_at:"2026-07-29T10:00:00Z",metadata_json:JSON.stringify({stations:["Kyiv"]})};
  const decision=chooseCanonicalRun({train_number:"091",service_date:"2026-07-29",station:"Kyiv",occurred_at:"2026-07-29T10:05:00Z",evidence_grade:"corroborated",independent_sources:2,fusion_reliability:.92},[candidate]);
  assert.equal(decision.status,"linked");
  assert.equal(decision.canonicalRunId,"r1");
  assert.ok(decision.reasons.some((item)=>item.id==="source_corroboration"));
});
