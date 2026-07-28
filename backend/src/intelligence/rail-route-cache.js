const rows = (result) => result?.results || [];
let topologyCache = null;

class MinHeap {
  constructor(){this.values=[];}
  push(item){this.values.push(item);let index=this.values.length-1;while(index>0){const parent=(index-1)>>1;if(this.values[parent].distance<=item.distance)break;this.values[index]=this.values[parent];index=parent;}this.values[index]=item;}
  pop(){if(!this.values.length)return null;const first=this.values[0],last=this.values.pop();if(this.values.length){let index=0;while(true){let child=index*2+1;if(child>=this.values.length)break;if(child+1<this.values.length&&this.values[child+1].distance<this.values[child].distance)child+=1;if(this.values[child].distance>=last.distance)break;this.values[index]=this.values[child];index=child;}this.values[index]=last;}return first;}
}

export function buildTopology(edges = []) {
  const adjacency=new Map();
  for(const [from,to,distanceValue] of edges){const distance=Number(distanceValue);if(!from||!to||!(distance>0))continue;for(const [left,right] of [[from,to],[to,from]]){const list=adjacency.get(left)||[];list.push({to:right,distance});adjacency.set(left,list);}}
  return adjacency;
}

export function shortestPhysicalPath(adjacency, from, to, { maximumHops=120, maximumDistanceKm=1500 } = {}) {
  if(!from||!to||from===to)return null;
  const distances=new Map([[from,0]]),hops=new Map([[from,0]]),previous=new Map(),queue=new MinHeap();queue.push({node:from,distance:0});
  while(queue.values.length){const current=queue.pop();if(current.distance!==distances.get(current.node))continue;if(current.node===to)break;const currentHops=hops.get(current.node)||0;if(currentHops>=maximumHops)continue;for(const edge of adjacency.get(current.node)||[]){const distance=current.distance+edge.distance;if(distance>maximumDistanceKm||distance>=Number(distances.get(edge.to)??Infinity))continue;distances.set(edge.to,distance);hops.set(edge.to,currentHops+1);previous.set(edge.to,current.node);queue.push({node:edge.to,distance});}}
  if(!distances.has(to))return null;const nodes=[to];while(nodes[0]!==from){const node=previous.get(nodes[0]);if(!node)return null;nodes.unshift(node);if(nodes.length>maximumHops+1)return null;}
  return {nodes,distanceKm:Number(distances.get(to).toFixed(3)),hopCount:nodes.length-1};
}

export function composeRouteGeometry(path, edgeMap) {
  const coordinates=[];let quality=1;
  for(let index=1;index<path.nodes.length;index+=1){const from=path.nodes[index-1],to=path.nodes[index],edge=edgeMap.get(`${from}>${to}`);if(!edge)return null;let geometry;try{geometry=typeof edge.geometry_json==="string"?JSON.parse(edge.geometry_json):edge.geometry_json;}catch{return null;}if(geometry?.type!=="LineString"||!Array.isArray(geometry.coordinates)||geometry.coordinates.length<2)return null;const points=geometry.coordinates;if(coordinates.length&&coordinates.at(-1)[0]===points[0][0]&&coordinates.at(-1)[1]===points[0][1])coordinates.push(...points.slice(1));else coordinates.push(...points);quality=Math.min(quality,Number(edge.geometry_quality)||0);}
  return coordinates.length>1?{geometry:{type:"LineString",coordinates},geometryQuality:Number(quality.toFixed(3))}:null;
}

async function fetchTopology(env, versionId) {
  if(topologyCache?.versionId===versionId)return topologyCache;
  if(!env.ASSETS?.fetch)throw new Error("rail topology asset binding unavailable");
  const response=await env.ASSETS.fetch(new Request("https://rail-reference.local/data/rail-reference/topology.json"));
  if(!response.ok)throw new Error(`rail topology HTTP ${response.status}`);const asset=await response.json();if(asset?.versionId!==versionId||!Array.isArray(asset.edges))throw new Error("rail topology version mismatch");
  topologyCache={versionId,adjacency:buildTopology(asset.edges)};return topologyCache;
}

async function rowsForSources(env, sqlPrefix, versionId, sourceIds) {
  const result=[],unique=[...new Set(sourceIds)].filter(Boolean);
  for(let index=0;index<unique.length;index+=75){const ids=unique.slice(index,index+75),parameters=ids.map((_,offset)=>`?${offset+2}`).join(",");result.push(...rows(await env.DB.prepare(`${sqlPrefix} version_id=?1 AND from_station_id IN (${parameters})`).bind(versionId,...ids).all()));}
  return result;
}

async function batch(env, statements, size=50){for(let index=0;index<statements.length;index+=size)await env.DB.batch(statements.slice(index,index+size));}

export async function resolveRailRouteGeometries(env, pairs = [], now = new Date().toISOString(), { maximumNewRoutes=12 } = {}) {
  const version=await env.DB.prepare("SELECT version_id FROM rail_graph_versions WHERE status='active' ORDER BY activated_at DESC LIMIT 1").first();
  if(!version?.version_id||!pairs.length)return {versionId:version?.version_id||null,routes:new Map(),calculated:0};
  const unique=[...new Map(pairs.filter((pair)=>pair?.from&&pair?.to&&pair.from!==pair.to).map((pair)=>[`${pair.from}>${pair.to}`,pair])).values()];
  const requested=new Set(unique.map((pair)=>`${pair.from}>${pair.to}`));
  const cachedRows=await rowsForSources(env,"SELECT * FROM rail_route_cache WHERE",version.version_id,unique.map((pair)=>pair.from));
  const routes=new Map(cachedRows.filter((row)=>requested.has(`${row.from_station_id}>${row.to_station_id}`)).map((row)=>[`${row.from_station_id}>${row.to_station_id}`,row]));
  const missing=unique.filter((pair)=>!routes.has(`${pair.from}>${pair.to}`)).slice(0,Math.max(0,maximumNewRoutes));if(!missing.length)return {versionId:version.version_id,routes,calculated:0};
  const topology=await fetchTopology(env,version.version_id),paths=[];
  for(const pair of missing)paths.push({pair,path:shortestPhysicalPath(topology.adjacency,pair.from,pair.to)});
  const sourceNodes=[];for(const item of paths)if(item.path)sourceNodes.push(...item.path.nodes.slice(0,-1));
  const edgeRows=sourceNodes.length?await rowsForSources(env,"SELECT from_station_id,to_station_id,geometry_json,distance_km,geometry_quality FROM rail_segment_geometries WHERE active=1 AND",version.version_id,sourceNodes):[];
  const edgeMap=new Map(edgeRows.map((edge)=>[`${edge.from_station_id}>${edge.to_station_id}`,edge])),statements=[];
  for(const {pair,path} of paths){const composed=path?composeRouteGeometry(path,edgeMap):null,status=composed?"ready":"no_path",cacheId=`${version.version_id}:${pair.from}>${pair.to}`,row={cache_id:cacheId,version_id:version.version_id,from_station_id:pair.from,to_station_id:pair.to,path_json:path?JSON.stringify(path.nodes):null,geometry_json:composed?JSON.stringify(composed.geometry):null,distance_km:path?.distanceKm??null,hop_count:path?.hopCount||0,status,geometry_quality:composed?.geometryQuality||0,calculated_at:now,last_used_at:now,error:!path?"no physical path":!composed?"incomplete segment geometry":null};routes.set(`${pair.from}>${pair.to}`,row);statements.push(env.DB.prepare(`INSERT INTO rail_route_cache(cache_id,version_id,from_station_id,to_station_id,path_json,geometry_json,distance_km,hop_count,status,geometry_quality,calculated_at,last_used_at,error)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12) ON CONFLICT(cache_id) DO UPDATE SET path_json=excluded.path_json,geometry_json=excluded.geometry_json,distance_km=excluded.distance_km,hop_count=excluded.hop_count,status=excluded.status,geometry_quality=excluded.geometry_quality,last_used_at=excluded.last_used_at,error=excluded.error`).bind(cacheId,version.version_id,pair.from,pair.to,row.path_json,row.geometry_json,row.distance_km,row.hop_count,status,row.geometry_quality,now,row.error));}
  await batch(env,statements);return {versionId:version.version_id,routes,calculated:statements.length};
}
