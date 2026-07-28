import test from "node:test";
import assert from "node:assert/strict";
import { applyCalibration, calculateCalibrationProfile } from "../backend/src/intelligence/calibration.js";
import { chooseCanonicalRun, scoreRunCandidate, scoreRunCandidateDetails } from "../backend/src/intelligence/observation-linker.js";
import { analyzeRailTopology, graphImportTelemetry } from "../backend/src/intelligence/rail-graph-sync.js";
import { buildTopology, composeRouteGeometry, shortestPhysicalPath } from "../backend/src/intelligence/rail-route-cache.js";

test("physical routing composes multiple track segments instead of a straight chord",()=>{
  const topology=buildTopology([["kyiv","fastiv",65],["fastiv","koziatyn",90],["kyiv","poltava",340]]),path=shortestPhysicalPath(topology,"kyiv","koziatyn");
  assert.deepEqual(path.nodes,["kyiv","fastiv","koziatyn"]);assert.equal(path.distanceKm,155);assert.equal(path.hopCount,2);
  const edges=new Map([
    ["kyiv>fastiv",{geometry_json:JSON.stringify({type:"LineString",coordinates:[[30.4,50.4],[29.9,50.1]]}),geometry_quality:.98}],
    ["fastiv>koziatyn",{geometry_json:JSON.stringify({type:"LineString",coordinates:[[29.9,50.1],[28.8,49.7]]}),geometry_quality:.94}],
  ]),composed=composeRouteGeometry(path,edges);assert.deepEqual(composed.geometry.coordinates,[[30.4,50.4],[29.9,50.1],[28.8,49.7]]);assert.equal(composed.geometryQuality,.94);
});

test("observation linker selects the matching date and direction but keeps conflicts pending",()=>{
  const event={train_number:"091",service_date:"2026-07-28",origin:"Kyiv",destination:"Lviv",route:"Kyiv - Lviv",station:"Fastiv",occurred_at:"2026-07-28T08:00:00Z"};
  const forward={run_id:"forward",train_number:"091",service_date:"2026-07-28",origin:"Kyiv",destination:"Lviv",route:"Kyiv - Fastiv - Lviv",first_observed_at:"2026-07-28T05:00:00Z"},reverse={...forward,run_id:"reverse",origin:"Lviv",destination:"Kyiv",route:"Lviv - Kyiv"};
  assert.ok(scoreRunCandidate(event,forward)>.8);assert.ok(scoreRunCandidate(event,reverse)<.6);const decision=chooseCanonicalRun(event,[reverse,forward]);assert.equal(decision.status,"linked");assert.equal(decision.canonicalRunId,"forward");
  const vague={...event,origin:null,destination:null,route:null,station:"Unknown"},ambiguous=chooseCanonicalRun(vague,[forward,reverse]);assert.equal(ambiguous.status,"pending");assert.equal(ambiguous.canonicalRunId,null);
});

test("calibration learns residual correction and adjusts ETA interval",()=>{
  const evaluations=Array.from({length:12},(_,index)=>({evaluation_id:index<4?`live:${index}`:`replay:${index}`,predicted_minutes:60,actual_minutes:68+(index%3),within_p80:index<10?1:0,evaluated_at:`2026-07-${String(10+index).padStart(2,"0")}T10:00:00Z`})),profile=calculateCalibrationProfile(evaluations);
  assert.equal(profile.readiness,"operational");assert.equal(profile.prospectiveCount,4);assert.ok(profile.maeMinutes>=8);
  const profiles=new Map([["091:kyiv>fastiv",{...profile}]]),edge=applyCalibration({train_family:"091",from_station_id:"kyiv",to_station_id:"fastiv",p10_minutes:50,p50_minutes:60,p90_minutes:72},profiles);assert.ok(edge.p50_minutes>60);assert.ok(edge.p10_minutes<=edge.p50_minutes);assert.ok(edge.p90_minutes>=edge.p50_minutes);assert.equal(edge.calibration_profile.readiness,"operational");
});

test("graph control reports connectivity, progress speed and stalled recovery",()=>{
  const diagnostics=analyzeRailTopology([["a","b",10],["b","c",12],["x","y",300]],6);
  assert.equal(diagnostics.connectedComponents,2);assert.equal(diagnostics.anomalousSegments,1);assert.equal(diagnostics.isolatedStations,1);assert.equal(diagnostics.healthStatus,"degraded");
  const telemetry=graphImportTelemetry({next_station_chunk:2,next_segment_chunk:0,first_attempt_at:"2026-07-28T10:00:00Z",last_progress_at:"2026-07-28T10:05:00Z"},{stationChunks:[1,2,3,4],segmentChunks:[1,2,3,4]},"2026-07-28T11:00:00Z");
  assert.equal(telemetry.completedChunks,2);assert.equal(telemetry.totalChunks,8);assert.ok(telemetry.chunksPerHour>0);assert.ok(telemetry.estimatedCompletionAt);assert.equal(telemetry.stalled,true);
});

test("entity resolution exposes candidate probabilities and human-readable evidence",()=>{
  const event={train_number:"6366",service_date:"2026-07-28",origin:"Hrebinka",destination:"Romodan",station:"Hrebinka",occurred_at:"2026-07-28T10:00:00Z",locomotive:"VL80T-1445"};
  const candidate={run_id:"run-6366",train_number:"6366",service_date:"2026-07-28",origin:"Hrebinka",destination:"Romodan",route:"Hrebinka - Romodan",last_observed_at:"2026-07-28T09:30:00Z",locomotive:"VL80T-1445"};
  const details=scoreRunCandidateDetails(event,candidate),decision=chooseCanonicalRun(event,[candidate]);
  assert.ok(details.features.some(item=>item.id==="locomotive"&&item.matched));assert.equal(decision.status,"linked");assert.equal(decision.candidates[0].probability,1);assert.ok(decision.candidates[0].features.length>=5);
});