import { contextHash, resolveRailRouteGeometries } from "./rail-route-cache.js";

const rows=(result)=>result?.results||[];
const normalizeAlias=(value)=>String(value||"").normalize("NFKC").toLocaleLowerCase("uk-UA")
  .replace(/[’'`]/g,"ʼ")
  .replace(/\b(станція|станция|station|вокзал)\b/gu," ")
  .replace(/\b(залізнична|железнодорожная)\b/gu," ")
  .replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-+|-+$/g,"").replace(/-+/g,"-");
const aliasVariants=(value)=>{const key=normalizeAlias(value),variants=new Set(key?[key]:[]);if(!key)return variants;const short=key.replace(/-(пас|пасажирський|пасс|пассажирский|головний|главный)$/u,"");if(short.length>=3)variants.add(short);if(/-пас$/u.test(key))variants.add(key.replace(/-пас$/u,"-пасажирська"));variants.add(key.replace(/-(\d+)$/u,"$1"));return variants;};
const radians=(value)=>value*Math.PI/180;
const haversineKm=(left,right)=>{if(!left||!right)return 0;const dLat=radians(right.latitude-left.latitude),dLon=radians(right.longitude-left.longitude),lat1=radians(left.latitude),lat2=radians(right.latitude),a=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));};
const editDistance=(left,right)=>{const a=[...left],b=[...right],row=Array.from({length:b.length+1},(_,index)=>index);for(let i=1;i<=a.length;i+=1){let diagonal=row[0];row[0]=i;for(let j=1;j<=b.length;j+=1){const previous=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,diagonal+(a[i-1]===b[j-1]?0:1));diagonal=previous;}}return row[b.length];};
const stationNameMatch=(requested,official)=>{const left=normalizeAlias(requested),right=normalizeAlias(official);if(!left||!right)return false;if(left===right)return true;const passenger=(value)=>value.replace(/-(пас|пасажирська|пасажирський|пасс|пассажирская|пассажирский)$/u,"");if(passenger(left)===passenger(right))return true;return Math.min(left.length,right.length)>=5&&editDistance(left,right)<=1;};
const fuzzyPattern=(value)=>{const raw=String(value||"").trim().replace(/-(?:пас|пас\.|пасажирський|пасс|пасс\.|пассажирский)$/iu,"");const letters=[...raw];return letters.length>=5?`${letters[0]}%${letters.slice(-3).join("")}`:raw;};
const chunks=(items,size=75)=>Array.from({length:Math.ceil(items.length/size)},(_,index)=>items.slice(index*size,(index+1)*size));

async function selectIn(env,sqlPrefix,values){const result=[];for(const group of chunks([...new Set(values)].filter(Boolean))){if(!group.length)continue;const slots=group.map((_,index)=>`?${index+1}`).join(",");result.push(...rows(await env.DB.prepare(`${sqlPrefix} (${slots})`).bind(...group).all()));}return result;}
async function canonicalItineraries(env,runIds){try{const found=await selectIn(env,"SELECT i.run_id,i.itinerary_hash,i.status itinerary_status,i.confidence itinerary_confidence,i.source itinerary_source,s.sequence_no,s.station_id,s.station_name,s.call_type,s.mandatory,s.scheduled_arrival,s.scheduled_departure FROM run_itineraries i JOIN run_itinerary_stops s ON s.itinerary_id=i.itinerary_id WHERE i.run_id IN",runIds),grouped=new Map();for(const row of found){const itinerary=grouped.get(row.run_id)||{hash:row.itinerary_hash,status:row.itinerary_status,confidence:Number(row.itinerary_confidence)||0,source:row.itinerary_source,stops:[]};itinerary.stops.push(row);grouped.set(row.run_id,itinerary);}for(const itinerary of grouped.values())itinerary.stops.sort((left,right)=>Number(left.sequence_no)-Number(right.sequence_no));return grouped;}catch{return new Map();}}
async function resolveAliases(env,names){
  const variants=new Map(names.map((name)=>[name,[...aliasVariants(name)]])),keys=[...variants.values()].flat(),matches=await selectIn(env,"SELECT alias_key,station_id,confidence FROM station_aliases WHERE alias_key IN",keys),byKey=new Map(matches.sort((a,b)=>Number(b.confidence)-Number(a.confidence)).map((item)=>[item.alias_key,item.station_id])),resolved=new Map();
  for(const [name,keysForName] of variants){const stationId=keysForName.map((key)=>byKey.get(key)).find(Boolean);if(stationId)resolved.set(name,stationId);}
  const unresolved=names.filter((name)=>!resolved.has(name)),fuzzy=[];
  for(const group of chunks(unresolved.map(fuzzyPattern).filter(Boolean),50)){const conditions=group.map((_,index)=>`official_name LIKE ?${index+1}`).join(" OR ");fuzzy.push(...rows(await env.DB.prepare(`SELECT station_id,official_name,latitude,longitude FROM station_registry WHERE ${conditions}`).bind(...group).all()));}
  const candidates=new Map();for(const name of unresolved){const found=fuzzy.filter((item)=>stationNameMatch(name,item.official_name));if(found.length)candidates.set(name,found);}
  const resolvedRows=await selectIn(env,"SELECT station_id,official_name,latitude,longitude FROM station_registry WHERE station_id IN",[...resolved.values()]),locations=new Map([...resolvedRows,...fuzzy].map((item)=>[item.station_id,item]));
  return {resolved,candidates,locations};
}
function resolveStationSequence(names,resolution){
  const ids=names.map((name)=>resolution.resolved.get(name)||null);
  for(let index=0;index<names.length;index+=1){if(ids[index])continue;const candidates=resolution.candidates.get(names[index])||[];if(!candidates.length)continue;if(candidates.length===1){ids[index]=candidates[0].station_id;continue;}let left=null,right=null;for(let cursor=index-1;cursor>=0&&!left;cursor-=1)left=resolution.locations.get(ids[cursor]);for(let cursor=index+1;cursor<ids.length&&!right;cursor+=1)right=resolution.locations.get(ids[cursor]);if(!left&&!right)continue;ids[index]=[...candidates].sort((a,b)=>(haversineKm(left,a)+haversineKm(a,right))-(haversineKm(left,b)+haversineKm(b,right)))[0].station_id;}
  return ids;
}
function parseMetadata(value){try{return JSON.parse(value||"{}");}catch{return {};}}
function parseGeometry(value){try{const geometry=typeof value==="string"?JSON.parse(value):value;return geometry?.type==="LineString"&&Array.isArray(geometry.coordinates)&&geometry.coordinates.length>1?geometry:null;}catch{return null;}}
function categoryFor(trainNumber){return /^(?:[89]\d{3}|\d{4,5})$/.test(String(trainNumber||""))?"suburban":"passenger";}

const sameStation=(left,right)=>Boolean(left&&right&&normalizeAlias(left)===normalizeAlias(right));
const trainNumberParts=(value)=>new Set(String(value||"").replace(/^№\s*/,"").split("/").map((part)=>part.replace(/^0+(?=\d)/,"").trim()).filter(Boolean));
const sameTrainNumber=(left,right)=>{const first=trainNumberParts(left),second=trainNumberParts(right);return [...first].some((part)=>second.has(part));};
const trainNumberQueryVariants=(value)=>{const raw=String(value||"").replace(/^№\s*/,"").trim(),result=new Set(raw?[raw]:[]);for(const part of trainNumberParts(raw)){result.add(part);result.add(part.padStart(3,"0"));result.add(part.padStart(4,"0"));}return [...result];};
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
  const metadata=parseMetadata(schedule.metadata_json),departure=Date.parse(schedule.scheduled_departure||0),callTime=(call)=>{let value=Date.parse(call?.scheduledAt||0);if(Number.isFinite(departure)&&Number.isFinite(value))while(value<departure-60*60_000)value+=24*60*60_000;return Number.isFinite(value)?value:Infinity;},calls=orderedUniqueStations((Array.isArray(metadata.stationCalls)?metadata.stationCalls:[]).filter((call)=>call?.station).sort((left,right)=>callTime(left)-callTime(right))),listed=orderedUniqueStations(Array.isArray(metadata.orderedStations)?metadata.orderedStations:Array.isArray(metadata.routeStations)?metadata.routeStations:Array.isArray(metadata.stations)?metadata.stations:[]),persisted=orderedUniqueStations(schedule.canonicalItinerary?.stops?.map((stop)=>stop.station_name)||[]),candidates=[];
  for(const [source,raw] of [["canonical_itinerary_v1",persisted],["station_calls",calls],["ordered_schedule",listed]]){
    if(!raw.length)continue;let sequence=raw,fromIndex=sequence.findIndex((station)=>sameStation(station,request.origin)),toIndex=sequence.findIndex((station)=>sameStation(station,request.destination));
    if(fromIndex>=0&&toIndex>=0&&fromIndex!==toIndex)sequence=fromIndex<toIndex?sequence.slice(fromIndex,toIndex+1):sequence.slice(toIndex,fromIndex+1).reverse();
    else if(source==="station_calls")sequence=orderedUniqueStations([request.origin,...sequence.filter((station)=>!sameStation(station,request.origin)&&!sameStation(station,request.destination)),request.destination]);
    else continue;
    if(!sameStation(sequence[0],request.origin)||!sameStation(sequence.at(-1),request.destination))continue;
    const intermediateStations=sequence.slice(1,-1);if(intermediateStations.length>=1)candidates.push({source,stations:sequence,intermediateStations,itineraryHash:source==="canonical_itinerary_v1"?schedule.canonicalItinerary?.hash:null});
  }
  const best=candidates.sort((left,right)=>right.intermediateStations.length-left.intermediateStations.length)[0];
  return best?{status:best.intermediateStations.length>=2?"verified":"constrained",reason:"dated_directional_itinerary",serviceDate:schedule.service_date,runId:schedule.run_id,...best}:{status:"unverified",reason:"insufficient_ordered_waypoints",serviceDate:schedule.service_date,runId:schedule.run_id,stations:[],intermediateStations:[]};
}

export async function resolvePublicRailRoutes(env,input=[],now=new Date().toISOString()){
  const requests=(Array.isArray(input)?input:[]).slice(0,60).map((item,index)=>({key:String(item?.key||index).slice(0,180),trainNumber:String(item?.trainNumber||"").replace(/^№\s*/,"").slice(0,24),origin:String(item?.origin||"").trim().slice(0,120),destination:String(item?.destination||"").trim().slice(0,120),reportedStation:String(item?.reportedStation||"").trim().slice(0,120)})).filter((item)=>item.origin&&item.destination&&item.origin!==item.destination);
  for(const [index,request] of requests.entries()){const items=Array.isArray(input)?input:[],source=items.find((item)=>String(item?.key||"")===request.key)||items[index];request.serviceDate=/^\d{4}-\d{2}-\d{2}$/.test(String(source?.serviceDate||""))?String(source.serviceDate):null;request.runId=String(source?.runId||"").slice(0,220)||null;}
  if(!requests.length)return {generatedAt:now,versionId:null,routes:[],calculated:0};
  const requestedNumbers=[...new Set(requests.flatMap((item)=>trainNumberQueryVariants(item.trainNumber)))],schedules=await selectIn(env,"SELECT run_id,service_date,train_number,origin,destination,scheduled_departure,metadata_json,updated_at FROM expected_train_runs WHERE train_number IN",requestedNumbers),itineraries=await canonicalItineraries(env,schedules.map((item)=>item.run_id));for(const schedule of schedules)schedule.canonicalItinerary=itineraries.get(schedule.run_id)||null;
  const stationNames=new Set();for(const request of requests){request.verification=verifiedItinerary(request,scheduleForRequest(request,schedules));stationNames.add(request.origin);stationNames.add(request.destination);if(request.reportedStation)stationNames.add(request.reportedStation);for(const station of request.verification.stations)stationNames.add(station);}
  const aliasResolution=await resolveAliases(env,[...stationNames].filter(Boolean)),pairs=[];
  for(const request of requests){if(!["verified","constrained"].includes(request.verification.status)){request.unresolved=request.verification.reason;continue;}const resolvedSequence=resolveStationSequence(request.verification.stations,aliasResolution),from=resolvedSequence[0],to=resolvedSequence.at(-1);if(!from||!to||from===to){request.unresolved="station_alias_not_found";continue;}const resolvedWaypoints=resolvedSequence.slice(1,-1);if(resolvedWaypoints.some((station)=>!station)){request.unresolved="itinerary_alias_not_found";continue;}request.pair={from,to,waypoints:[...new Set(resolvedWaypoints.filter((station)=>station!==from&&station!==to))].slice(0,48),trainCategory:categoryFor(request.trainNumber),itineraryHash:request.verification.itineraryHash||null,serviceDate:request.serviceDate,direction:`${from}>${to}`};if(!request.pair.waypoints.length){request.unresolved="insufficient_resolved_waypoints";continue;}pairs.push(request.pair);}
  const resolution=await resolveRailRouteGeometries(env,pairs,now,{maximumNewRoutes:Math.min(6,pairs.length),retryNoPathAfterMinutes:30});
  const routes=requests.map((request)=>{const verification={status:request.verification.status,reason:request.unresolved||request.verification.reason,serviceDate:request.verification.serviceDate||request.serviceDate||null,waypointCount:request.verification.intermediateStations.length,source:request.verification.source||null,itineraryHash:request.verification.itineraryHash||null};if(!request.pair)return {key:request.key,status:"unavailable",reason:request.unresolved,verification};const context=contextHash(request.pair),row=resolution.routesByContext?.get(`${request.pair.from}>${request.pair.to}:${context}`)||resolution.routes.get(`${request.pair.from}>${request.pair.to}`),geometry=parseGeometry(row?.geometry_json);if(row?.status!=="ready"||!geometry)return {key:request.key,status:"unavailable",reason:row?.error||"route_not_ready",verification};return {key:request.key,status:"ready",versionId:row.version_id,geometry,totalKm:Number(row.distance_km)||null,quality:Number(row.geometry_quality)||0,confidence:Number(row.route_confidence)||0,method:row.routing_method||"itinerary-constrained-v1",calculatedAt:row.calculated_at||now,verification:{...verification,reason:"mandatory_waypoints_matched"}};});
  return {generatedAt:now,versionId:resolution.versionId,routes,calculated:resolution.calculated};
}
