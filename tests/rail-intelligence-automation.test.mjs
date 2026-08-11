import test from "node:test";
import assert from "node:assert/strict";
import { applyCalibration, applyCalibrationV3, calculateCalibrationProfile, calculateCalibrationProfileV3, calibrationDimensions } from "../backend/src/intelligence/calibration.js";
import { deriveTwinOperationalState, stateTransition, summarizeStationEvidence } from "../backend/src/intelligence/twin-state-machine.js";
import { chooseCanonicalRun, scoreRunCandidate, scoreRunCandidateDetails } from "../backend/src/intelligence/observation-linker.js";
import { analyzeRailTopology, graphImportTelemetry } from "../backend/src/intelligence/rail-graph-sync.js";
import { buildTopology, composeRouteGeometry, routeAwareCandidates, shortestPhysicalPath } from "../backend/src/intelligence/rail-route-cache.js";

test("physical routing composes multiple track segments instead of a straight chord",()=>{
  const topology=buildTopology([["kyiv","fastiv",65],["fastiv","koziatyn",90],["kyiv","poltava",340]]),path=shortestPhysicalPath(topology,"kyiv","koziatyn");
  assert.deepEqual(path.nodes,["kyiv","fastiv","koziatyn"]);assert.equal(path.distanceKm,155);assert.equal(path.hopCount,2);
  const edges=new Map([
    ["kyiv>fastiv",{geometry_json:JSON.stringify({type:"LineString",coordinates:[[30.4,50.4],[29.9,50.1]]}),geometry_quality:.98}],
    ["fastiv>koziatyn",{geometry_json:JSON.stringify({type:"LineString",coordinates:[[29.9,50.1],[28.8,49.7]]}),geometry_quality:.94}],
  ]),composed=composeRouteGeometry(path,edges);assert.deepEqual(composed.geometry.coordinates,[[30.4,50.4],[29.9,50.1],[28.8,49.7]]);assert.equal(composed.geometryQuality,.94);
});

test("route-aware routing rejects a short yard shortcut in favour of the main OSM relation",()=>{
  const topology=buildTopology([
    {from:"a",to:"yard",distanceKm:4,services:["yard"]},
    {from:"yard",to:"d",distanceKm:4,services:["yard"]},
    {from:"a",to:"main",distanceKm:7,usage:"main",routeRelationIds:["r-91"]},
    {from:"main",to:"d",distanceKm:7,usage:"main",routeRelationIds:["r-91"]},
  ]);
  const candidates=routeAwareCandidates(topology,"a","d",{routeRelationIds:["r-91"],trainCategory:"passenger"});
  assert.deepEqual(candidates[0].nodes,["a","main","d"]);
  assert.equal(candidates[0].explanation.method,"itinerary-constrained-v1");
  assert.equal(candidates[0].explanation.matchedRouteRelationEdges,2);
  assert.ok(candidates[0].confidence>.7);
});

test("a short station throat does not penalize the entire mainline segment",()=>{
  const topology=buildTopology([
    {from:"a",to:"platform",distanceKm:5,services:["siding"],serviceShare:.05},
    {from:"platform",to:"d",distanceKm:5,services:["siding"],serviceShare:.05},
    {from:"a",to:"detour",distanceKm:7},
    {from:"detour",to:"d",distanceKm:7},
  ]);
  const candidates=routeAwareCandidates(topology,"a","d",{trainCategory:"passenger"});
  assert.deepEqual(candidates[0].nodes,["a","platform","d"]);
});

test("route-aware routing obeys scheduled intermediate stations and keeps alternatives explicit",()=>{
  const topology=buildTopology([
    {from:"a",to:"direct",distanceKm:5},{from:"direct",to:"d",distanceKm:5},
    {from:"a",to:"b",distanceKm:6},{from:"b",to:"c",distanceKm:6},{from:"c",to:"d",distanceKm:6},
    {from:"b",to:"x",distanceKm:7},{from:"x",to:"c",distanceKm:7},
  ]);
  const candidates=routeAwareCandidates(topology,"a","d",{waypoints:["b","c"]},{maximumCandidates:3});
  assert.deepEqual(candidates[0].nodes,["a","b","c","d"]);
  assert.deepEqual(candidates[0].explanation.requiredWaypoints,["b","c"]);
  assert.ok(candidates.some((candidate)=>candidate.nodes.includes("x")));
});

test("route compiler prefers one continuous rail relation across itinerary legs",()=>{
  const topology=buildTopology([
    {from:"a",to:"short-one",distanceKm:4.5,routeRelationIds:["r-short-a"]},{from:"short-one",to:"b",distanceKm:4.5,routeRelationIds:["r-short-a"]},
    {from:"a",to:"main-one",distanceKm:5,routeRelationIds:["r-main"]},{from:"main-one",to:"b",distanceKm:5,routeRelationIds:["r-main"]},
    {from:"b",to:"short-two",distanceKm:4.5,routeRelationIds:["r-short-c"]},{from:"short-two",to:"c",distanceKm:4.5,routeRelationIds:["r-short-c"]},
    {from:"b",to:"main-two",distanceKm:5,routeRelationIds:["r-main"]},{from:"main-two",to:"c",distanceKm:5,routeRelationIds:["r-main"]},
  ]),candidates=routeAwareCandidates(topology,"a","c",{waypoints:["b"],trainCategory:"passenger"},{maximumCandidates:3});
  assert.deepEqual(candidates[0].nodes,["a","main-one","b","main-two","c"]);
  assert.equal(candidates[0].explanation.validation.reason,"mandatory_stations_in_order");
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

test("entity resolution auto-links a station fact using registry calls and schedule proximity",()=>{
  const event={train_number:"091",service_date:"2026-07-28",station:"Коростень",occurred_at:"2026-07-28T08:05:00Z"};
  const matching={run_id:"matching",train_number:"091",service_date:"2026-07-28",origin:"Київ",destination:"Львів",route:"Київ — Львів",metadata_json:JSON.stringify({stations:["Коростень"],stationCalls:[{station:"Коростень",scheduledAt:"2026-07-28T08:00:00Z"}]})};
  const other={...matching,run_id:"other",origin:"Львів",destination:"Київ",route:"Львів — Київ",metadata_json:JSON.stringify({stations:["Фастів"],stationCalls:[{station:"Фастів",scheduledAt:"2026-07-28T08:00:00Z"}]})};
  const decision=chooseCanonicalRun(event,[other,matching]);
  assert.equal(decision.status,"linked");
  assert.equal(decision.canonicalRunId,"matching");
  assert.ok(decision.candidates[0].features.some((item)=>item.id==="station_schedule"&&item.matched));
});
test("Rail Intelligence v3 separates operational phase from position status",()=>{
  const fresh=deriveTwinOperationalState({now:"2026-07-28T10:04:00Z",anchorAt:"2026-07-28T10:00:00Z",positionStatus:"estimated",progress:.04,etaP80End:"2026-07-28T11:00:00Z",confidence:.8});
  assert.equal(fresh.state,"at_station");assert.ok(fresh.stateConfidence>.7);
  const dwelling=deriveTwinOperationalState({now:"2026-07-28T10:10:00Z",anchorAt:"2026-07-28T10:00:00Z",positionStatus:"estimated",progress:.1,etaP80End:"2026-07-28T11:00:00Z",confidence:.8,repeatCount:2,dwellMinutes:6});
  assert.equal(dwelling.state,"dwelling");
  const approaching=deriveTwinOperationalState({now:"2026-07-28T10:45:00Z",anchorAt:"2026-07-28T10:00:00Z",positionStatus:"estimated",progress:.84,etaP80End:"2026-07-28T11:00:00Z",confidence:.7});
  assert.equal(approaching.state,"approaching");
  const overdue=deriveTwinOperationalState({now:"2026-07-28T11:20:00Z",anchorAt:"2026-07-28T10:00:00Z",positionStatus:"estimated",progress:1,etaP80End:"2026-07-28T11:00:00Z",confidence:.6});
  assert.equal(overdue.state,"overdue");assert.equal(overdue.overdueMinutes,20);
  const transition=stateTransition({operational_state:"in_transit",anchor_node_id:"kyiv",next_node_id:"fastiv"},{...approaching,now:"2026-07-28T10:45:00Z",anchorNodeId:"kyiv",nextNodeId:"fastiv",positionStatus:"estimated"});
  assert.equal(transition.fromState,"in_transit");assert.equal(transition.toState,"approaching");
});

test("Rail Intelligence v3 detects dwell evidence without inventing movement",()=>{
  const evidence=summarizeStationEvidence([
    {station:"Kyiv",occurred_at:"2026-07-28T09:00:00Z"},
    {station:"Fastiv",occurred_at:"2026-07-28T10:00:00Z"},
    {station:"Fastiv",occurred_at:"2026-07-28T10:06:00Z"},
  ],(value)=>value.toLowerCase());
  assert.equal(evidence.repeatCount,2);assert.equal(evidence.dwellMinutes,6);assert.equal(evidence.previousNodeId,"kyiv");
});

test("calibration v3 prefers live segment evidence and expands weak P80",()=>{
  const evaluations=Array.from({length:12},(_,index)=>({evaluation_id:`v3:${index}`,evaluation_kind:index<8?"prospective":"replay",predicted_minutes:60,actual_minutes:70+(index%4),within_p80:index<6?1:0,evaluated_at:`2026-07-${String(10+index).padStart(2,"0")}T10:00:00Z`})),profile=calculateCalibrationProfileV3(evaluations);
  assert.equal(profile.readiness,"operational");assert.equal(profile.prospectiveCount,8);assert.ok(profile.uncertaintyMultiplier>1);
  const dimension=calibrationDimensions({train_number:"091",source_id:"uz",from_station_id:"kyiv",to_station_id:"fastiv"}).find(item=>item.type==="train-segment"),profiles=new Map([[dimension.profileId,{...profile,...dimension}]]),edge=applyCalibrationV3({train_family:"091",from_station_id:"kyiv",to_station_id:"fastiv",p10_minutes:52,p50_minutes:60,p90_minutes:68},profiles,{trainFamily:"091",sourceId:"other"});
  assert.equal(edge.calibration_profile.version,"v3");assert.equal(edge.calibration_profile.dimension,"train-segment");assert.ok(edge.p90_minutes-edge.p10_minutes>16);
});
test("a scheduled platform throat may return to the main line without authorizing arbitrary reversals",()=>{
  const topology=buildTopology([
    {from:"a",to:"junction",distanceKm:10},
    {from:"junction",to:"platform",distanceKm:3,services:["crossover","siding"],serviceShare:.25},
    {from:"junction",to:"d",distanceKm:10},
  ]),candidates=routeAwareCandidates(topology,"a","d",{waypoints:["platform"],trainCategory:"passenger"});
  assert.deepEqual(candidates[0].nodes,["a","junction","platform","junction","d"]);
  assert.equal(candidates[0].validation.stationThroatReversals,1);
  const longSpur=buildTopology([
    {from:"a",to:"junction",distanceKm:10},
    {from:"junction",to:"platform",distanceKm:8,services:["crossover","siding"],serviceShare:.25},
    {from:"junction",to:"d",distanceKm:10},
  ]);
  assert.equal(routeAwareCandidates(longSpur,"a","d",{waypoints:["platform"],trainCategory:"passenger"}).length,0);
});