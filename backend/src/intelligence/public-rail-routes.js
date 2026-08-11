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

const sameStation=(left,right)=>Boolean(left&&right&&normalizeAlias(left)===normalizeAlias(right));
const trainNumberParts=(value)=>new Set(String(value||"").replace(/^№\s*/,"").split("/").map((part)=>part.replace(/^0+(?=\d)/,"").trim()).filter(Boolean));
const sameTrainNumber=(left,right)=>{const first=trainNumberParts(left),second=trainNumberParts(right);return [...first].some((part)=>second.has(part));};
function orderedUniqueStations(values=[]){const seen=new Set(),result=[];for(const value of values){const station=typeof value==="string"?value:value?.station,key=normalizeAlias(station);if(key&&!seen.has(key)){seen.add(key);result.push(station);}}return result;}
export function scheduleForRequest(request,schedules=[]){
  let candidates=schedules.filter((row)=>sameTrainNumber(row.train_number,request.trainNumber));
  if(request.runId){const exact=candidates.filter((row)=>row.run_id===request.runId);if(exact.length)candidates=exact;}
  if(request.serviceDate){const exactDate=candidates.filter((row)=>row.service_date===request.serviceDate);if(!exactDate.length)return null;candidates=exactDate;}
  const exactDirection=candidates.filter((row)=>sameStation(row.origin,request.origin)&&sameStation(row.destination,request.destination));if(!exactDirection.length)return null;candidates=exactDirection;
  return candidates.sort((left,right)=>Date.parse(right.updated_at||0)-Date.parse(left.updated_at||0))[0]||null;
}
export function verifiedItinerary(request,schedule){
  if(!schedule)return {status:"unverified",reason:"dated_schedule_not_found",stations:[],intermediateStations:[]};
  const metadata=parseMetadata(schedule.metadata_json),departure=Date.parse(schedule.scheduled_departure||0),callTime=(call)=>{let value=Date.parse(call?.scheduledAt||0);if(Number.isFinite(departure)&&Number.isFinite(value))while(value<departure-60*60_000)value+=24*60*60_000;return Number.isFinite(value)?value:Infinity;},calls=orderedUniqueStations((Array.isArray(metadata.stationCalls)?metadata.stationCalls:[]).filter((call)=>call?.station).sort((left,right)=>callTime(left)-callTime(right))),listed=orderedUniqueStations(Array.isArray(metadata.stations)?metadata.stations:[]),candidates=[];
  for(const [source,raw] of [["station_calls",calls],["ordered_schedule",listed]]){
    if(!raw.length)continue;let sequence=raw,fromIndex=sequence.findIndex((station)=>sameStation(station,request.origin)),toIndex=sequence.findIndex((station)=>sameStation(station,request.destination));
    if(fromIndex>=0&&toIndex>=0&&fromIndex!==toIndex)sequence=fromIndex<toIndex?sequence.slice(fromIndex,toIndex+1):sequence.slice(toIndex,fromIndex+1).reverse();
    else if(source==="station_calls")sequence=orderedUniqueStations([request.origin,...sequence.filter((station)=>!sameStation(station,request.origin)&&!sameStation(station,request.destination)),request.destination]);
    else continue;
    if(!sameStation(sequence[0],request.origin)||!sameStation(sequence.at(-1),request.destination))continue;
    const intermediateStations=sequence.slice(1,-1);if(intermediateStations.length>=2)candidates.push({source,stations:sequence,intermediateStations});
  }
  const best=candidates.sort((left,right)=>right.intermediateStations.length-left.intermediateStations.length)[0];
  return best?{status:"verified",reason:"dated_directional_itinerary",serviceDate:schedule.service_date,runId:schedule.run_id,...best}:{status:"unverified",reason:"insufficient_ordered_waypoints",serviceDate:schedule.service_date,runId:schedule.run_id,stations:[],intermediateStations:[]};
}

export async function resolvePublicRailRoutes(env,input=[],now=new Date().toISOString()){
  const requests=(Array.isArray(input)?input:[]).slice(0,60).map((item,index)=>({key:String(item?.key||index).slice(0,180),trainNumber:String(item?.trainNumber||"").replace(/^№\s*/,"").slice(0,24),origin:String(item?.origin||"").trim().slice(0,120),destination:String(item?.destination||"").trim().slice(0,120),reportedStation:String(item?.reportedStation||"").trim().slice(0,120)})).filter((item)=>item.origin&&item.destination&&item.origin!==item.destination);
  for(const [index,request] of requests.entries()){const items=Array.isArray(input)?input:[],source=items.find((item)=>String(item?.key||"")===request.key)||items[index];request.serviceDate=/^\d{4}-\d{2}-\d{2}$/.test(String(source?.serviceDate||""))?String(source.serviceDate):null;request.runId=String(source?.runId||"").slice(0,220)||null;}
  if(!requests.length)return {generatedAt:now,versionId:null,routes:[],calculated:0};
  const schedules=await selectIn(env,"SELECT run_id,service_date,train_number,origin,destination,scheduled_departure,metadata_json,updated_at FROM expected_train_runs WHERE train_number IN",requests.map((item)=>item.trainNumber));
  const stationNames=new Set();for(const request of requests){request.verification=verifiedItinerary(request,scheduleForRequest(request,schedules));stationNames.add(request.origin);stationNames.add(request.destination);if(request.reportedStation)stationNames.add(request.reportedStation);for(const station of request.verification.stations)stationNames.add(station);}
  const aliases=await resolveAliases(env,[...stationNames].filter(Boolean)),pairs=[];
  for(const request of requests){if(request.verification.status!=="verified"){request.unresolved=request.verification.reason;continue;}const from=aliases.get(request.origin),to=aliases.get(request.destination);if(!from||!to||from===to){request.unresolved="station_alias_not_found";continue;}const resolvedWaypoints=request.verification.intermediateStations.map((station)=>aliases.get(station));if(resolvedWaypoints.some((station)=>!station)){request.unresolved="itinerary_alias_not_found";continue;}request.pair={from,to,waypoints:[...new Set(resolvedWaypoints.filter((station)=>station!==from&&station!==to))].slice(0,32),trainCategory:categoryFor(request.trainNumber)};if(request.pair.waypoints.length<2){request.unresolved="insufficient_resolved_waypoints";continue;}pairs.push(request.pair);}
  const resolution=await resolveRailRouteGeometries(env,pairs,now,{maximumNewRoutes:Math.min(24,pairs.length),retryNoPathAfterMinutes:30});
  const routes=requests.map((request)=>{const verification={status:request.verification.status,reason:request.unresolved||request.verification.reason,serviceDate:request.verification.serviceDate||request.serviceDate||null,waypointCount:request.verification.intermediateStations.length,source:request.verification.source||null};if(!request.pair)return {key:request.key,status:"unavailable",reason:request.unresolved,verification};const context=contextHash(request.pair),row=resolution.routesByContext?.get(`${request.pair.from}>${request.pair.to}:${context}`)||resolution.routes.get(`${request.pair.from}>${request.pair.to}`),geometry=parseGeometry(row?.geometry_json);if(row?.status!=="ready"||!geometry)return {key:request.key,status:"unavailable",reason:row?.error||"route_not_ready",verification};return {key:request.key,status:"ready",versionId:row.version_id,geometry,totalKm:Number(row.distance_km)||null,quality:Number(row.geometry_quality)||0,confidence:Number(row.route_confidence)||0,method:row.routing_method||"osm-route-aware-v7",calculatedAt:row.calculated_at||now,verification:{...verification,status:"verified",reason:"mandatory_waypoints_matched"}};});
  return {generatedAt:now,versionId:resolution.versionId,routes,calculated:resolution.calculated};
}
