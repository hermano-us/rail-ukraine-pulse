import { hasPermission, writeSecureAudit } from "../security/access.js";

const rows = (result) => result?.results || [];
const allowed = (principal, ...permissions) => permissions.some((permission) => hasPermission(principal, permission));
const stationId = (value) => String(value || "unknown").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 120) || "unknown";
const safeLimit = (url, fallback, maximum) => Math.max(1, Math.min(maximum, Number(url.searchParams.get("limit")) || fallback));

async function railIntelligence(request, env, principal, json) {
  if (!allowed(principal, "rail.intelligence.read", "restricted.map", "admin.overview")) return json({ error: "forbidden" }, 403);
  const url = new URL(request.url); const runId = String(url.searchParams.get("runId") || "").trim(); const limit = safeLimit(url, 150, 500);
  if (request.method === "GET") {
    const [counts, nodes, edges, predictions, observations, trajectory] = await Promise.all([
      env.DB.prepare(`SELECT (SELECT COUNT(*) FROM rail_nodes) nodes,(SELECT COUNT(*) FROM rail_edges) edges,(SELECT COUNT(*) FROM rail_observations) observations,(SELECT COUNT(*) FROM twin_predictions WHERE status='pending') pending_predictions,(SELECT COUNT(*) FROM twin_predictions WHERE status='resolved') resolved_predictions`).first(),
      env.DB.prepare("SELECT node_id,station_name,latitude,longitude,country_code,node_type,last_seen_at,observation_count FROM rail_nodes ORDER BY observation_count DESC,last_seen_at DESC LIMIT ?1").bind(limit).all(),
      env.DB.prepare("SELECT edge_id,from_node_id,to_node_id,train_family,distance_km,sample_count,p10_minutes,p50_minutes,p90_minutes,reliability,geometry_json,updated_at FROM rail_edges ORDER BY sample_count DESC LIMIT ?1").bind(limit * 2).all(),
      runId ? env.DB.prepare("SELECT * FROM twin_predictions WHERE run_id=?1 ORDER BY predicted_at DESC LIMIT ?2").bind(runId,limit).all() : env.DB.prepare("SELECT * FROM twin_predictions ORDER BY predicted_at DESC LIMIT ?1").bind(limit).all(),
      runId ? env.DB.prepare("SELECT * FROM rail_observations WHERE run_id=?1 ORDER BY observed_at DESC LIMIT ?2").bind(runId,limit).all() : env.DB.prepare("SELECT * FROM rail_observations ORDER BY observed_at DESC LIMIT ?1").bind(limit).all(),
      runId ? env.DB.prepare("SELECT * FROM trajectory_points WHERE run_id=?1 ORDER BY occurred_at LIMIT ?2").bind(runId,limit*4).all() : Promise.resolve({results:[]}),
    ]);
    return json({ generatedAt:new Date().toISOString(), graph:{nodes:rows(nodes),edges:rows(edges)}, twins:rows(predictions), observations:rows(observations), trajectory:rows(trajectory), counts:{nodes:Number(counts?.nodes||0),edges:Number(counts?.edges||0),observations:Number(counts?.observations||0),pendingPredictions:Number(counts?.pending_predictions||0),resolvedPredictions:Number(counts?.resolved_predictions||0)}, policy:{geometry:"rail-graph-only",positionStatuses:["confirmed","reported","estimated","stale","unknown"]} });
  }
  if (request.method === "POST") {
    if (!allowed(principal, "rail.observations.write", "rail.correct")) return json({ error:"forbidden" },403);
    const body=await request.json(),runIdValue=String(body.runId||"").trim(),station=String(body.station||"").trim(),observedAt=body.observedAt||new Date().toISOString();
    if(!runIdValue||station.length<2||!Number.isFinite(Date.parse(observedAt)))return json({error:"invalid_observation"},400);const nodeId=stationId(station),observationId=crypto.randomUUID(),now=new Date().toISOString(),reliability=Math.max(0,Math.min(.95,Number(body.reliability)||.7));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rail_nodes(node_id,station_name,first_seen_at,last_seen_at,observation_count) VALUES(?1,?2,?3,?3,1) ON CONFLICT(node_id) DO UPDATE SET station_name=excluded.station_name,last_seen_at=MAX(rail_nodes.last_seen_at,excluded.last_seen_at),observation_count=rail_nodes.observation_count+1").bind(nodeId,station,observedAt),
      env.DB.prepare(`INSERT INTO rail_observations(observation_id,run_id,train_number,node_id,station_name,observed_at,received_at,source_id,authority,reliability,evidence_type,latitude,longitude,evidence_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'operations-hub',?8,?9,?10,?11,?12,?13)`).bind(observationId,runIdValue,body.trainNumber||null,nodeId,station,observedAt,now,principal.role,reliability,body.evidenceType||"operator_report",Number.isFinite(Number(body.latitude))?Number(body.latitude):null,Number.isFinite(Number(body.longitude))?Number(body.longitude):null,JSON.stringify({note:String(body.note||"").slice(0,500)})),
      env.DB.prepare(`INSERT INTO trajectory_points(trajectory_point_id,run_id,observation_id,node_id,occurred_at,latitude,longitude,confidence,reconstruction_method) VALUES(?1,?2,?1,?3,?4,?5,?6,?7,'operator-confirmed-station-anchor')`).bind(observationId,runIdValue,nodeId,observedAt,Number.isFinite(Number(body.latitude))?Number(body.latitude):null,Number.isFinite(Number(body.longitude))?Number(body.longitude):null,reliability),
    ]); await writeSecureAudit(env,principal,"rail.observation_created","rail_observation",observationId,{runId:runIdValue,nodeId}); return json({ok:true,observationId,nodeId},201);
  }
  return json({error:"method_not_allowed"},405);
}

async function operationsHub(request,env,principal,json){
  if(!allowed(principal,"operations.hub.read","shipments.read","admin.overview"))return json({error:"forbidden"},403);const url=new URL(request.url),limit=safeLimit(url,200,750);
  if(request.method==="GET"){const [movements,notifications,workflows]=await Promise.all([env.DB.prepare("SELECT * FROM ops_movements ORDER BY last_observed_at DESC LIMIT ?1").bind(limit).all(),env.DB.prepare("SELECT * FROM ops_notifications WHERE acknowledged_at IS NULL ORDER BY occurred_at DESC LIMIT 200").all(),env.DB.prepare("SELECT * FROM ops_workflows WHERE state!='resolved' ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,updated_at DESC LIMIT 200").all()]);return json({generatedAt:new Date().toISOString(),movements:rows(movements),notifications:rows(notifications),workflows:rows(workflows),counts:{movements:rows(movements).length,notifications:rows(notifications).length,workflows:rows(workflows).length},refreshSeconds:15});}
  if(request.method==="POST"){const body=await request.json();
    if(body.action==="ack-notification"){if(!allowed(principal,"operations.notifications.manage","shipments.update"))return json({error:"forbidden"},403);await env.DB.prepare("UPDATE ops_notifications SET acknowledged_at=?1,acknowledged_by=?2 WHERE notification_id=?3 AND acknowledged_at IS NULL").bind(new Date().toISOString(),principal.id,body.id).run();await writeSecureAudit(env,principal,"notification.acknowledged","ops_notification",body.id);return json({ok:true});}
    if(body.action==="update-movement"){if(!allowed(principal,"operations.hub.write","shipments.update","shipments.write"))return json({error:"forbidden"},403);const state=String(body.workflowState||"monitoring");if(!["monitoring","attention","investigating","resolved"].includes(state))return json({error:"invalid_state"},400);await env.DB.prepare("UPDATE ops_movements SET workflow_state=?1,assigned_to=?2 WHERE movement_id=?3").bind(state,body.assignedTo||null,body.id).run();await writeSecureAudit(env,principal,"movement.workflow_updated","ops_movement",body.id,{state});return json({ok:true});}
    if(body.action==="create-workflow"){if(!allowed(principal,"operations.hub.write","shipments.write"))return json({error:"forbidden"},403);const title=String(body.title||"").trim();if(title.length<3)return json({error:"invalid_workflow"},400);const id=crypto.randomUUID(),now=new Date().toISOString();await env.DB.prepare("INSERT INTO ops_workflows(workflow_id,movement_id,workflow_type,state,priority,title,description,assigned_to,created_by,created_at,updated_at) VALUES(?1,?2,?3,'open',?4,?5,?6,?7,?8,?9,?9)").bind(id,body.movementId||null,body.workflowType||"investigation",body.priority||"normal",title,String(body.description||"").slice(0,1000),body.assignedTo||null,principal.id,now).run();await writeSecureAudit(env,principal,"workflow.created","ops_workflow",id,{movementId:body.movementId||null});return json({ok:true,workflowId:id},201);}
    return json({error:"unknown_action"},400);
  }return json({error:"method_not_allowed"},405);
}

async function analyticsNetwork(request,env,principal,json){
  if(!allowed(principal,"analytics.network.read","admin.overview"))return json({error:"forbidden"},403);if(request.method!=="GET")return json({error:"method_not_allowed"},405);const [activity,anomalies,corridors,cycles,quality]=await Promise.all([
    env.DB.prepare(`SELECT s.*,n.station_name,n.latitude,n.longitude FROM node_activity_scores s LEFT JOIN rail_nodes n ON n.node_id=s.node_id WHERE s.calculated_at=(SELECT MAX(s2.calculated_at) FROM node_activity_scores s2 WHERE s2.node_id=s.node_id) ORDER BY s.activity_score DESC LIMIT 250`).all(),
    env.DB.prepare("SELECT * FROM network_anomalies WHERE status='open' ORDER BY detected_at DESC LIMIT 200").all(),
    env.DB.prepare("SELECT * FROM international_corridors ORDER BY corridor_id").all(),
    env.DB.prepare("SELECT * FROM intelligence_cycles ORDER BY started_at DESC LIMIT 288").all(),
    env.DB.prepare(`SELECT COUNT(*) evaluations,AVG(absolute_error_minutes) mae_minutes,AVG(within_p80)*100 p80_coverage,MAX(evaluated_at) latest FROM model_evaluations WHERE evaluated_at>=datetime('now','-30 days')`).first(),
  ]);return json({generatedAt:new Date().toISOString(),nodeActivity:rows(activity),anomalies:rows(anomalies),corridors:rows(corridors).map(item=>({...item,countries:JSON.parse(item.countries_json||"[]"),borderNodes:JSON.parse(item.border_nodes_json||"[]")})),cycles:rows(cycles),calibration:{evaluations:Number(quality?.evaluations||0),maeMinutes:quality?.mae_minutes==null?null:Number(Number(quality.mae_minutes).toFixed(1)),p80Coverage:quality?.p80_coverage==null?null:Number(Number(quality.p80_coverage).toFixed(1)),latest:quality?.latest||null}});
}

export async function handleIntelligencePlatformRequest(request,env,principal,json){const path=new URL(request.url).pathname;if(path==="/api/restricted/rail-intelligence")return railIntelligence(request,env,principal,json);if(path==="/api/restricted/operations-hub")return operationsHub(request,env,principal,json);if(path==="/api/restricted/analytics-network")return analyticsNetwork(request,env,principal,json);return null;}
