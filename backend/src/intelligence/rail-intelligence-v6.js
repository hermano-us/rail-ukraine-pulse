import { evaluateQualityGate } from "./operations-quality.js";

const rows=(result)=>result?.results||[];
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));
const rad=(value)=>Number(value)*Math.PI/180;
const distanceKm=(left,right)=>{const dLat=rad(right.latitude-left.latitude),dLon=rad(right.longitude-left.longitude),a=Math.sin(dLat/2)**2+Math.cos(rad(left.latitude))*Math.cos(rad(right.latitude))*Math.sin(dLon/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));};

export function classifyTrainCategory(value){
  const text=String(value||"").toLowerCase();
  if(/freight|cargo|вантаж|груз/.test(text))return "freight";
  if(/suburban|regional|примісь|электрич/.test(text))return "suburban";
  if(/intercity|ic\+|інтерсіті/.test(text))return "intercity";
  if(/special|служб|спец/.test(text))return "special";
  return "passenger";
}

export function buildStationCollectionPlan(priorities=[],now=new Date().toISOString()){
  return priorities.map((item)=>{
    const tier=item.priorityTier||item.priority_tier||"background",score=Number(item.priorityScore??item.priority_score)||0,silent=Number(item.silentRuns??item.silent_runs)||0,overdue=Number(item.overdueTwins??item.overdue_twins)||0;
    const target=tier==="critical"?2:tier==="corridor"?5:score>=20?10:20;
    const requestWeight=Math.max(1,Math.min(6,1+Math.floor(score/25)+Math.min(2,silent+overdue)));
    return {stationId:item.stationId||item.station_id,stationName:item.stationName||item.station_name,priorityTier:tier,priorityScore:score,targetIntervalMinutes:target,requestWeight,reasons:item.reasons||[],calculatedAt:now};
  }).filter((item)=>item.stationId).sort((a,b)=>a.targetIntervalMinutes-b.targetIntervalMinutes||b.priorityScore-a.priorityScore);
}

function componentIndex(nodes,edges){
  const adjacency=new Map(nodes.map((node)=>[node.id,new Set()]));
  for(const edge of edges){const from=edge.from||edge[0],to=edge.to||edge[1];if(!adjacency.has(from)||!adjacency.has(to)||from===to)continue;adjacency.get(from).add(to);adjacency.get(to).add(from);}
  const components=new Map();let component=0;
  for(const node of adjacency.keys()){if(components.has(node))continue;const queue=[node];components.set(node,component);for(let index=0;index<queue.length;index+=1)for(const next of adjacency.get(queue[index])||[])if(!components.has(next)){components.set(next,component);queue.push(next);}component+=1;}
  return {components,count:component,adjacency};
}

export function detectRailGraphGaps(nodes=[],edges=[],{maximumGapKm=35,maximumCandidates=100}={}){
  const valid=nodes.filter((node)=>node?.id&&Number.isFinite(Number(node.latitude))&&Number.isFinite(Number(node.longitude))).map((node)=>({...node,latitude:Number(node.latitude),longitude:Number(node.longitude)}));
  const topology=componentIndex(valid,edges);if(topology.count<=1)return {components:topology.count,candidates:[]};
  const terminals=valid.filter((node)=>(topology.adjacency.get(node.id)?.size||0)<=1),pool=terminals.length>=2?terminals:valid,best=new Map();
  for(let leftIndex=0;leftIndex<pool.length;leftIndex+=1)for(let rightIndex=leftIndex+1;rightIndex<pool.length;rightIndex+=1){const left=pool[leftIndex],right=pool[rightIndex],leftComponent=topology.components.get(left.id),rightComponent=topology.components.get(right.id);if(leftComponent===rightComponent)continue;const distance=distanceKm(left,right);if(distance>maximumGapKm)continue;const pair=leftComponent<rightComponent?`${leftComponent}:${rightComponent}`:`${rightComponent}:${leftComponent}`,current=best.get(pair);if(!current||distance<current.distanceKm)best.set(pair,{fromStationId:left.id,toStationId:right.id,fromComponent:leftComponent,toComponent:rightComponent,distanceKm:Number(distance.toFixed(2)),severity:distance<=5?"high":distance<=15?"medium":"low",reason:"disconnected-components-nearby"});}
  return {components:topology.count,candidates:[...best.values()].sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,maximumCandidates)};
}

export function probabilityHistorySample({runId,hypothesis,modelVersion,sampledAt}){
  const interval=hypothesis?.reasons?.progressInterval||{p10:hypothesis?.progress||0,p50:hypothesis?.progress||0,p90:hypothesis?.progress||0};
  return {sampleId:`${runId}:${sampledAt.slice(0,16)}:${hypothesis.hypothesisId}`,runId,hypothesisId:hypothesis.hypothesisId,modelVersion,fromNodeId:hypothesis.fromNodeId,toNodeId:hypothesis.toNodeId,probability:clamp(hypothesis.probability),progressP10:clamp(interval.p10),progressP50:clamp(interval.p50),progressP90:clamp(interval.p90),latitude:hypothesis.latitude??null,longitude:hypothesis.longitude??null,confidence:clamp(hypothesis.confidence),uncertaintyKm:hypothesis.uncertaintyKm??null,sampledAt};
}

export function evaluateReleaseDecision(current=[],baseline=[],minimumSamples=40){
  const gate=evaluateQualityGate([...current,...baseline],minimumSamples),currentUsable=current.filter((item)=>Number.isFinite(Number(item.absolute_error_minutes))),baselineUsable=baseline.filter((item)=>Number.isFinite(Number(item.absolute_error_minutes)));
  if(currentUsable.length<minimumSamples||baselineUsable.length<minimumSamples)return {...gate,decision:"hold",reason:"insufficient-comparable-evidence"};
  const average=(items,key)=>items.reduce((sum,item)=>sum+Number(item[key]||0),0)/items.length,currentMae=average(currentUsable,"absolute_error_minutes"),baselineMae=average(baselineUsable,"absolute_error_minutes"),currentCoverage=average(currentUsable,"within_p80")*100,baselineCoverage=average(baselineUsable,"within_p80")*100,regression=baselineMae>0?(currentMae-baselineMae)/baselineMae*100:0;
  const rollback=regression>=25&&currentCoverage<Math.max(65,baselineCoverage-10),promote=regression<=-8&&currentCoverage>=Math.max(72,baselineCoverage-3);
  return {decision:rollback?"rollback":promote?"promote":"hold",reason:rollback?"measured-regression":promote?"measured-improvement":"within-guardrails",samples:currentUsable.length,maeMinutes:Number(currentMae.toFixed(2)),p80Coverage:Number(currentCoverage.toFixed(2)),baselineMaeMinutes:Number(baselineMae.toFixed(2)),baselineP80Coverage:Number(baselineCoverage.toFixed(2)),maeRegressionPercent:Number(regression.toFixed(2))};
}

async function batch(env,statements,size=60){for(let index=0;index<statements.length;index+=size)await env.DB.batch(statements.slice(index,index+size));}

export async function persistStationCollectionPlan(env,priorities,now=new Date().toISOString()){
  const plan=buildStationCollectionPlan(priorities,now),statements=plan.map((item)=>env.DB.prepare(`INSERT INTO station_collection_plan(station_id,station_name,priority_tier,priority_score,target_interval_minutes,request_weight,reason_json,calculated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(station_id) DO UPDATE SET station_name=excluded.station_name,priority_tier=excluded.priority_tier,priority_score=excluded.priority_score,target_interval_minutes=excluded.target_interval_minutes,request_weight=excluded.request_weight,reason_json=excluded.reason_json,calculated_at=excluded.calculated_at`).bind(item.stationId,item.stationName,item.priorityTier,item.priorityScore,item.targetIntervalMinutes,item.requestWeight,JSON.stringify(item.reasons),now));
  await batch(env,statements);await env.DB.prepare("DELETE FROM station_collection_plan WHERE calculated_at<datetime('now','-2 days')").run();if(env.SNAPSHOT)await env.SNAPSHOT.put("intelligence:station-plan:v6",JSON.stringify({generatedAt:now,stations:plan.slice(0,200)}),{expirationTtl:1800});return plan;
}

export async function refreshRailGraphGaps(env,versionId,now=new Date().toISOString()){
  if(!versionId)return {status:"disabled",components:0,candidates:0};const previous=await env.DB.prepare("SELECT scanned_at FROM rail_graph_gap_scans WHERE version_id=?1").bind(versionId).first();if(previous&&Date.parse(now)-Date.parse(previous.scanned_at)<6*3600_000)return {status:"cached"};
  const [nodeResult,edgeResult]=await Promise.all([env.DB.prepare("SELECT station_id id,latitude,longitude FROM station_registry WHERE source_version=?1 AND latitude IS NOT NULL AND longitude IS NOT NULL LIMIT 6000").bind(versionId).all(),env.DB.prepare("SELECT from_station_id `from`,to_station_id `to` FROM rail_segment_geometries WHERE version_id=?1 LIMIT 30000").bind(versionId).all()]);
  const analysis=detectRailGraphGaps(rows(nodeResult),rows(edgeResult));const statements=[env.DB.prepare("UPDATE rail_graph_gaps SET status='resolved',resolved_at=?1,last_checked_at=?1 WHERE version_id=?2 AND status='open'").bind(now,versionId)];
  for(const gap of analysis.candidates){const id=`${versionId}:${gap.fromStationId}>${gap.toStationId}`;statements.push(env.DB.prepare(`INSERT INTO rail_graph_gaps(gap_id,version_id,from_station_id,to_station_id,distance_km,from_component,to_component,severity,status,reason,evidence_json,detected_at,last_checked_at,resolved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'open',?9,?10,?11,?11,NULL) ON CONFLICT(gap_id) DO UPDATE SET distance_km=excluded.distance_km,severity=excluded.severity,status='open',evidence_json=excluded.evidence_json,last_checked_at=excluded.last_checked_at,resolved_at=NULL`).bind(id,versionId,gap.fromStationId,gap.toStationId,gap.distanceKm,gap.fromComponent,gap.toComponent,gap.severity,gap.reason,JSON.stringify(gap),now));}
  statements.push(env.DB.prepare(`INSERT INTO rail_graph_gap_scans(version_id,components,candidates,scanned_at) VALUES(?1,?2,?3,?4) ON CONFLICT(version_id) DO UPDATE SET components=excluded.components,candidates=excluded.candidates,scanned_at=excluded.scanned_at`).bind(versionId,analysis.components,analysis.candidates.length,now));await batch(env,statements);return {status:"scanned",components:analysis.components,candidates:analysis.candidates.length};
}

export async function recordProbabilityHistory(env,samples,now=new Date().toISOString()){
  const statements=samples.map((item)=>env.DB.prepare(`INSERT OR IGNORE INTO twin_probability_history(sample_id,run_id,hypothesis_id,model_version,from_node_id,to_node_id,probability,progress_p10,progress_p50,progress_p90,latitude,longitude,confidence,uncertainty_km,sampled_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`).bind(item.sampleId,item.runId,item.hypothesisId,item.modelVersion,item.fromNodeId,item.toNodeId,item.probability,item.progressP10,item.progressP50,item.progressP90,item.latitude,item.longitude,item.confidence,item.uncertaintyKm,item.sampledAt));await batch(env,statements);await env.DB.prepare("DELETE FROM twin_probability_history WHERE sampled_at<datetime('now','-7 days')").run();return statements.length;
}

export async function refreshModelGovernance(env,now=new Date().toISOString()){
  const active=await env.DB.prepare("SELECT * FROM model_releases WHERE status='active' LIMIT 1").first();if(!active)return {activeModel:"rail-intelligence-v5",decision:"unmanaged"};const minimum=Math.max(20,Number(active.minimum_samples)||40),evaluationRows=rows(await env.DB.prepare("SELECT absolute_error_minutes,within_p80,evaluated_at FROM model_evaluations WHERE model_version=?1 AND evaluation_kind='prospective' ORDER BY evaluated_at DESC LIMIT ?2").bind(active.model_version,minimum*2).all()),current=evaluationRows.slice(0,minimum),baseline=evaluationRows.slice(minimum,minimum*2),decision=evaluateReleaseDecision(current,baseline,minimum),windowId=`${active.model_version}:${now.slice(0,13)}`;
  await env.DB.prepare(`INSERT OR IGNORE INTO model_quality_windows(window_id,model_version,sample_count,mae_minutes,p80_coverage,baseline_mae_minutes,baseline_p80_coverage,decision,reason,window_started_at,window_ended_at,evaluated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`).bind(windowId,active.model_version,decision.samples||current.length,decision.maeMinutes??null,decision.p80Coverage??null,decision.baselineMaeMinutes??null,decision.baselineP80Coverage??null,decision.decision,decision.reason,current.at(-1)?.evaluated_at||null,current[0]?.evaluated_at||null,now).run();
  if(decision.decision==="rollback"&&active.fallback_version){await env.DB.batch([env.DB.prepare("UPDATE model_releases SET status='rolled_back',rollout_percent=0,evaluated_at=?1,rolled_back_at=?1,rollback_reason=?2 WHERE model_version=?3").bind(now,decision.reason,active.model_version),env.DB.prepare("UPDATE model_releases SET status='active',rollout_percent=100,activated_at=?1,evaluated_at=?1 WHERE model_version=?2").bind(now,active.fallback_version)]);return {activeModel:active.fallback_version,previousModel:active.model_version,...decision};}
  await env.DB.prepare("UPDATE model_releases SET evaluated_at=?1 WHERE model_version=?2").bind(now,active.model_version).run();return {activeModel:active.model_version,...decision};
}
