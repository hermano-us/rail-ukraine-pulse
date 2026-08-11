const rows = (result) => result?.results || [];
let topologyCache = null;
const normalizedContext=(pair)=>({waypoints:[...new Set((pair.waypoints||[]).filter(Boolean))],routeRelationIds:[...new Set((pair.routeRelationIds||[]).map(String))],trainCategory:pair.trainCategory||null,gauge:pair.gauge?String(pair.gauge):null,electrified:pair.electrified||null,allowServiceTracks:Boolean(pair.allowServiceTracks),direction:pair.direction||null});
export function contextHash(pair){const serialized=JSON.stringify(normalizedContext(pair));let hash=2166136261;for(let index=0;index<serialized.length;index+=1){hash^=serialized.charCodeAt(index);hash=Math.imul(hash,16777619);}return `v7-${(hash>>>0).toString(16).padStart(8,"0")}`;}
function routeKey(pair){return `${pair.from}>${pair.to}`;}

class MinHeap {
  constructor(){this.values=[];}
  push(item){this.values.push(item);let index=this.values.length-1;while(index>0){const parent=(index-1)>>1;if(this.values[parent].distance<=item.distance)break;this.values[index]=this.values[parent];index=parent;}this.values[index]=item;}
  pop(){if(!this.values.length)return null;const first=this.values[0],last=this.values.pop();if(this.values.length){let index=0;while(true){let child=index*2+1;if(child>=this.values.length)break;if(child+1<this.values.length&&this.values[child+1].distance<this.values[child].distance)child+=1;if(this.values[child].distance>=last.distance)break;this.values[index]=this.values[child];index=child;}this.values[index]=last;}return first;}
}

export function buildTopology(edges = []) {
  const adjacency=new Map();
  for(const raw of edges){const item=Array.isArray(raw)?{from:raw[0],to:raw[1],distanceKm:raw[2]}:raw||{},from=item.from,to=item.to,distance=Number(item.distanceKm??item.distance);if(!from||!to||!(distance>0))continue;for(const [left,right] of [[from,to],[to,from]]){const list=adjacency.get(left)||[];list.push({to:right,distance,railwayType:item.railwayType||"rail",usage:item.usage||null,services:Array.isArray(item.services)?item.services:[],serviceShare:Number.isFinite(Number(item.serviceShare))?Math.max(0,Math.min(1,Number(item.serviceShare))):null,electrified:item.electrified||null,gauges:Array.isArray(item.gauges)?item.gauges:[],tracks:Number(item.tracks)||null,routeRelationIds:Array.isArray(item.routeRelationIds)?item.routeRelationIds.map(String):[]});adjacency.set(left,list);}}
  return adjacency;
}

function routeEdgeCost(edge,context={}){
  if(["abandoned","razed","construction","proposed"].includes(edge.railwayType)||context.disallowedRailwayTypes?.includes(edge.railwayType))return Infinity;
  let multiplier=1;const services=new Set(edge.services||[]);
  const servicePenalty=Math.max(1,services.has("yard")?(context.allowServiceTracks?2.5:9):1,services.has("siding")?(context.allowServiceTracks?1.8:5):1,services.has("spur")?(context.allowServiceTracks?1.5:4):1,services.has("crossover")?2:1),serviceShare=edge.serviceShare==null?(services.size?1:0):edge.serviceShare;
  multiplier*=1+(servicePenalty-1)*serviceShare;
  if(edge.usage==="industrial")multiplier*=context.trainCategory==="freight"?1.15:3;
  else if(edge.usage==="branch")multiplier*=1.2;
  if(context.gauge&&edge.gauges.length&&!edge.gauges.includes(String(context.gauge)))multiplier*=8;
  if(context.electrified&&edge.electrified&&edge.electrified!=="no"&&context.electrified!==edge.electrified)multiplier*=1.65;
  const preferred=new Set((context.routeRelationIds||[]).map(String));if(preferred.size&&edge.routeRelationIds.some((id)=>preferred.has(id)))multiplier*=.55;
  else if(edge.routeRelationIds.length)multiplier*=.88;
  return edge.distance*multiplier;
}

function weightedPath(adjacency,from,to,context={},options={}){
  if(!from||!to||from===to)return null;const maximumHops=options.maximumHops||160,maximumDistanceKm=options.maximumDistanceKm||1800,banned=options.bannedEdges||new Set(),costs=new Map([[from,0]]),distances=new Map([[from,0]]),hops=new Map([[from,0]]),previous=new Map(),queue=new MinHeap();queue.push({node:from,distance:0});
  while(queue.values.length){const current=queue.pop();if(current.distance!==costs.get(current.node))continue;if(current.node===to)break;const currentHops=hops.get(current.node)||0;if(currentHops>=maximumHops)continue;for(const edge of adjacency.get(current.node)||[]){if(banned.has(`${current.node}>${edge.to}`))continue;const edgeCost=routeEdgeCost(edge,context);if(!Number.isFinite(edgeCost))continue;const physical=(distances.get(current.node)||0)+edge.distance,cost=current.distance+edgeCost;if(physical>maximumDistanceKm||cost>=Number(costs.get(edge.to)??Infinity))continue;costs.set(edge.to,cost);distances.set(edge.to,physical);hops.set(edge.to,currentHops+1);previous.set(edge.to,{node:current.node,edge});queue.push({node:edge.to,distance:cost});}}
  if(!costs.has(to))return null;const nodes=[to],edges=[];while(nodes[0]!==from){const step=previous.get(nodes[0]);if(!step)return null;edges.unshift(step.edge);nodes.unshift(step.node);if(nodes.length>maximumHops+1)return null;}return {nodes,edges,distanceKm:Number(distances.get(to).toFixed(3)),routingCost:Number(costs.get(to).toFixed(3)),hopCount:nodes.length-1};
}

function pathThroughWaypoints(adjacency,from,to,context,options={}){
  const stops=[from,...new Set((context.waypoints||[]).filter((item)=>item&&item!==from&&item!==to)),to],nodes=[],edges=[];let distanceKm=0,routingCost=0;
  for(let index=1;index<stops.length;index+=1){const leg=weightedPath(adjacency,stops[index-1],stops[index],context,options);if(!leg)return null;nodes.push(...(nodes.length?leg.nodes.slice(1):leg.nodes));edges.push(...leg.edges);distanceKm+=leg.distanceKm;routingCost+=leg.routingCost;}
  return {nodes,edges,distanceKm:Number(distanceKm.toFixed(3)),routingCost:Number(routingCost.toFixed(3)),hopCount:nodes.length-1};
}

export function routeAwareCandidates(adjacency,from,to,context={},options={}){
  const maximumCandidates=Math.max(1,Math.min(5,Number(options.maximumCandidates)||3)),primary=pathThroughWaypoints(adjacency,from,to,context,options);if(!primary)return [];
  const candidates=new Map([[primary.nodes.join(">"),primary]]),edgesToProbe=primary.nodes.slice(0,-1).map((node,index)=>`${node}>${primary.nodes[index+1]}`).slice(0,Math.max(8,maximumCandidates*4));
  for(const signature of edgesToProbe){const alternative=pathThroughWaypoints(adjacency,from,to,context,{...options,bannedEdges:new Set([...(options.bannedEdges||[]),signature])});if(alternative)candidates.set(alternative.nodes.join(">"),alternative);if(candidates.size>=maximumCandidates*3)break;}
  const ordered=[...candidates.values()].sort((left,right)=>left.routingCost-right.routingCost).slice(0,maximumCandidates),bestCost=ordered[0].routingCost;
  return ordered.map((path,index)=>{const relationEdges=path.edges.filter((edge)=>edge.routeRelationIds.length).length,serviceEdges=path.edges.filter((edge)=>edge.services.length).length,relative=bestCost/Math.max(bestCost,path.routingCost),confidence=Math.max(.35,Math.min(.98,.58+.16*relative+.12*(relationEdges/Math.max(1,path.edges.length))+.08*(context.waypoints?.length?1:0)-.08*(serviceEdges/Math.max(1,path.edges.length))));return {...path,rank:index+1,score:Number((relative*100).toFixed(2)),confidence:Number(confidence.toFixed(3)),explanation:{method:"osm-route-aware-v7",requiredWaypoints:context.waypoints||[],matchedRouteRelationEdges:relationEdges,serviceTrackEdges:serviceEdges,physicalDistanceKm:path.distanceKm,routingCost:path.routingCost}};});
}

export function shortestPhysicalPath(adjacency, from, to, { maximumHops=120, maximumDistanceKm=1500 } = {}) {
  const path=weightedPath(adjacency,from,to,{}, {maximumHops,maximumDistanceKm});return path?{nodes:path.nodes,distanceKm:path.distanceKm,hopCount:path.hopCount}:null;
}

export function composeRouteGeometry(path, edgeMap) {
  const coordinates=[];let quality=1;
  for(let index=1;index<path.nodes.length;index+=1){const from=path.nodes[index-1],to=path.nodes[index],edge=edgeMap.get(`${from}>${to}`);if(!edge)return null;let geometry;try{geometry=typeof edge.geometry_json==="string"?JSON.parse(edge.geometry_json):edge.geometry_json;}catch{return null;}if(geometry?.type!=="LineString"||!Array.isArray(geometry.coordinates)||geometry.coordinates.length<2)return null;const points=geometry.coordinates;if(coordinates.length&&coordinates.at(-1)[0]===points[0][0]&&coordinates.at(-1)[1]===points[0][1])coordinates.push(...points.slice(1));else coordinates.push(...points);quality=Math.min(quality,Number(edge.geometry_quality)||0);}
  return coordinates.length>1?{geometry:{type:"LineString",coordinates},geometryQuality:Number(quality.toFixed(3))}:null;
}

async function fetchTopology(env) {
  if(topologyCache)return topologyCache;
  if(!env.ASSETS?.fetch)return null;
  const response=await env.ASSETS.fetch(new Request("https://rail-reference.local/data/rail-reference/topology.json"));
  if(!response.ok)throw new Error(`rail topology HTTP ${response.status}`);const asset=await response.json();if(!asset?.versionId||!Array.isArray(asset.edges))throw new Error("invalid rail topology asset");
  topologyCache={versionId:asset.versionId,adjacency:buildTopology(asset.edges),routeRelations:Array.isArray(asset.routeRelations)?asset.routeRelations:[]};return topologyCache;
}

async function rowsForSources(env, sqlPrefix, versionId, sourceIds) {
  const result=[],unique=[...new Set(sourceIds)].filter(Boolean);
  for(let index=0;index<unique.length;index+=75){const ids=unique.slice(index,index+75),parameters=ids.map((_,offset)=>`?${offset+2}`).join(",");result.push(...rows(await env.DB.prepare(`${sqlPrefix} version_id=?1 AND from_station_id IN (${parameters})`).bind(versionId,...ids).all()));}
  return result;
}

async function batch(env, statements, size=50){for(let index=0;index<statements.length;index+=size)await env.DB.batch(statements.slice(index,index+size));}

export async function resolveRailRouteGeometries(env, pairs = [], now = new Date().toISOString(), { maximumNewRoutes=12, retryNoPathAfterMinutes=360 } = {}) {
  if(!pairs.length)return {versionId:null,routes:new Map(),routesByContext:new Map(),calculated:0};
  const topology=await fetchTopology(env);
  if(!topology)return {versionId:null,routes:new Map(),routesByContext:new Map(),calculated:0,error:"rail_topology_asset_unavailable"};
  const version=await env.DB.prepare("SELECT version_id FROM rail_graph_versions WHERE version_id=?1 AND imported_stations>=station_count AND imported_segments>=segment_count ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'superseded' THEN 1 ELSE 2 END,activated_at DESC LIMIT 1").bind(topology.versionId).first();
  if(!version?.version_id)return {versionId:topology.versionId,routes:new Map(),routesByContext:new Map(),calculated:0,error:"rail_graph_asset_not_imported"};
  const unique=[...new Map(pairs.filter((pair)=>pair?.from&&pair?.to&&pair.from!==pair.to).map((pair)=>[`${routeKey(pair)}:${contextHash(pair)}`,{...pair,contextHash:contextHash(pair)}])).values()];
  const requested=new Map(unique.map((pair)=>[`${routeKey(pair)}:${pair.contextHash}`,pair]));
  const cachedRows=await rowsForSources(env,"SELECT * FROM rail_route_cache WHERE",version.version_id,unique.map((pair)=>pair.from));
  const retryBefore=Date.parse(now)-Math.max(5,Number(retryNoPathAfterMinutes)||360)*60_000;
  const validCached=cachedRows.filter((row)=>requested.has(`${row.from_station_id}>${row.to_station_id}:${row.context_hash||"legacy"}`)&&!(row.status==="no_path"&&Date.parse(row.calculated_at||0)<retryBefore));
  const routes=new Map(validCached.map((row)=>[`${row.from_station_id}>${row.to_station_id}`,row]));
  const routesByContext=new Map(validCached.map((row)=>[`${row.from_station_id}>${row.to_station_id}:${row.context_hash||"legacy"}`,row]));
  const cachedContexts=new Set(validCached.map((row)=>`${row.from_station_id}>${row.to_station_id}:${row.context_hash||"legacy"}`));
  const missing=unique.filter((pair)=>!cachedContexts.has(`${routeKey(pair)}:${pair.contextHash}`)).slice(0,Math.max(0,maximumNewRoutes));if(!missing.length)return {versionId:version.version_id,routes,routesByContext,calculated:0};
  const paths=[];
  for(const pair of missing){const candidates=routeAwareCandidates(topology.adjacency,pair.from,pair.to,normalizedContext(pair),{maximumCandidates:3});paths.push({pair,candidates,path:candidates[0]||null});}
  const sourceNodes=[];for(const item of paths)for(const candidate of item.candidates)sourceNodes.push(...candidate.nodes.slice(0,-1));
  const edgeRows=sourceNodes.length?await rowsForSources(env,"SELECT from_station_id,to_station_id,geometry_json,distance_km,geometry_quality FROM rail_segment_geometries WHERE",version.version_id,sourceNodes):[];
  const edgeMap=new Map(edgeRows.map((edge)=>[`${edge.from_station_id}>${edge.to_station_id}`,edge])),statements=[];
  for(const {pair,path,candidates} of paths){const composed=path?composeRouteGeometry(path,edgeMap):null,alternatives=candidates.slice(1).map((candidate)=>{const alternative=composeRouteGeometry(candidate,edgeMap);return alternative?{rank:candidate.rank,score:candidate.score,confidence:candidate.confidence,path:candidate.nodes,geometry:alternative.geometry,distanceKm:candidate.distanceKm,explanation:candidate.explanation}:null;}).filter(Boolean),status=composed?"ready":"no_path",cacheId=`${version.version_id}:${pair.from}>${pair.to}:${pair.contextHash}`,row={cache_id:cacheId,version_id:version.version_id,from_station_id:pair.from,to_station_id:pair.to,path_json:path?JSON.stringify(path.nodes):null,geometry_json:composed?JSON.stringify(composed.geometry):null,distance_km:path?.distanceKm??null,hop_count:path?.hopCount||0,status,geometry_quality:composed?.geometryQuality||0,context_hash:pair.contextHash,routing_method:"osm-route-aware-v7",route_score:path?.score??null,route_confidence:path?.confidence??0,explanation_json:path?JSON.stringify(path.explanation):null,alternatives_json:JSON.stringify(alternatives),calculated_at:now,last_used_at:now,error:!path?"no physical path":!composed?"incomplete segment geometry":null};routes.set(routeKey(pair),row);routesByContext.set(`${routeKey(pair)}:${pair.contextHash}`,row);statements.push(env.DB.prepare(`INSERT INTO rail_route_cache(cache_id,version_id,from_station_id,to_station_id,path_json,geometry_json,distance_km,hop_count,status,geometry_quality,calculated_at,last_used_at,error,context_hash,routing_method,route_score,route_confidence,explanation_json,alternatives_json)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12,?13,?14,?15,?16,?17,?18) ON CONFLICT(cache_id) DO UPDATE SET path_json=excluded.path_json,geometry_json=excluded.geometry_json,distance_km=excluded.distance_km,hop_count=excluded.hop_count,status=excluded.status,geometry_quality=excluded.geometry_quality,last_used_at=excluded.last_used_at,error=excluded.error,route_score=excluded.route_score,route_confidence=excluded.route_confidence,explanation_json=excluded.explanation_json,alternatives_json=excluded.alternatives_json`).bind(cacheId,version.version_id,pair.from,pair.to,row.path_json,row.geometry_json,row.distance_km,row.hop_count,status,row.geometry_quality,now,row.error,row.context_hash,row.routing_method,row.route_score,row.route_confidence,row.explanation_json,row.alternatives_json));}
  await batch(env,statements);return {versionId:version.version_id,routes,routesByContext,calculated:statements.length};
}

export async function rebuildQueuedRailRoutes(env, now = new Date().toISOString(), maximumRoutes = 24) {
  const pending=rows(await env.DB.prepare("SELECT * FROM rail_route_rebuild_queue WHERE processed_at IS NULL ORDER BY priority DESC,queued_at LIMIT ?1").bind(Math.max(1,maximumRoutes)).all());
  if(!pending.length)return {processed:0,ready:0,failed:0,versionId:null};
  const resolution=await resolveRailRouteGeometries(env,pending.map((item)=>({from:item.from_station_id,to:item.to_station_id})),now,{maximumNewRoutes:maximumRoutes,retryNoPathAfterMinutes:5});
  const statements=[];let ready=0,failed=0;
  for(const item of pending){const route=resolution.routes.get(`${item.from_station_id}>${item.to_station_id}`),ok=route?.status==="ready";if(ok)ready+=1;else failed+=1;statements.push(env.DB.prepare("UPDATE rail_route_rebuild_queue SET processed_at=?1,result=?2,error=?3 WHERE queue_id=?4 AND processed_at IS NULL").bind(now,ok?"ready":"no_path",ok?null:route?.error||"route unresolved",item.queue_id));}
  await batch(env,statements);return {processed:pending.length,ready,failed,versionId:resolution.versionId};
}
