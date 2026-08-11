import { contextHash, resolveRailRouteGeometries } from "./rail-route-cache.js";

const rows=(result)=>result?.results||[];
const normalizeAlias=(value)=>String(value||"").normalize("NFKC").toLocaleLowerCase("uk-UA")
  .replace(/[’'`]/g,"ʼ")
  .replace(/\b(станція|станция|station|вокзал)\b/gu," ")
  .replace(/\b(залізнична|железнодорожная)\b/gu," ")
  .replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-+|-+$/g,"").replace(/-+/g,"-");
const aliasVariants=(value)=>{const key=normalizeAlias(value),variants=new Set(key?[key]:[]);if(!key)return variants;const short=key.replace(/-(пас|пасажирський|пасс|пассажирский|головний|главный)$/u,"");if(short.length>=3)variants.add(short);variants.add(key.replace(/-(\d+)$/u,"$1"));return variants;};
const chunks=(items,size=75)=>Array.from({length:Math.ceil(items.length/size)},(_,index)=>items.slice(index*size,(index+1)*size));

async function selectIn(env,sqlPrefix,values){const result=[];for(const group of chunks([...new Set(values)].filter(Boolean))){if(!group.length)continue;const slots=group.map((_,index)=>`?${index+1}`).join(",");result.push(...rows(await env.DB.prepare(`${sqlPrefix} (${slots})`).bind(...group).all()));}return result;}
async function resolveAliases(env,names){const variants=new Map(names.map((name)=>[name,[...aliasVariants(name)]])),keys=[...variants.values()].flat();const matches=await selectIn(env,"SELECT alias_key,station_id,confidence FROM station_aliases WHERE alias_key IN",keys),byKey=new Map(matches.sort((a,b)=>Number(b.confidence)-Number(a.confidence)).map((item)=>[item.alias_key,item.station_id])),resolved=new Map();for(const [name,candidates] of variants){const stationId=candidates.map((key)=>byKey.get(key)).find(Boolean);if(stationId)resolved.set(name,stationId);}return resolved;}
function parseMetadata(value){try{return JSON.parse(value||"{}");}catch{return {};}}
function parseGeometry(value){try{const geometry=typeof value==="string"?JSON.parse(value):value;return geometry?.type==="LineString"&&Array.isArray(geometry.coordinates)&&geometry.coordinates.length>1?geometry:null;}catch{return null;}}
function categoryFor(trainNumber){return /^(?:[89]\d{3}|\d{4,5})$/.test(String(trainNumber||""))?"suburban":"passenger";}

export async function resolvePublicRailRoutes(env,input=[],now=new Date().toISOString()){
  const requests=(Array.isArray(input)?input:[]).slice(0,60).map((item,index)=>({key:String(item?.key||index).slice(0,180),trainNumber:String(item?.trainNumber||"").replace(/^№\s*/,"").slice(0,24),origin:String(item?.origin||"").trim().slice(0,120),destination:String(item?.destination||"").trim().slice(0,120),reportedStation:String(item?.reportedStation||"").trim().slice(0,120)})).filter((item)=>item.origin&&item.destination&&item.origin!==item.destination);
  if(!requests.length)return {generatedAt:now,versionId:null,routes:[],calculated:0};
  const schedules=await selectIn(env,"SELECT train_number,metadata_json,updated_at FROM expected_train_runs WHERE train_number IN",requests.map((item)=>item.trainNumber));
  const latestSchedule=new Map();for(const row of schedules.sort((a,b)=>Date.parse(b.updated_at||0)-Date.parse(a.updated_at||0)))if(!latestSchedule.has(String(row.train_number)))latestSchedule.set(String(row.train_number),parseMetadata(row.metadata_json));
  const stationNames=new Set();for(const request of requests){stationNames.add(request.origin);stationNames.add(request.destination);if(request.reportedStation)stationNames.add(request.reportedStation);for(const station of latestSchedule.get(request.trainNumber)?.stations||[])stationNames.add(typeof station==="string"?station:station?.station);}
  const aliases=await resolveAliases(env,[...stationNames].filter(Boolean)),pairs=[];
  for(const request of requests){const from=aliases.get(request.origin),to=aliases.get(request.destination);if(!from||!to||from===to){request.unresolved="station_alias_not_found";continue;}const schedule=(latestSchedule.get(request.trainNumber)?.stations||[]).map((station)=>aliases.get(typeof station==="string"?station:station?.station)).filter(Boolean);let waypoints=[];const fromIndex=schedule.indexOf(from),toIndex=schedule.lastIndexOf(to);if(fromIndex>=0&&toIndex>fromIndex)waypoints=schedule.slice(fromIndex+1,toIndex);else if(toIndex>=0&&fromIndex>toIndex)waypoints=schedule.slice(toIndex+1,fromIndex).reverse();const reported=aliases.get(request.reportedStation);if(!waypoints.length&&reported&&reported!==from&&reported!==to)waypoints=[reported];request.pair={from,to,waypoints:[...new Set(waypoints)].slice(0,24),trainCategory:categoryFor(request.trainNumber)};pairs.push(request.pair);}
  const resolution=await resolveRailRouteGeometries(env,pairs,now,{maximumNewRoutes:Math.min(24,pairs.length),retryNoPathAfterMinutes:30});
  const routes=requests.map((request)=>{if(!request.pair)return {key:request.key,status:"unavailable",reason:request.unresolved};const context=contextHash(request.pair),row=resolution.routesByContext?.get(`${request.pair.from}>${request.pair.to}:${context}`)||resolution.routes.get(`${request.pair.from}>${request.pair.to}`),geometry=parseGeometry(row?.geometry_json);if(row?.status!=="ready"||!geometry)return {key:request.key,status:"unavailable",reason:row?.error||"route_not_ready"};return {key:request.key,status:"ready",versionId:row.version_id,geometry,totalKm:Number(row.distance_km)||null,quality:Number(row.geometry_quality)||0,confidence:Number(row.route_confidence)||0,method:row.routing_method||"osm-route-aware-v7",calculatedAt:row.calculated_at||now};});
  return {generatedAt:now,versionId:resolution.versionId,routes,calculated:resolution.calculated};
}
