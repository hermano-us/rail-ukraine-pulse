const rows = (result) => result?.results || [];
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value || "") ?? fallback; } catch { return fallback; } };
const stationId = (value) => String(value || "unknown").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 120) || "unknown";
const addMinutes = (value, minutes) => new Date(Date.parse(value) + Number(minutes) * 60_000).toISOString();
const differenceMinutes = (left, right) => (Date.parse(right) - Date.parse(left)) / 60_000;

async function batch(env, statements, size = 75) {
  for (let index = 0; index < statements.length; index += size) await env.DB.batch(statements.slice(index, index + size));
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

function coordinates(update = {}) {
  const position = update.position || update.estimatedPosition || update.calculatedPosition || {};
  const latitude = Number(update.latitude ?? update.lat ?? position.latitude ?? position.lat);
  const longitude = Number(update.longitude ?? update.lon ?? update.lng ?? position.longitude ?? position.lon ?? position.lng);
  return { latitude: Number.isFinite(latitude) ? latitude : null, longitude: Number.isFinite(longitude) ? longitude : null };
}

export async function runIntelligenceCycle(env, now = new Date().toISOString()) {
  const cycleId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO intelligence_cycles(cycle_id,started_at,status) VALUES(?1,?2,'running')").bind(cycleId, now).run();
  const counters = { nodes: 0, edges: 0, observations: 0, predictions: 0, resolved: 0, anomalies: 0 };
  try {
    const eventRows = rows(await env.DB.prepare(`SELECT e.event_id,e.run_id,e.station,e.occurred_at,e.observed_at,e.source_id,e.authority,e.reliability,e.raw_update_json,r.train_number
      FROM events e LEFT JOIN runs r ON r.run_id=e.run_id
      WHERE e.event_type='station_report' AND e.station IS NOT NULL AND e.occurred_at>=datetime('now','-7 days')
      ORDER BY e.occurred_at DESC LIMIT 1500`).all());
    const nodeMap = new Map();
    const observationStatements = [];
    for (const event of eventRows) {
      const nodeId = stationId(event.station); const raw = parseJson(event.raw_update_json); const point = coordinates(raw);
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

    const segmentRows = rows(await env.DB.prepare("SELECT * FROM segment_stats ORDER BY sample_count DESC LIMIT 1500").all());
    const missingNodes = new Map();
    for (const edge of segmentRows) for (const id of [edge.from_station_id, edge.to_station_id]) if (!nodeMap.has(id)) missingNodes.set(id, env.DB.prepare(`INSERT OR IGNORE INTO rail_nodes(node_id,station_name,first_seen_at,last_seen_at) VALUES(?1,?1,?2,?2)`).bind(id, now));
    await batch(env, [...missingNodes.values()]);
    const edgeStatements = segmentRows.map((edge) => { const reliability=clamp(Math.log1p(Number(edge.sample_count)||0)/Math.log(21)); return env.DB.prepare(`INSERT INTO rail_edges(edge_id,from_node_id,to_node_id,train_family,sample_count,p10_minutes,p50_minutes,p90_minutes,reliability,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(edge_id) DO UPDATE SET sample_count=excluded.sample_count,p10_minutes=excluded.p10_minutes,p50_minutes=excluded.p50_minutes,p90_minutes=excluded.p90_minutes,reliability=excluded.reliability,updated_at=excluded.updated_at`).bind(`${edge.from_station_id}>${edge.to_station_id}:${edge.train_family}`,edge.from_station_id,edge.to_station_id,edge.train_family,Number(edge.sample_count)||0,edge.p10_minutes,edge.p50_minutes,edge.p90_minutes,reliability,edge.updated_at||now); });
    await batch(env, edgeStatements); counters.edges = edgeStatements.length;

    const pending = rows(await env.DB.prepare("SELECT * FROM twin_predictions WHERE status='pending' ORDER BY predicted_at LIMIT 1000").all());
    const resolutionStatements = [];
    for (const prediction of pending) {
      const actual = eventRows.find((event) => event.run_id===prediction.run_id && stationId(event.station)===prediction.to_node_id && Date.parse(event.occurred_at)>Date.parse(prediction.predicted_at));
      if (!actual) continue; const evaluation = evaluatePrediction(prediction, actual.occurred_at); if (!evaluation) continue;
      resolutionStatements.push(env.DB.prepare("UPDATE twin_predictions SET status='resolved',resolved_observation_id=?1,actual_at=?2,absolute_error_minutes=?3,within_p80=?4,resolved_at=?5 WHERE prediction_id=?6 AND status='pending'").bind(actual.event_id,actual.occurred_at,evaluation.absoluteErrorMinutes,evaluation.withinP80?1:0,now,prediction.prediction_id));
      const predictedMinutes=differenceMinutes(prediction.predicted_at,prediction.eta_p50),actualMinutes=differenceMinutes(prediction.predicted_at,actual.occurred_at);
      resolutionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO model_evaluations(evaluation_id,run_id,train_number,from_station_id,to_station_id,predicted_minutes,actual_minutes,absolute_error_minutes,within_p80,baseline_samples,evaluated_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`).bind(`twin:${prediction.prediction_id}`,prediction.run_id,prediction.train_number||"unknown",prediction.from_node_id,prediction.to_node_id,predictedMinutes,actualMinutes,evaluation.absoluteErrorMinutes,evaluation.withinP80?1:0,Number(prediction.baseline_samples)||0,actual.occurred_at)); counters.resolved += 1;
    }
    await batch(env, resolutionStatements);

    const latestByRun = new Map();
    for (const event of eventRows) if (!latestByRun.has(event.run_id)) latestByRun.set(event.run_id,event);
    const predictionStatements = [];
    const predictionByRun = new Map();
    for (const event of latestByRun.values()) {
      const fromId=stationId(event.station); const candidates=segmentRows.filter((edge)=>edge.from_station_id===fromId && (edge.train_family===event.train_number || Number(edge.sample_count)>=5)).sort((a,b)=>Number(b.sample_count)-Number(a.sample_count)); const edge=candidates[0];
      if(!edge||!Number.isFinite(Number(edge.p50_minutes)))continue; const p10=Number(edge.p10_minutes??edge.p50_minutes),p50=Number(edge.p50_minutes),p90=Number(edge.p90_minutes??edge.p50_minutes); const confidence=clamp(Math.log1p(Number(edge.sample_count)||0)/Math.log(31))*clamp(event.reliability??.6); predictionByRun.set(event.run_id,{eta:addMinutes(event.occurred_at,p50),confidence,toNodeId:edge.to_station_id});
      predictionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO twin_predictions(prediction_id,run_id,train_number,from_node_id,to_node_id,based_on_observation_id,predicted_at,eta_p50,eta_p80_start,eta_p80_end,confidence,method,baseline_samples)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'station-graph-digital-twin-v1',?12)`).bind(`${event.run_id}:${event.event_id}:${edge.from_station_id}>${edge.to_station_id}`,event.run_id,event.train_number||null,edge.from_station_id,edge.to_station_id,event.event_id,event.occurred_at,addMinutes(event.occurred_at,p50),addMinutes(event.occurred_at,p10),addMinutes(event.occurred_at,p90),confidence,Number(edge.sample_count)||0)); counters.predictions += 1;
    }
    await batch(env, predictionStatements);

    const runRows = rows(await env.DB.prepare("SELECT run_id,train_number,route,origin,destination,last_observed_at,current_update_json FROM runs WHERE last_observed_at>=datetime('now','-12 hours') ORDER BY last_observed_at DESC LIMIT 750").all());
    const movementStatements=[];
    for(const run of runRows){const update=parseJson(run.current_update_json),point=coordinates(update),delay=Number(update.delayMinutes),prediction=predictionByRun.get(run.run_id),eta=update.forecastArrival||update.estimatedArrival||update.nextStationEta||prediction?.eta||null,status=Number.isFinite(delay)&&delay>=60?"delayed":update.status||"observed";
      movementStatements.push(env.DB.prepare(`INSERT INTO ops_movements(movement_id,run_id,train_number,movement_type,origin,destination,route,status,delay_minutes,eta,last_station,last_observed_at,latitude,longitude,confidence,position_status,metadata_json)
        VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,delay_minutes=excluded.delay_minutes,eta=excluded.eta,last_station=excluded.last_station,last_observed_at=excluded.last_observed_at,latitude=excluded.latitude,longitude=excluded.longitude,confidence=excluded.confidence,position_status=excluded.position_status,metadata_json=excluded.metadata_json`).bind(run.run_id,run.train_number||null,update.trainCategory||"passenger",run.origin,run.destination,run.route,status,Number.isFinite(delay)?delay:null,eta,update.reportedStation||update.lastStation||null,run.last_observed_at,point.latitude,point.longitude,clamp(update.confidence??update.reliability??prediction?.confidence),update.positionStatus||update.status||(prediction?"estimated":"unknown"),JSON.stringify({sourceId:update.sourceId||null,method:update.positionMethod||(prediction?"station-graph-digital-twin-v1":null),nextNodeId:prediction?.toNodeId||null})));
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
    await env.DB.batch([env.DB.prepare("UPDATE twin_predictions SET status='expired' WHERE status='pending' AND eta_p80_end<datetime('now','-6 hours')"),env.DB.prepare("DELETE FROM node_activity_scores WHERE calculated_at<datetime('now','-30 days')")]);
    await env.DB.prepare(`UPDATE intelligence_cycles SET finished_at=?1,status='success',nodes_updated=?2,edges_updated=?3,observations_added=?4,predictions_created=?5,predictions_resolved=?6,anomalies_detected=?7 WHERE cycle_id=?8`).bind(new Date().toISOString(),counters.nodes,counters.edges,counters.observations,counters.predictions,counters.resolved,counters.anomalies,cycleId).run();
    return {cycleId,status:"success",...counters};
  } catch(error) {
    await env.DB.prepare("UPDATE intelligence_cycles SET finished_at=?1,status='failed',error=?2 WHERE cycle_id=?3").bind(new Date().toISOString(),String(error?.message||error).slice(0,500),cycleId).run(); throw error;
  }
}
