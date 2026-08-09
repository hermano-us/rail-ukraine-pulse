import test from "node:test";
import assert from "node:assert/strict";
import { calibrationDimensionsV5 } from "../backend/src/intelligence/calibration-v4.js";
import {
  buildStationCollectionPlan,
  detectRailGraphGaps,
  evaluateReleaseDecision,
  probabilityHistorySample,
} from "../backend/src/intelligence/rail-intelligence-v6.js";

test("adaptive station plan increases coverage without treating every station equally",()=>{
  const plan=buildStationCollectionPlan([
    {stationId:"kyiv",stationName:"Kyiv",priorityTier:"critical",priorityScore:90,silentRuns:2,overdueTwins:1},
    {stationId:"zhmerynka",stationName:"Zhmerynka",priorityTier:"corridor",priorityScore:48},
    {stationId:"small",stationName:"Small",priorityTier:"background",priorityScore:4},
  ],"2026-08-09T10:00:00Z");
  assert.equal(plan[0].stationId,"kyiv");
  assert.equal(plan[0].targetIntervalMinutes,2);
  assert.equal(plan[1].targetIntervalMinutes,5);
  assert.equal(plan[2].targetIntervalMinutes,20);
  assert.ok(plan[0].requestWeight>plan[2].requestWeight);
});

test("rail graph gap detector reports nearby disconnected physical components",()=>{
  const nodes=[
    {id:"a",latitude:50,longitude:30},
    {id:"b",latitude:50.05,longitude:30.05},
    {id:"c",latitude:50.08,longitude:30.08},
    {id:"d",latitude:50.13,longitude:30.13},
  ];
  const result=detectRailGraphGaps(nodes,[{from:"a",to:"b"},{from:"c",to:"d"}],{maximumGapKm:20});
  assert.equal(result.components,2);
  assert.equal(result.candidates.length,1);
  assert.ok(result.candidates[0].distanceKm<10);
  assert.equal(result.candidates[0].reason,"disconnected-components-nearby");
});

test("v6 calibration distinguishes source, category, segment and time",()=>{
  const dimensions=calibrationDimensionsV5({model_version:"rail-intelligence-v5",source_id:"uz-board",train_number:"freight",from_station_id:"kyiv",to_station_id:"fastiv",evaluated_at:"2026-08-09T09:00:00Z",horizon_minutes:60});
  assert.ok(dimensions.some((item)=>item.type==="source-category-segment-time"&&item.key.includes("uz-board:freight:kyiv>fastiv:morning")));
  assert.ok(dimensions.some((item)=>item.type==="category-segment-time"));
});

test("model release gate rolls back only on measured regression",()=>{
  const baseline=Array.from({length:40},()=>({absolute_error_minutes:10,within_p80:1}));
  const degraded=Array.from({length:40},()=>({absolute_error_minutes:18,within_p80:0}));
  const result=evaluateReleaseDecision(degraded,baseline,40);
  assert.equal(result.decision,"rollback");
  assert.equal(result.reason,"measured-regression");
  assert.equal(evaluateReleaseDecision(degraded.slice(0,10),baseline,40).decision,"hold");
});

test("probability history preserves the P10-P90 evolution of a twin",()=>{
  const sample=probabilityHistorySample({runId:"run-1",modelVersion:"rail-intelligence-v5",sampledAt:"2026-08-09T10:00:00Z",hypothesis:{hypothesisId:"h1",fromNodeId:"kyiv",toNodeId:"fastiv",probability:.72,progress:.5,latitude:50.2,longitude:30.2,confidence:.64,uncertaintyKm:18,reasons:{progressInterval:{p10:.35,p50:.5,p90:.68}}}});
  assert.equal(sample.progressP10,.35);
  assert.equal(sample.progressP50,.5);
  assert.equal(sample.progressP90,.68);
  assert.equal(sample.modelVersion,"rail-intelligence-v5");
});
