import { loadStationAliasMap, syncRailGraphReference } from "./rail-graph-sync.js";
import { resolveRailRouteGeometries } from "./rail-route-cache.js";
import { linkRecentObservations } from "./observation-linker.js";
import { fuseRecentObservations } from "./observation-fusion-v2.js";
import { refreshExpectedRunCoverage } from "./expected-registry.js";
import { applyCalibration, applyCalibrationV3, refreshCalibrationProfiles, refreshCalibrationProfilesV3 } from "./calibration.js";
import { deriveTwinOperationalState, stateTransition, summarizeStationEvidence } from "./twin-state-machine.js";
const rows = (result) => result?.results || [];
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value || "") ?? fallback; } catch { return fallback; } };
const stationId = (value) => String(value || "unknown").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 120) || "unknown";
const resolveStationId = (value, aliases = new Map()) => aliases.get(stationId(value)) || stationId(value);
const addMinutes = (value, minutes) => new Date(Date.parse(value) + Number(minutes) * 60_000).toISOString();
const differenceMinutes = (left, right) => (Date.parse(right) - Date.parse(left)) / 60_000;

async function batch(env, statements, size = 75) {
  for (let index = 0; index < statements.length; index += size) await env.DB.batch(statements.slice(index, index + size));
}

async function referenceEdgesForSources(env, sourceIds = []) {
  const unique=[...new Set(sourceIds)].filter(Boolean), result=[];
  for(let index=0;index<unique.length;index+=75){const ids=unique.slice(index,index+75),placeholders=ids.map((_,offset)=>`?${offset+1}`).join(",");result.push(...rows(await env.DB.prepare(`SELECT from_station_id,to_station_id,geometry_json,distance_km,geometry_quality FROM rail_segment_geometries WHERE active=1 AND from_station_id IN (${placeholders})`).bind(...ids).all()));}
  return result;
}

export function calculateNodeActivity({ observations = 0, uniqueRuns = 0, baselinePerHour = 0, freshness = 1 }) {
  const current = Math.max(0, Number(observations) || 0);
  const unique = Math.max(0, Number(uniqueRuns) || 0);
  const baseline = Math.max(0, Number(baselinePerHour) || 0);
  const ratio = baseline > 0 ? current / baseline : current > 0 ? 4 : 1;
  const volume = Math.log1p(current) * 24 + Math.log1p(unique) * 18;
  const change = Math.max(-12, Math.min(28, Math.log2(Math.max(0.25, ratio)) * 8));
  return { score: Number(clamp((volume + change) * clamp(freshness), 0, 100).toFixed(1)), changeRatio: Number(ratio.toFixed(2)) };
}

export function classifyActivityAnomaly({ observations = 0, baselinePerHour = 0, changeRatio = 1 }) {
  if (observations >= 4 && changeRatio >= 3) return { type: "activity_spike", severity: changeRatio >= 6 ? "high" : "medium", score: Math.min(1, changeRatio / 8) };
  if (observations === 0 && baselinePerHour >= 3) return { type: "activity_drop", severity: baselinePerHour >= 8 ? "high" : "medium", score: Math.min(1, baselinePerHour / 10) };
  return null;
}

export function reconstructTrajectory(observations = []) {
  return [...observations].filter((item) => item?.nodeId && Number.isFinite(Date.parse(item.observedAt))).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).map((item, sequence) => ({ ...item, sequence, reconstructionMethod: item.latitude != null && item.longitude != null ? "confirmed-coordinate" : "station-graph-anchor" }));
}

export function evaluatePrediction(prediction, actualAt) {
  const predictedAt = Date.parse(prediction?.etaP50 || prediction?.eta_p50 || "");
  const actual = Date.parse(actualAt || "");
  const low = Date.parse(prediction?.etaP80Start || prediction?.eta_p80_start || "");
  const high = Date.parse(prediction?.etaP80End || prediction?.eta_p80_end || "");
  if (![predictedAt, actual, low, high].every(Number.isFinite)) return null;
  return { absoluteErrorMinutes: Number((Math.abs(actual - predictedAt) / 60_000).toFixed(2)), withinP80: actual >= low && actual <= high };
}

const UKRAINE_BOUNDS = { minLatitude: 43.8, maxLatitude: 53.0, minLongitude: 21.0, maxLongitude: 41.5 };
const insideUkraine = (latitude, longitude) => Number.isFinite(latitude) && Number.isFinite(longitude)
  && latitude >= UKRAINE_BOUNDS.minLatitude && latitude <= UKRAINE_BOUNDS.maxLatitude
  && longitude >= UKRAINE_BOUNDS.minLongitude && longitude <= UKRAINE_BOUNDS.maxLongitude;

export function normalizeOperationalCoordinates(update = {}) {
  const position = update.position || update.estimatedPosition || update.calculatedPosition || {};
  const pair = Array.isArray(position.coordinates) ? position.coordinates : Array.isArray(update.coordinates) ? update.coordinates : null;
  let latitude = Number(update.latitude ?? update.lat ?? position.latitude ?? position.lat);
  let longitude = Number(update.longitude ?? update.lon ?? update.lng ?? position.longitude ?? position.lon ?? position.lng);
  let coordinateQuality = 'explicit-fields';
  if ((!Number.isFinite(latitude) || !Number.isFinite(longitude)) && pair?.length >= 2) {
    longitude = Number(pair[0]); latitude = Number(pair[1]); coordinateQuality = 'geojson-pair';
  }
  if (insideUkraine(latitude, longitude)) return { latitude, longitude, coordinateQuality, rejected: false };
  if (insideUkraine(longitude, latitude)) return { latitude: longitude, longitude: latitude, coordinateQuality: 'coordinate-order-repaired', rejected: false };
  return { latitude: null, longitude: null, coordinateQuality: 'outside-ukraine-rejected', rejected: Number.isFinite(latitude) || Number.isFinite(longitude) };
}

function railGeometryCoordinates(value) {
  const parsed = typeof value === "string" ? parseJson(value, null) : value;
  const coordinates = parsed?.type === "LineString" ? parsed.coordinates : Array.isArray(parsed) ? parsed : null;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const valid = coordinates.map((point) => [Number(point?.[0]), Number(point?.[1])]).filter(([longitude, latitude]) => insideUkraine(latitude, longitude));
  return valid.length === coordinates.length ? valid : null;
}

const segmentLength = ([leftLongitude, leftLatitude], [rightLongitude, rightLatitude]) => {
  const radians = (value) => value * Math.PI / 180;
  const latitudeDistance = radians(rightLatitude - leftLatitude);
  const longitudeDistance = radians(rightLongitude - leftLongitude);
  const a = Math.sin(latitudeDistance / 2) ** 2 + Math.cos(radians(leftLatitude)) * Math.cos(radians(rightLatitude)) * Math.sin(longitudeDistance / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export function interpolateRailGeometry(geometry, progress = 0) {
  const coordinates = railGeometryCoordinates(geometry);
  if (!coordinates) return null;
  const distances = coordinates.slice(1).map((point, index) => segmentLength(coordinates[index], point));
  const total = distances.reduce((sum, distance) => sum + distance, 0);
  if (!(total > 0)) return null;
  const target = total * clamp(progress); let traversed = 0;
  for (let index = 0; index < distances.length; index += 1) {
    if (traversed + distances[index] < target) { traversed += distances[index]; continue; }
    const ratio = clamp((target - traversed) / distances[index]);
    const [fromLongitude, fromLatitude] = coordinates[index], [toLongitude, toLatitude] = coordinates[index + 1];
    return { latitude: fromLatitude + (toLatitude - fromLatitude) * ratio, longitude: fromLongitude + (toLongitude - fromLongitude) * ratio, distanceKm: total };
  }
  const [longitude, latitude] = coordinates.at(-1);
  return { latitude, longitude, distanceKm: total };
}

export function buildTwinHypotheses({ event, candidates = [], now = new Date().toISOString(), routeHint = "", maximum = 3 }) {
  const anchorTime = Date.parse(event?.occurred_at || event?.observedAt || ""), currentTime = Date.parse(now);
  if (!Number.isFinite(anchorTime) || !Number.isFinite(currentTime)) return { hypotheses: [], state: null, ambiguous: false };
  const fromNodeId = event.station_id || stationId(event.station || event.fromNodeId), trainNumber = event.train_number || event.trainNumber || null;
  const routeTokens = stationId(routeHint).split("-").filter((token) => token.length >= 3);
  const scored = candidates.map((edge) => {
    const toNodeId = edge.to_station_id || edge.to_node_id, p50 = Number(edge.p50_minutes), samples = Math.max(0, Number(edge.sample_count) || 0);
    if (!toNodeId || toNodeId === fromNodeId || !(p50 > 0) || p50 > 1440) return null;
    const reliability = clamp(edge.reliability ?? Math.log1p(samples) / Math.log(21));
    const familyMatch = trainNumber && String(edge.train_family) === String(trainNumber) ? 1 : 0;
    const routeMatch = routeTokens.some((token) => stationId(toNodeId).includes(token)) ? 1 : 0;
    const score = .35 + familyMatch * 1.4 + routeMatch * .65 + Math.log1p(samples) * .32 + reliability * .8;
    return { edge, toNodeId, p50, samples, reliability, score };
  }).filter(Boolean).sort((left, right) => right.score - left.score).slice(0, Math.max(1, maximum));
  if (!scored.length) return { hypotheses: [], state: null, ambiguous: false };
  const maxScore = scored[0].score, weights = scored.map((item) => Math.exp(item.score - maxScore)), weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const ageMinutes = Math.max(0, (currentTime - anchorTime) / 60_000), freshness = Math.exp(-ageMinutes / 180);
  const positionStatus = ageMinutes > 240 ? "unknown" : ageMinutes > 90 ? "stale" : "estimated";
  const hypotheses = scored.map((item, index) => {
    const probability = weights[index] / weightTotal, p10 = Math.max(0, Number(item.edge.p10_minutes ?? item.p50)), p90 = Math.max(p10, Number(item.edge.p90_minutes ?? item.p50));
    const progress = clamp(ageMinutes / item.p50), geometry = railGeometryCoordinates(item.edge.geometry_json), point = positionStatus === "unknown" ? null : interpolateRailGeometry(geometry, progress);
    const spreadRatio = Math.max(.05, (p90 - p10) / Math.max(item.p50, 1)), distanceKm = Number(item.edge.distance_km) || point?.distanceKm || 0;
    const uncertaintyKm = clamp(Math.max(3, distanceKm ? distanceKm * spreadRatio * .5 : 8) + ageMinutes * .35 + (1 - probability) * 35, 3, 300);
    const confidence = clamp((event.reliability ?? .6) * item.reliability * probability * freshness);
    return { hypothesisId:`${event.run_id}:${event.event_id}:${fromNodeId}>${item.toNodeId}`,runId:event.run_id,trainNumber,basedOnObservationId:event.event_id,fromNodeId,toNodeId:item.toNodeId,probability:Number(probability.toFixed(4)),progress:Number(progress.toFixed(4)),etaP50:addMinutes(event.occurred_at,item.p50),etaP80Start:addMinutes(event.occurred_at,p10),etaP80End:addMinutes(event.occurred_at,p90),confidence:Number(confidence.toFixed(4)),uncertaintyKm:Number(uncertaintyKm.toFixed(1)),geometry,latitude:point?.latitude??null,longitude:point?.longitude??null,expiresAt:addMinutes(event.occurred_at,Math.max(p90+360,item.p50*2)),samples:item.samples,reasons:{familyMatch:String(item.edge.train_family)===String(trainNumber),routeMatch:routeTokens.some((token)=>stationId(item.toNodeId).includes(token)),edgeReliability:item.reliability,freshness:Number(freshness.toFixed(4)),geometryAvailable:Boolean(geometry),geometryMethod:item.edge.geometry_method||null,calibration:item.edge.calibration_profile||null}};
  });
  const primary=hypotheses[0],probabilityGap=primary.probability-(hypotheses[1]?.probability||0),ambiguous=primary.probability<.58||(hypotheses.length>1&&probabilityGap<.18);
  return {hypotheses,ambiguous,state:{runId:event.run_id,trainNumber,anchorObservationId:event.event_id,anchorNodeId:fromNodeId,nextNodeId:primary.toNodeId,positionStatus,calculatedAt:now,anchorObservedAt:event.occurred_at,etaP50:primary.etaP50,etaP80Start:primary.etaP80Start,etaP80End:primary.etaP80End,confidence:primary.confidence,uncertaintyKm:primary.uncertaintyKm,method:"station-graph-probabilistic-twin-v2",primaryHypothesisId:primary.hypothesisId,alternativesCount:Math.max(0,hypotheses.length-1),latitude:primary.latitude,longitude:primary.longitude,ambiguous,ageMinutes:Number(ageMinutes.toFixed(1)),geometryAvailable:Boolean(primary.geometry)}};
}

export async function runIntelligenceCycle(env, now = new Date().toISOString()) {
  const cycleId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO intelligence_cycles(cycle_id,started_at,status) VALUES(?1,?2,'running')").bind(cycleId, now).run();
  const counters = { nodes: 0, edges: 0, observations: 0, predictions: 0, resolved: 0, replayed: 0, anomalies: 0, routesCalculated: 0, linksCreated: 0, calibrationProfiles: 0, stateTransitions: 0, prospectiveEvaluations: 0, expectedRuns: 0, silentRuns: 0, fusedObservations: 0 };
  let graphSync = { status:'not-run' };
  try {
    try { graphSync = await syncRailGraphReference(env, now); } catch (error) { graphSync = { status:'degraded', error:String(error?.message||error).slice(0,300) }; }
    const stationAliases = await loadStationAliasMap(env);
    const fusionResult=await fuseRecentObservations(env,now); counters.fusedObservations=fusionResult.groups;
    const linkResult=await linkRecentObservations(env,now,stationAliases); counters.linksCreated=linkResult.linked;
    const coverage=await refreshExpectedRunCoverage(env,now); counters.expectedRuns=coverage.total; counters.silentRuns=coverage.silent;
    const eventRows = rows(await env.DB.prepare(`SELECT e.event_id,COALESCE(CASE WHEN l.status='linked' THEN l.canonical_run_id END,e.run_id) run_id,e.station,e.occurred_at,e.observed_at,e.source_id,e.authority,e.reliability,e.raw_update_json,r.train_number,r.route,r.origin,r.destination
      FROM events e LEFT JOIN observation_run_links l ON l.event_id=e.event_id LEFT JOIN runs r ON r.run_id=COALESCE(CASE WHEN l.status='linked' THEN l.canonical_run_id END,e.run_id) LEFT JOIN observation_fusion_members fm ON fm.event_id=e.event_id
      WHERE e.event_type='station_report' AND e.station IS NOT NULL AND e.occurred_at>=datetime('now','-7 days') AND (fm.event_id IS NULL OR fm.is_primary=1)
      ORDER BY e.occurred_at DESC LIMIT 1500`).all());
    const nodeMap = new Map();
    const observationStatements = [];
    for (const event of eventRows) {
      const nodeId = resolveStationId(event.station,stationAliases); event.station_id = nodeId; const raw = parseJson(event.raw_update_json); const point = normalizeOperationalCoordinates(raw);
      const node = nodeMap.get(nodeId) || { nodeId, stationName: event.station, first: event.occurred_at, last: event.occurred_at, count: 0, ...point };
      node.first = Date.parse(event.occurred_at) < Date.parse(node.first) ? event.occurred_at : node.first;
      node.last = Date.parse(event.occurred_at) > Date.parse(node.last) ? event.occurred_at : node.last;
      node.count += 1; if (node.latitude == null && point.latitude != null) Object.assign(node, point); nodeMap.set(nodeId, node);
      observationStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO rail_observations(observation_id,run_id,train_number,node_id,station_name,observed_at,received_at,source_id,authority,reliability,evidence_type,latitude,longitude,evidence_json)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'station_report',?11,?12,?13)`).bind(event.event_id,event.run_id,event.train_number||null,nodeId,event.station,event.occurred_at,event.observed_at,event.source_id,event.authority||null,clamp(event.reliability),point.latitude,point.longitude,JSON.stringify({eventId:event.event_id})));
      observationStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO trajectory_points(trajectory_point_id,run_id,observation_id,node_id,occurred_at,latitude,longitude,confidence,reconstruction_method)
        VALUES(?1,?2,?1,?3,?4,?5,?6,?7,?8)`).bind(event.event_id,event.run_id,nodeId,event.occurred_at,point.latitude,point.longitude,clamp(event.reliability),point.latitude!=null?"confirmed-coordinate":"station-graph-anchor"));
    }
    const nodeStatements = [...nodeMap.values()].map((node) => env.DB.prepare(`INSERT INTO rail_nodes(node_id,station_name,latitude,longitude,first_seen_at,last_seen_at,observation_count)
      VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(node_id) DO UPDATE SET station_name=excluded.station_name,latitude=COALESCE(rail_nodes.latitude,excluded.latitude),longitude=COALESCE(rail_nodes.longitude,excluded.longitude),last_seen_at=MAX(rail_nodes.last_seen_at,excluded.last_seen_at),observation_count=MAX(rail_nodes.observation_count,excluded.observation_count)`).bind(node.nodeId,node.stationName,node.latitude,node.longitude,node.first,node.last,node.count));
    await batch(env, nodeStatements); await batch(env, observationStatements); counters.nodes = nodeStatements.length; counters.observations = eventRows.length;

    const segmentRows = rows(await env.DB.prepare("SELECT * FROM segment_stats ORDER BY sample_count DESC LIMIT 1500").all()).map((edge)=>({...edge,from_station_id:resolveStationId(edge.from_station_id,stationAliases),to_station_id:resolveStationId(edge.to_station_id,stationAliases)}));
    const missingNodes = new Map();
    for (const edge of segmentRows) for (const id of [edge.from_station_id, edge.to_station_id]) if (!nodeMap.has(id)) missingNodes.set(id, env.DB.prepare(`INSERT OR IGNORE INTO rail_nodes(node_id,station_name,first_seen_at,last_seen_at) VALUES(?1,?1,?2,?2)`).bind(id, now));
    await batch(env, [...missingNodes.values()]);
    const edgeStatements = segmentRows.map((edge) => { const reliability=clamp(Math.log1p(Number(edge.sample_count)||0)/Math.log(21)); return env.DB.prepare(`INSERT INTO rail_edges(edge_id,from_node_id,to_node_id,train_family,sample_count,p10_minutes,p50_minutes,p90_minutes,reliability,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(edge_id) DO UPDATE SET sample_count=excluded.sample_count,p10_minutes=excluded.p10_minutes,p50_minutes=excluded.p50_minutes,p90_minutes=excluded.p90_minutes,reliability=excluded.reliability,updated_at=excluded.updated_at`).bind(`${edge.from_station_id}>${edge.to_station_id}:${edge.train_family}`,edge.from_station_id,edge.to_station_id,edge.train_family,Number(edge.sample_count)||0,edge.p10_minutes,edge.p50_minutes,edge.p90_minutes,reliability,edge.updated_at||now); });
    await batch(env, edgeStatements); counters.edges = edgeStatements.length;
    const [persistedEdges,referenceEdges]=await Promise.all([
      env.DB.prepare("SELECT edge_id,from_node_id,to_node_id,train_family,geometry_json,distance_km,reliability FROM rail_edges WHERE geometry_json IS NOT NULL OR distance_km IS NOT NULL").all(),
      referenceEdgesForSources(env,segmentRows.map((edge)=>edge.from_station_id)),
    ]);
    const persistedEdgeById=new Map(rows(persistedEdges).map(edge=>[edge.edge_id,edge]));
    const referenceEdgeByPair=new Map(referenceEdges.map(edge=>[`${edge.from_station_id}>${edge.to_station_id}`,edge]));
    const routeResolution=await resolveRailRouteGeometries(env,segmentRows.map((edge)=>({from:edge.from_station_id,to:edge.to_station_id})),now); counters.routesCalculated=routeResolution.calculated;
    const candidateEdges=segmentRows.map(edge=>{const key=`${edge.from_station_id}>${edge.to_station_id}`,persisted=persistedEdgeById.get(`${key}:${edge.train_family}`),reference=referenceEdgeByPair.get(key),route=routeResolution.routes.get(key),geometry=reference?.geometry_json||route?.geometry_json||persisted?.geometry_json||null;return {...edge,geometry_json:geometry,distance_km:reference?.distance_km||route?.distance_km||persisted?.distance_km||null,reliability:Math.max(Number(edge.reliability)||0,Number(reference?.geometry_quality)||0,Number(route?.geometry_quality)||0,Number(persisted?.reliability)||0),geometry_method:reference?"direct-physical-segment":route?.status==="ready"?"cached-physical-route":persisted?.geometry_json?"legacy-geometry":null};});

    // Replay samples are useful for warm-up, but v3 keeps them separate from
    // prospective "prediction -> next fact" checks used for operational quality.
    const eventsByRun=new Map(),factsByRunStation=new Map();
    for(const event of eventRows){const group=eventsByRun.get(event.run_id)||[];group.push(event);eventsByRun.set(event.run_id,group);const key=`${event.run_id}:${resolveStationId(event.station,stationAliases)}`,facts=factsByRunStation.get(key)||[];facts.push(event);factsByRunStation.set(key,facts);}
    for(const facts of factsByRunStation.values())facts.sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at));
    const replayStatements=[];
    for(const [runId,events] of eventsByRun){events.sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at));for(let index=1;index<events.length;index+=1){const previous=events[index-1],actual=events[index],fromId=resolveStationId(previous.station,stationAliases),toId=resolveStationId(actual.station,stationAliases);if(fromId===toId)continue;const actualMinutes=differenceMinutes(previous.occurred_at,actual.occurred_at);if(!Number.isFinite(actualMinutes)||actualMinutes<=0||actualMinutes>1440)continue;const candidates=candidateEdges.filter(edge=>edge.from_station_id===fromId&&edge.to_station_id===toId&&(edge.train_family===actual.train_number||Number(edge.sample_count)>=10)).sort((a,b)=>Number(b.sample_count)-Number(a.sample_count)),edge=candidates[0];if(!edge||!Number.isFinite(Number(edge.p50_minutes)))continue;const predictedMinutes=Number(edge.p50_minutes),low=Number(edge.p10_minutes??predictedMinutes),high=Number(edge.p90_minutes??predictedMinutes),within=actualMinutes>=low&&actualMinutes<=high;replayStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO model_evaluations(evaluation_id,run_id,train_number,from_station_id,to_station_id,predicted_minutes,actual_minutes,absolute_error_minutes,within_p80,baseline_samples,evaluated_at,source_id,evaluation_kind,model_version,horizon_minutes,p80_width_minutes)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'replay','rail-intelligence-v3',?7,?13)`).bind(`replay:${previous.event_id}:${actual.event_id}`,runId,actual.train_number||"unknown",fromId,toId,predictedMinutes,actualMinutes,Math.abs(actualMinutes-predictedMinutes),within?1:0,Number(edge.sample_count)||0,actual.occurred_at,actual.source_id||previous.source_id||null,Math.max(0,high-low)));counters.replayed+=1;}}
    await batch(env,replayStatements);

    const pending=rows(await env.DB.prepare("SELECT * FROM twin_predictions WHERE status='pending' ORDER BY predicted_at LIMIT 1000").all()),resolutionStatements=[];
    for(const prediction of pending){const facts=factsByRunStation.get(`${prediction.run_id}:${prediction.to_node_id}`)||[],actual=facts.find((event)=>Date.parse(event.occurred_at)>Date.parse(prediction.predicted_at));if(!actual)continue;const evaluation=evaluatePrediction(prediction,actual.occurred_at);if(!evaluation)continue;resolutionStatements.push(env.DB.prepare("UPDATE twin_predictions SET status='resolved',resolved_observation_id=?1,actual_at=?2,absolute_error_minutes=?3,within_p80=?4,resolved_at=?5 WHERE prediction_id=?6 AND status='pending'").bind(actual.event_id,actual.occurred_at,evaluation.absoluteErrorMinutes,evaluation.withinP80?1:0,now,prediction.prediction_id));const predictedMinutes=differenceMinutes(prediction.predicted_at,prediction.eta_p50),actualMinutes=differenceMinutes(prediction.predicted_at,actual.occurred_at),p80Width=Math.max(0,differenceMinutes(prediction.eta_p80_start,prediction.eta_p80_end));resolutionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO model_evaluations(evaluation_id,run_id,train_number,from_station_id,to_station_id,predicted_minutes,actual_minutes,absolute_error_minutes,within_p80,baseline_samples,evaluated_at,source_id,evaluation_kind,model_version,horizon_minutes,p80_width_minutes)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'prospective','rail-intelligence-v3',?6,?13)`).bind(`twin:${prediction.prediction_id}`,prediction.run_id,prediction.train_number||"unknown",prediction.from_node_id,prediction.to_node_id,predictedMinutes,actualMinutes,evaluation.absoluteErrorMinutes,evaluation.withinP80?1:0,Number(prediction.baseline_samples)||0,actual.occurred_at,actual.source_id||null,p80Width));counters.resolved+=1;counters.prospectiveEvaluations+=1;}
    await batch(env,resolutionStatements);

    const calibration=await refreshCalibrationProfiles(env,now,stationAliases),calibrationV3=await refreshCalibrationProfilesV3(env,now,stationAliases);counters.calibrationProfiles=calibration.updated+calibrationV3.updated;
    const predictionEdges=candidateEdges.map((edge)=>applyCalibration(edge,calibration.profiles));
    const latestByRun=new Map();for(const event of eventRows)if(!latestByRun.has(event.run_id))latestByRun.set(event.run_id,event);
    const previousStates=new Map(rows(await env.DB.prepare("SELECT run_id,operational_state,state_since,anchor_node_id,next_node_id FROM twin_states").all()).map((state)=>[state.run_id,state])),predictionStatements=[],predictionByRun=new Map();
    for(const event of latestByRun.values()){
      const candidates=predictionEdges.filter(edge=>edge.from_station_id===resolveStationId(event.station,stationAliases)&&(edge.train_family===event.train_number||Number(edge.sample_count)>=5)).map((edge)=>applyCalibrationV3(edge,calibrationV3.profiles,{sourceId:event.source_id,trainFamily:event.train_number}));
      const twin=buildTwinHypotheses({event,candidates,now,routeHint:[event.route,event.origin,event.destination].filter(Boolean).join(" ")});if(!twin.state)continue;
      const primary=twin.hypotheses[0],stationEvidence=summarizeStationEvidence(eventsByRun.get(event.run_id)||[],(value)=>resolveStationId(value,stationAliases)),operational=deriveTwinOperationalState({now,anchorAt:event.occurred_at,positionStatus:twin.state.positionStatus,progress:primary.progress,etaP80End:primary.etaP80End,confidence:twin.state.confidence,repeatCount:stationEvidence.repeatCount,dwellMinutes:stationEvidence.dwellMinutes}),previousState=previousStates.get(event.run_id),transition=stateTransition(previousState,{...operational,now,anchorNodeId:twin.state.anchorNodeId,nextNodeId:twin.state.nextNodeId,positionStatus:twin.state.positionStatus}),stateSince=transition?.stateSince||previousState?.state_since||now;
      Object.assign(twin.state,{operationalState:operational.state,stateConfidence:operational.stateConfidence,stateSince,previousNodeId:stationEvidence.previousNodeId,dwellMinutes:operational.dwellMinutes,transitionReasons:operational.reasons,overdueMinutes:operational.overdueMinutes,method:"station-graph-probabilistic-twin-v3"});predictionByRun.set(event.run_id,{eta:twin.state.etaP50,confidence:twin.state.confidence,toNodeId:twin.state.nextNodeId,state:twin.state,hypotheses:twin.hypotheses});
      if(transition){const transitionId=`${event.run_id}:${event.event_id}:${transition.toState}:${twin.state.nextNodeId||"none"}`;predictionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO twin_state_transitions(transition_id,run_id,train_number,from_state,to_state,anchor_node_id,next_node_id,evidence_observation_id,confidence,occurred_at,calculated_at,reason_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11)`).bind(transitionId,event.run_id,event.train_number||null,transition.fromState,transition.toState,twin.state.anchorNodeId,twin.state.nextNodeId,event.event_id,operational.stateConfidence,now,JSON.stringify(transition.reason)));counters.stateTransitions+=1;}
      predictionStatements.push(env.DB.prepare("UPDATE twin_hypotheses SET status='superseded' WHERE run_id=?1 AND status='active' AND based_on_observation_id!=?2").bind(event.run_id,event.event_id));
      for(const hypothesis of twin.hypotheses)predictionStatements.push(env.DB.prepare(`INSERT INTO twin_hypotheses(hypothesis_id,run_id,train_number,based_on_observation_id,from_node_id,to_node_id,probability,progress,eta_p50,eta_p80_start,eta_p80_end,confidence,uncertainty_km,geometry_json,status,calculated_at,expires_at,reason_json)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'active',?15,?16,?17) ON CONFLICT(hypothesis_id) DO UPDATE SET probability=excluded.probability,progress=excluded.progress,confidence=excluded.confidence,uncertainty_km=excluded.uncertainty_km,geometry_json=excluded.geometry_json,status='active',calculated_at=excluded.calculated_at,expires_at=excluded.expires_at,reason_json=excluded.reason_json`).bind(hypothesis.hypothesisId,hypothesis.runId,hypothesis.trainNumber,hypothesis.basedOnObservationId,hypothesis.fromNodeId,hypothesis.toNodeId,hypothesis.probability,hypothesis.progress,hypothesis.etaP50,hypothesis.etaP80Start,hypothesis.etaP80End,hypothesis.confidence,hypothesis.uncertaintyKm,hypothesis.geometry?JSON.stringify({type:"LineString",coordinates:hypothesis.geometry}):null,now,hypothesis.expiresAt,JSON.stringify(hypothesis.reasons)));
      const state=twin.state;predictionStatements.push(env.DB.prepare(`INSERT INTO twin_states(run_id,train_number,anchor_observation_id,anchor_node_id,next_node_id,position_status,calculated_at,anchor_observed_at,eta_p50,eta_p80_start,eta_p80_end,confidence,uncertainty_km,method,primary_hypothesis_id,alternatives_count,latitude,longitude,state_json,operational_state,state_since,previous_node_id,dwell_minutes,state_confidence,transition_reason_json)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25) ON CONFLICT(run_id) DO UPDATE SET train_number=excluded.train_number,anchor_observation_id=excluded.anchor_observation_id,anchor_node_id=excluded.anchor_node_id,next_node_id=excluded.next_node_id,position_status=excluded.position_status,calculated_at=excluded.calculated_at,anchor_observed_at=excluded.anchor_observed_at,eta_p50=excluded.eta_p50,eta_p80_start=excluded.eta_p80_start,eta_p80_end=excluded.eta_p80_end,confidence=excluded.confidence,uncertainty_km=excluded.uncertainty_km,method=excluded.method,primary_hypothesis_id=excluded.primary_hypothesis_id,alternatives_count=excluded.alternatives_count,latitude=excluded.latitude,longitude=excluded.longitude,state_json=excluded.state_json,operational_state=excluded.operational_state,state_since=CASE WHEN twin_states.operational_state=excluded.operational_state THEN twin_states.state_since ELSE excluded.state_since END,previous_node_id=excluded.previous_node_id,dwell_minutes=excluded.dwell_minutes,state_confidence=excluded.state_confidence,transition_reason_json=excluded.transition_reason_json`).bind(state.runId,state.trainNumber,state.anchorObservationId,state.anchorNodeId,state.nextNodeId,state.positionStatus,state.calculatedAt,state.anchorObservedAt,state.etaP50,state.etaP80Start,state.etaP80End,state.confidence,state.uncertaintyKm,state.method,state.primaryHypothesisId,state.alternativesCount,state.latitude,state.longitude,JSON.stringify({ambiguous:state.ambiguous,ageMinutes:state.ageMinutes,geometryAvailable:state.geometryAvailable,overdueMinutes:state.overdueMinutes}),state.operationalState,state.stateSince,state.previousNodeId,state.dwellMinutes,state.stateConfidence,JSON.stringify(state.transitionReasons)));
      predictionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO twin_predictions(prediction_id,run_id,train_number,from_node_id,to_node_id,based_on_observation_id,predicted_at,eta_p50,eta_p80_start,eta_p80_end,confidence,method,baseline_samples) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'station-graph-probabilistic-twin-v3',?12)`).bind(primary.hypothesisId,event.run_id,event.train_number||null,primary.fromNodeId,primary.toNodeId,event.event_id,event.occurred_at,primary.etaP50,primary.etaP80Start,primary.etaP80End,primary.confidence,primary.samples));
      if(twin.ambiguous)predictionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO ops_workflows(workflow_id,movement_id,workflow_type,state,priority,title,description,created_by,created_at,updated_at) VALUES(?1,?2,'twin_ambiguity','open','normal',?3,?4,'rail-intelligence-v3',?5,?5)`).bind(`twin-review:${event.run_id}:${event.event_id}`,event.run_id,`Уточнить траекторию поезда ${event.train_number||event.run_id}`,`${twin.hypotheses.length} вероятных следующих участка; лучший вариант ${Math.round(primary.probability*100)}%.`,now));else predictionStatements.push(env.DB.prepare("UPDATE ops_workflows SET state='resolved',resolved_at=?1,resolution='automatic confidence restored',updated_at=?1 WHERE movement_id=?2 AND workflow_type='twin_ambiguity' AND state!='resolved'").bind(now,event.run_id));
      if(operational.state==="overdue")predictionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO ops_workflows(workflow_id,movement_id,workflow_type,state,priority,title,description,created_by,created_at,updated_at) VALUES(?1,?2,'missing_station_fact','open','high',?3,?4,'rail-intelligence-v3',?5,?5)`).bind(`missing-fact:${event.run_id}:${event.event_id}`,event.run_id,`Нет ожидаемого факта поезда ${event.train_number||event.run_id}`,`Следующее станционное событие вышло за P80 на ${Math.round(operational.overdueMinutes)} мин.`,now));else predictionStatements.push(env.DB.prepare("UPDATE ops_workflows SET state='resolved',resolved_at=?1,resolution='next fact window restored',updated_at=?1 WHERE movement_id=?2 AND workflow_type='missing_station_fact' AND state!='resolved'").bind(now,event.run_id));
      counters.predictions+=1;
    }
    await batch(env,predictionStatements);
    const runRows = rows(await env.DB.prepare("SELECT run_id,train_number,route,origin,destination,last_observed_at,current_update_json FROM runs WHERE last_observed_at>=datetime('now','-12 hours') ORDER BY last_observed_at DESC LIMIT 750").all());
    const movementStatements=[];
    for(const run of runRows){const update=parseJson(run.current_update_json),point=normalizeOperationalCoordinates(update),delay=Number(update.delayMinutes),prediction=predictionByRun.get(run.run_id),twinState=prediction?.state,eta=update.forecastArrival||update.estimatedArrival||update.nextStationEta||prediction?.eta||null,status=Number.isFinite(delay)&&delay>=60?"delayed":update.status||"observed",observationAgeMinutes=Math.max(0,differenceMinutes(run.last_observed_at,now)||0),rawConfidence=clamp(update.confidence??update.reliability??prediction?.confidence),agedConfidence=clamp(rawConfidence*Math.exp(-observationAgeMinutes/240)),positionStatus=observationAgeMinutes>240?"unknown":observationAgeMinutes>90?"stale":update.positionStatus||update.status||(prediction?"estimated":"unknown"),safeLatitude=observationAgeMinutes>240?null:point.latitude??twinState?.latitude??null,safeLongitude=observationAgeMinutes>240?null:point.longitude??twinState?.longitude??null;
      movementStatements.push(env.DB.prepare(`INSERT INTO ops_movements(movement_id,run_id,train_number,movement_type,origin,destination,route,status,delay_minutes,eta,last_station,last_observed_at,latitude,longitude,confidence,position_status,metadata_json)
        VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,delay_minutes=excluded.delay_minutes,eta=excluded.eta,last_station=excluded.last_station,last_observed_at=excluded.last_observed_at,latitude=excluded.latitude,longitude=excluded.longitude,confidence=excluded.confidence,position_status=excluded.position_status,metadata_json=excluded.metadata_json`).bind(run.run_id,run.train_number||null,update.trainCategory||"passenger",run.origin,run.destination,run.route,status,Number.isFinite(delay)?delay:null,eta,update.reportedStation||update.lastStation||null,run.last_observed_at,safeLatitude,safeLongitude,agedConfidence,positionStatus,JSON.stringify({sourceId:update.sourceId||null,method:update.positionMethod||twinState?.method||null,nextNodeId:prediction?.toNodeId||null,coordinateQuality:point.latitude!=null?point.coordinateQuality:twinState?.geometryAvailable?"rail-geometry-interpolation":"no-rail-geometry",coordinateRejected:point.rejected,observationAgeMinutes:Number(observationAgeMinutes.toFixed(1)),uncertaintyKm:twinState?.uncertaintyKm??Number((Math.max(3,Number(update.errorKm)||0)+observationAgeMinutes*.45).toFixed(1)),alternativesCount:twinState?.alternativesCount||0,ambiguous:Boolean(twinState?.ambiguous),anchorObservationId:twinState?.anchorObservationId||null,operationalState:twinState?.operationalState||null,stateSince:twinState?.stateSince||null,stateConfidence:twinState?.stateConfidence??null,dwellMinutes:twinState?.dwellMinutes??null,overdueMinutes:twinState?.overdueMinutes??null})));
      if(Number.isFinite(delay)&&delay>=60)movementStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO ops_notifications(notification_id,movement_id,notification_type,severity,title,message,occurred_at,dedupe_key,details_json) VALUES(?1,?2,'delay',?3,?4,?5,?6,?1,?7)`).bind(`delay:${run.run_id}:${Math.floor(delay/30)}`,run.run_id,delay>=180?"high":"medium",`Train ${run.train_number||run.run_id} delayed`,`Current delay: ${Math.round(delay)} minutes`,run.last_observed_at,JSON.stringify({delayMinutes:delay})));
    }
    await batch(env,movementStatements);

    const currentActivity=rows(await env.DB.prepare(`SELECT node_id,COUNT(*) observation_count,COUNT(DISTINCT run_id) unique_runs FROM rail_observations WHERE observed_at>=datetime('now','-1 hour') GROUP BY node_id`).all());
    const baselineActivity=rows(await env.DB.prepare(`SELECT node_id,COUNT(*)/23.0 baseline_per_hour FROM rail_observations WHERE observed_at>=datetime('now','-24 hours') AND observed_at<datetime('now','-1 hour') GROUP BY node_id`).all()); const baselineMap=new Map(baselineActivity.map(item=>[item.node_id,Number(item.baseline_per_hour)||0])),currentMap=new Map(currentActivity.map(item=>[item.node_id,item])),nodeIds=new Set([...currentMap.keys(),...baselineMap.keys()]);
    const scoreStatements=[],scoreByNode=new Map(); for(const nodeId of nodeIds){const item=currentMap.get(nodeId)||{node_id:nodeId,observation_count:0,unique_runs:0},baseline=baselineMap.get(nodeId)||0,activity=calculateNodeActivity({observations:item.observation_count,uniqueRuns:item.unique_runs,baselinePerHour:baseline,freshness:1}),scoreId=`${nodeId}:${now.slice(0,13)}`;scoreByNode.set(nodeId,activity.score);
      scoreStatements.push(env.DB.prepare(`INSERT INTO node_activity_scores(score_id,node_id,window_started_at,window_ended_at,observation_count,unique_runs,baseline_per_hour,activity_score,change_ratio,confidence,calculated_at) VALUES(?1,?2,datetime(?3,'-1 hour'),?3,?4,?5,?6,?7,?8,?9,?3) ON CONFLICT(score_id) DO UPDATE SET observation_count=excluded.observation_count,unique_runs=excluded.unique_runs,activity_score=excluded.activity_score,change_ratio=excluded.change_ratio,calculated_at=excluded.calculated_at`).bind(scoreId,item.node_id,now,Number(item.observation_count)||0,Number(item.unique_runs)||0,baseline,activity.score,activity.changeRatio,clamp((Number(item.observation_count)||0)/8)));
      const anomaly=classifyActivityAnomaly({observations:Number(item.observation_count)||0,baselinePerHour:baseline,changeRatio:activity.changeRatio});if(anomaly){scoreStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO network_anomalies(anomaly_id,anomaly_type,node_id,severity,score,detected_at,summary,evidence_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(`${anomaly.type}:${item.node_id}:${now.slice(0,13)}`,anomaly.type,item.node_id,anomaly.severity,anomaly.score,now,`${anomaly.type==="activity_spike"?"Activity increase":"Activity decrease"} at node ${item.node_id}`,JSON.stringify({observations:item.observation_count,baselinePerHour:baseline,changeRatio:activity.changeRatio})));counters.anomalies+=1;}}
    await batch(env,scoreStatements);
    const corridorRows=rows(await env.DB.prepare("SELECT corridor_id,border_nodes_json FROM international_corridors").all()),corridorStatements=[];
    for(const corridor of corridorRows){const nodeScores=parseJson(corridor.border_nodes_json,[]).map(nodeId=>scoreByNode.get(nodeId)).filter(Number.isFinite);if(!nodeScores.length)continue;const corridorScore=Number((nodeScores.reduce((sum,value)=>sum+value,0)/nodeScores.length).toFixed(1));corridorStatements.push(env.DB.prepare("UPDATE international_corridors SET status='monitored',activity_score=?1,last_observed_at=?2 WHERE corridor_id=?3").bind(corridorScore,now,corridor.corridor_id));}
    await batch(env,corridorStatements);
    await env.DB.batch([env.DB.prepare("UPDATE twin_predictions SET status='expired' WHERE status='pending' AND eta_p80_end<datetime('now','-6 hours')"),env.DB.prepare("DELETE FROM node_activity_scores WHERE calculated_at<datetime('now','-30 days')"),env.DB.prepare("UPDATE twin_hypotheses SET status='expired' WHERE status='active' AND expires_at<datetime('now')")]);
    await env.DB.prepare(`UPDATE intelligence_cycles SET finished_at=?1,status='success',nodes_updated=?2,edges_updated=?3,observations_added=?4,predictions_created=?5,predictions_resolved=?6,anomalies_detected=?7,routes_calculated=?8,links_created=?9,calibration_profiles=?10,state_transitions=?11,prospective_evaluations=?12,expected_runs=?13,silent_runs=?14,fused_observations=?15 WHERE cycle_id=?16`).bind(new Date().toISOString(),counters.nodes,counters.edges,counters.observations,counters.predictions,counters.resolved,counters.anomalies,counters.routesCalculated,counters.linksCreated,counters.calibrationProfiles,counters.stateTransitions,counters.prospectiveEvaluations,counters.expectedRuns,counters.silentRuns,counters.fusedObservations,cycleId).run();
    return {cycleId,status:"success",graphSync,...counters};
  } catch(error) {
    await env.DB.prepare("UPDATE intelligence_cycles SET finished_at=?1,status='failed',error=?2 WHERE cycle_id=?3").bind(new Date().toISOString(),String(error?.message||error).slice(0,500),cycleId).run(); throw error;
  }
}
