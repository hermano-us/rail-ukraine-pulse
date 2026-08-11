import { buildRouteMeasure, haversineKm, interpolateAlongRoute, projectDistanceOnRoute } from "./positioning.js";
import { estimatePosterior } from "../shared/rail-posterior.js";
import { buildGeometricWaypoints, buildOfficialEvents, buildUncertaintyCorridor, hydrateSourceRegistry, sourceRegistrySummary } from "./evidence-engine.js";
import { evaluateFreshness, freshnessConfidenceFactor, freshnessReasons, sourceAgeMinutes as ageOf } from "./freshness-policy.js";
import { loadFreightSnapshot, loadLiveSnapshot, loadPublicRailRoutes } from "./live-data-client.js?v=20260809-osm-public-routes";
import { canonicalServiceKey, fuseServiceUpdates, groupStationQueues, positionAdmission, stationQueueForUpdate } from "./service-registry.js";
import { materializePublicFreight } from "./freight-public-layer.js?v=20260808-freight-v2";

async function readJson(url, optional = false) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    if (optional && response.status === 404) return null;
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

const STATIONS = {
  "київ-пас":[30.484,50.4406], "київ":[30.484,50.4406], "львів":[23.9948,49.839],
  "дніпро-головний":[35.0462,48.4775], "дніпро":[35.0462,48.4775],
  "харків-пас":[36.205,49.989], "харків":[36.205,49.989],
  "одеса-головна":[30.7107,46.4673], "одеса":[30.7107,46.4673],
  "ужгород":[22.299,48.6216], "запоріжжя-1":[35.1668,47.8127],
  "івано-франківськ":[24.7111,48.9226], "суми":[34.7982,50.9102],
  "миколаїв пас":[31.9944,46.9755], "миколаїв":[31.9944,46.9755],
  "хмельницький":[26.9965,49.4229], "чернівці":[25.9403,48.2668],
  "чернігів":[31.2794,51.4982], "лозова-пас":[36.2744,48.8894],
  "трускавець":[23.505,49.2786], "солотвино-1":[23.8707,47.956],
  "конотоп-пас":[33.205,51.241], "жмеринка-пас":[28.11,49.039],
  "рахів":[24.204,48.052], "вінниця":[28.481,49.234], "вінниця пас":[28.481,49.234],
  "луцьк":[25.3227,50.7472], "рівне":[26.2516,50.6199], "житомир":[28.6587,50.2649],
  "кропивницький":[32.2676,48.5079], "полтава-київська":[34.526,49.599],
  "тернопіль":[25.599,49.5535], "черкаси":[32.062,49.444], "херсон":[32.612,46.648],
  "пшемисль головний":[22.767,49.784], "хелм":[23.472,51.132],
  "бухарест-норд":[26.074,44.447], "відень західний":[16.337,48.197],
  "будапешт-келеті":[19.083,47.5],
};

export function normalizePlace(value = "") {
  return String(value ?? "").toLocaleLowerCase("uk").replace(/[.№]/g, "").replace(/\s+/g, " ").trim();
}
function stationKey(value) { return normalizePlace(value).replace(/пасажирський|пасажирська|пассажирский|пассажирская|пас/g,"пас").replace(/головний|головна|главный|главная/g,"голов").replace(/[^\p{L}\p{N}]+/gu,""); }
function buildStationLookup(stations=[]) {
  const lookup=new Map();
  for(const [name,coordinates] of Object.entries(STATIONS))lookup.set(stationKey(name),coordinates);
  for(const station of stations)if(station?.coordinates){
    lookup.set(stationKey(station.name),station.coordinates);
    for(const alias of station.aliases||[])lookup.set(stationKey(alias),station.coordinates);
  }
  return lookup;
}
function stationCoordinates(value,lookup) { return STATIONS[normalizePlace(value)] || lookup?.get(stationKey(value)) || null; }
function pointKey(point) { return `${point[0].toFixed(3)},${point[1].toFixed(3)}`; }
function slug(value) {
  return normalizePlace(value).replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-|-$/g,"");
}

function kyivDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:"Europe/Kyiv", year:"numeric", month:"2-digit", day:"2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { year:Number(get("year")), month:Number(get("month")), day:Number(get("day")) };
}

export function serviceDateFor(now = new Date()) {
  const { year,month,day }=kyivDateParts(now);
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

export function buildRunIdentity(update, now = new Date()) {
  const serviceDate=serviceDateFor(update.updatedAt?new Date(update.updatedAt):now);
  const directionId=`${slug(update.origin)}--${slug(update.destination)}`;
  return { serviceDate, directionId, runId:update.canonicalServiceId||canonicalServiceKey(update,now) };
}

export function buildRailGraph(features) {
  const nodes=new Map(), edges=new Map();
  const addNode=(point)=>{
    const key=pointKey(point);
    if(!nodes.has(key))nodes.set(key,point);
    if(!edges.has(key))edges.set(key,[]);
    return key;
  };
  for(const feature of features){
    const coordinates=feature.geometry?.coordinates||[];
    for(let index=1;index<coordinates.length;index+=1){
      const a=addNode(coordinates[index-1]), b=addNode(coordinates[index]);
      const weight=haversineKm(nodes.get(a),nodes.get(b));
      edges.get(a).push({key:b,weight}); edges.get(b).push({key:a,weight});
    }
  }
  return {nodes,edges};
}

function nearestNode(graph, point) {
  let best=null;
  for(const [key,coordinates] of graph.nodes){
    const distance=haversineKm(point,coordinates);
    if(!best||distance<best.distance)best={key,distance};
  }
  return best;
}

export function railPath(graph, origin, destination) {
  const start=nearestNode(graph,origin), finish=nearestNode(graph,destination);
  const directKm=haversineKm(origin,destination);
  if(!start||!finish||start.distance>25||finish.distance>25)return null;
  const distances=new Map([[start.key,0]]), previous=new Map(), pending=new Set(graph.nodes.keys());
  while(pending.size){
    let current=null;
    for(const key of pending)if(distances.has(key)&&(current===null||distances.get(key)<distances.get(current)))current=key;
    if(current===null||current===finish.key)break;
    pending.delete(current);
    for(const edge of graph.edges.get(current)||[]){
      if(!pending.has(edge.key))continue;
      const candidate=distances.get(current)+edge.weight;
      if(candidate<(distances.get(edge.key)??Infinity)){distances.set(edge.key,candidate);previous.set(edge.key,current);}
    }
  }
  if(!distances.has(finish.key))return null;
  const keys=[];
  for(let key=finish.key;key;key=previous.get(key)){keys.push(key);if(key===start.key)break;}
  const totalKm=Number(distances.get(finish.key).toFixed(1));
  const maximumCredibleKm=Math.max(directKm*1.8,directKm+40);
  if(totalKm>maximumCredibleKm)return null;
  return {
    coordinates:keys.reverse().map((key)=>graph.nodes.get(key)),
    totalKm,
    anchorErrorKm:Number((start.distance+finish.distance).toFixed(1)),
    startAnchorErrorKm:Number(start.distance.toFixed(1)),
    endAnchorErrorKm:Number(finish.distance.toFixed(1)),
  };
}

export function railPathViaAnchor(graph, origin, destination, anchor = null) {
  const direct=railPath(graph,origin,destination);
  if(!anchor)return direct;
  const anchorNode=nearestNode(graph,anchor);
  if(!anchorNode||anchorNode.distance>12)return direct;
  const before=railPath(graph,origin,anchor),after=railPath(graph,anchor,destination);
  if(!before||!after)return direct;
  const viaKm=before.totalKm+after.totalKm;
  const maximumKm=direct?Math.max(direct.totalKm*1.3,direct.totalKm+40):Infinity;
  if(viaKm>maximumKm)return direct;
  return {
    coordinates:[...before.coordinates,...after.coordinates.slice(1)],
    totalKm:Number(viaKm.toFixed(1)),
    anchorErrorKm:Number((before.startAnchorErrorKm+anchorNode.distance+after.endAnchorErrorKm).toFixed(1)),
    startAnchorErrorKm:before.startAnchorErrorKm,
    endAnchorErrorKm:after.endAnchorErrorKm,
    viaAnchor:true,
    viaAnchorErrorKm:Number(anchorNode.distance.toFixed(1)),
  };
}

export function preferPhysicalRailRoute(publicRoute,fallbackRoute=null){
  if(publicRoute?.status!=="ready"||publicRoute.geometry?.type!=="LineString"||!Array.isArray(publicRoute.geometry.coordinates)||publicRoute.geometry.coordinates.length<2)return fallbackRoute;
  return {coordinates:publicRoute.geometry.coordinates,totalKm:publicRoute.totalKm,anchorErrorKm:0,startAnchorErrorKm:0,endAnchorErrorKm:0,geometryQuality:publicRoute.quality,routeConfidence:publicRoute.confidence,method:publicRoute.method,versionId:publicRoute.versionId};
}

function zonedClock(value, now) {
  const match=String(value||"").match(/(\d{1,2}):(\d{2})/);
  if(!match)return null;
  const desired=kyivDateParts(now);
  const hour=Number(match[1]), minute=Number(match[2]);
  let candidate=new Date(Date.UTC(desired.year,desired.month-1,desired.day,hour,minute));
  const shown=new Intl.DateTimeFormat("en-CA",{
    timeZone:"Europe/Kyiv",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23",
  }).formatToParts(candidate);
  const get=(type)=>Number(shown.find((part)=>part.type===type)?.value);
  const displayedUtc=Date.UTC(get("year"),get("month")-1,get("day"),get("hour"),get("minute"));
  const desiredUtc=Date.UTC(desired.year,desired.month-1,desired.day,hour,minute);
  candidate=new Date(candidate.getTime()+(desiredUtc-displayedUtc));
  if(candidate.getTime()<now.getTime()-90*60_000)candidate=new Date(candidate.getTime()+86_400_000);
  return candidate;
}

function pointInFeature(point,feature){
  const polygons=feature.geometry.type==="Polygon"?[feature.geometry.coordinates]:feature.geometry.coordinates;
  return polygons.some((polygon)=>{
    const ring=polygon[0];let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const [xi,yi]=ring[i],[xj,yj]=ring[j];
      if(((yi>point[1])!==(yj>point[1]))&&point[0]<((xj-xi)*(point[1]-yi))/(yj-yi)+xi)inside=!inside;
    }
    return inside;
  });
}
function regionsForPoints(points,features){
  return points?.length?features.filter((feature)=>points.some((point)=>pointInFeature(point,feature))).map((feature)=>feature.properties.id):[];
}

function reliabilityScore(label="") {
  const value=label.toLocaleLowerCase("uk");
  if(value.includes("висок"))return 0.82;
  if(value.includes("серед"))return 0.66;
  if(value.includes("низ"))return 0.48;
  return 0.56;
}

export function calculateQuality({hasRoute,hasForecast,sourceAgeMinutes,reliability,anchorErrorKm=0}){
  const sourceScore=sourceAgeMinutes<=20?1:sourceAgeMinutes<=45?0.72:sourceAgeMinutes<=120?0.42:0.18;
  const routeScore=hasRoute?Math.max(0.48,1-Math.min(anchorErrorKm,140)/210):0;
  const forecastScore=hasForecast?1:0;
  const total=sourceScore*0.3+routeScore*0.28+forecastScore*0.24+reliabilityScore(reliability)*0.18;
  return Number(Math.max(0,Math.min(1,total)).toFixed(2));
}

export function estimatePosition(update,routeResult,now,sourceAgeMinutes,stationAnchor=null,segmentCalibration=null){
  const freshness=evaluateFreshness(sourceAgeMinutes);
  if(!freshness.canPosition)return null;
  const referenceTime=update.updatedAt?new Date(update.updatedAt):now;
  const measure=buildRouteMeasure(routeResult?.coordinates), arrival=zonedClock(update.forecastArrival,referenceTime);
  if(!measure||update.operationalStatus!=="moving")return null;
  const effectiveNow=new Date(referenceTime.getTime()+freshness.modelAgeMinutes*60_000);
  if(stationAnchor){
    const routeDistanceKm=projectDistanceOnRoute(measure,stationAnchor);
    const posterior=estimatePosterior({
      now,routeLengthKm:measure.totalKm,nominalSpeedKph:measure.totalKm>900?67:measure.totalKm>450?63:58,
      anchors:[{routeDistanceKm,occurredAt:update.updatedAt,errorKm:update.positionEvidence==="reported-station-passage"?2:5,reliability:update.positionEvidence==="reported-station-passage"?0.9:0.78}],
      schedule:arrival?[{routeDistanceKm:measure.totalKm,expectedAt:arrival.toISOString()}]:[],
      historicalSamples:segmentCalibration?.samples||0,historicalSpreadMinutes:segmentCalibration?.spreadMinutes||0,
    });
    if(posterior.status!=="unknown")return {
      status:posterior.status,coordinates:interpolateAlongRoute(measure,posterior.distanceKm),
      updatedAt:update.updatedAt,sourceUpdatedAt:update.updatedAt,calculatedAt:posterior.calculatedAt,
      confidence:posterior.confidence,errorKm:posterior.errorKm,method:posterior.method,
      lastConfirmedAt:update.updatedAt,freshness,sources:[update.sourceId||"station-event",arrival?"UZ forecast arrival":null,"rail posterior"].filter(Boolean),
      confidenceReasons:freshnessReasons({freshness,hasRoute:true,hasForecast:Boolean(arrival),anchorErrorKm:routeResult.anchorErrorKm}),
      probabilityCorridor:posterior.corridor,distribution:posterior.distribution,
      calculation:{
        progress:Number((posterior.distanceKm/measure.totalKm).toFixed(3)),totalKm:Number(measure.totalKm.toFixed(1)),
        sourceAgeMinutes:posterior.sourceAgeMinutes,forecastArrivalAt:arrival?.toISOString()||null,
        model:"station-anchored-posterior-v3",p50:posterior.corridor.p50,p90:posterior.corridor.p90,calibration:posterior.calibration,
      },
    };
  }
  if(!arrival)return null;
  const remainingHours=Math.max(0,(arrival.getTime()-effectiveNow.getTime())/3_600_000);
  const nominalSpeedKph=measure.totalKm>900?67:measure.totalKm>450?63:58;
  const progress=Math.max(0.025,Math.min(0.975,1-(remainingHours*nominalSpeedKph)/measure.totalKm));
  const quality=calculateQuality({
    hasRoute:true,hasForecast:true,sourceAgeMinutes,reliability:update.reliability,anchorErrorKm:routeResult.anchorErrorKm,
  });
  const confidence=Math.max(freshness.frozen?0.16:0.24,Math.min(0.72,quality*0.78*freshnessConfidenceFactor(sourceAgeMinutes)));
  const agePenaltyKm=Math.max(0,sourceAgeMinutes-30)*0.22;
  const errorKm=Math.max(18,routeResult.anchorErrorKm/2+measure.totalKm*(1-confidence)*0.1+agePenaltyKm);
  return {
    status:freshness.frozen?"stale":"estimated",coordinates:interpolateAlongRoute(measure,measure.totalKm*progress),
    updatedAt:update.updatedAt,sourceUpdatedAt:update.updatedAt,calculatedAt:now.toISOString(),
    confidence:Number(confidence.toFixed(2)),errorKm:Number(errorKm.toFixed(1)),
    method:"rail-corridor-v6",lastConfirmedAt:update.updatedAt,freshness,
    sources:["UZ official public status","UZ forecast arrival","rail corridor graph"],
    confidenceReasons:freshnessReasons({freshness,hasRoute:true,hasForecast:true,anchorErrorKm:routeResult.anchorErrorKm}),
    calculation:{
      progress:Number(progress.toFixed(3)),totalKm:Number(measure.totalKm.toFixed(1)),
      nominalSpeedKph,forecastArrivalAt:arrival.toISOString(),remainingHours:Number(remainingHours.toFixed(2)),
      sourceAgeMinutes:Number(sourceAgeMinutes.toFixed(1)),extrapolationMinutes:Number(freshness.modelAgeMinutes.toFixed(1)),
      frozenAtMinutes:freshness.frozen?freshness.modelAgeMinutes:null,effectiveCalculationAt:effectiveNow.toISOString(),
    },
  };
}

function evidenceFor(update,position,sourceStatus){
  const positionKind=position.status==="estimated"?"calculated":position.status==="reported"?"reported":position.status==="stale"?"stale":"unavailable";
  return [
    {kind:"official",label:"Статус движения",value:update.publicStatus||"Не указан",timestamp:update.updatedAt,source:"Укрзалізниця"},
    {kind:"official",label:"Задержка",value:update.delayLabel||"Не указана",timestamp:update.updatedAt,source:"Укрзалізниця"},
    {kind:"official",label:"Прогноз прибытия",value:update.forecastArrival||"Не опубликован",timestamp:update.updatedAt,source:"Укрзалізниця"},
    {kind:positionKind,label:"Положение",value:position.status==="estimated"?"Рассчитано моделью":position.status==="reported"?"Сообщено официальным источником на станции":position.status==="stale"?"Экстраполяция остановлена":"Недостаточно данных",timestamp:position.updatedAt,source:position.method},
    {kind:sourceStatus.status==="online"?"official":"stale",label:"Состояние источника",value:sourceStatus.label,timestamp:sourceStatus.checkedAt,source:"Системная диагностика"},
  ];
}

export function buildHistoricalPosition(update, routeCoordinates, capturedAt, waypoints = []) {
  const timestamp = capturedAt || update?.updatedAt;
  const at = new Date(timestamp);
  if (!update || !routeCoordinates?.length || !Number.isFinite(at.getTime())) return null;
  const sourceAge = ageOf(update.updatedAt || timestamp, at);
  const reported=normalizePlace(update.reportedStation),stationAnchor=reported?waypoints.find(item=>normalizePlace(item.name||item.label)===reported)?.coordinates:null;
  const position = estimatePosition(update, { coordinates: routeCoordinates }, at, sourceAge, stationAnchor);
  if (!position?.coordinates) return null;
  return {
    timestamp: at.toISOString(), coordinates: position.coordinates,
    status: position.status, confidence: position.confidence, errorKm: position.errorKm,
    delayMinutes: update.delayMinutes ?? null, label: update.reportedStation
      ? `Станционное событие: ${update.reportedStation}` : "Серверный расчётный снимок",
    evidence: position.status === "reported" ? "reported" : "calculated",
  };
}
export function buildStationPlan(waypoints,update,position,forecastArrivalAt){
  const points=(waypoints||[]).filter(item=>Number.isFinite(item.distanceKm)).sort((a,b)=>a.distanceKm-b.distanceKm);
  if(!points.length)return [];
  const totalKm=Math.max(...points.map(item=>item.distanceKm),position.calculation?.totalKm||0,1);
  const category=update.sourceId==="uz-suburban-telegram"?"suburban":"passenger";
  const speed=category==="suburban"?44:totalKm>700?67:60;
  const arrivalMs=Date.parse(forecastArrivalAt||"");
  const endMs=Number.isFinite(arrivalMs)?arrivalMs:Date.parse(position.calculatedAt||new Date());
  const startMs=endMs-totalKm/speed*3600000;
  const currentKm=Number(position.calculation?.progress)*totalKm;
  const reportedKey=stationKey(update.reportedStation||"");
  return points.map((point,index)=>{
    const key=stationKey(point.name||point.label||"");
    const actual=reportedKey&&key===reportedKey?update.updatedAt:null;
    const status=actual?"confirmed":Number.isFinite(currentKm)&&point.distanceKm<currentKm?"model-passed":Number.isFinite(currentKm)&&index===points.findIndex(item=>item.distanceKm>=currentKm)?"model-next":"planned";
    return {sequence:index+1,station:point.name||point.label,distanceKm:Number(point.distanceKm.toFixed(1)),plannedAt:new Date(startMs+point.distanceKm/totalKm*(endMs-startMs)).toISOString(),actualAt:actual,status,category};
  });
}
export function deriveOperationalDisruption(update={}){
  const operational=String(update.operationalStatus||"").toLowerCase();
  const text=`${update.publicStatus||""} ${update.status||""} ${update.reason||""}`.toLocaleLowerCase("uk");
  const held=["held","stopped","suspended","station","at-station","dwelling","waiting","depot"].includes(operational)||/(рух\s+(?:призупинено|зупинено)|зупинен(?:о|ий)?|остановлен(?:о|ный)?|призупинен(?:о|ий)?|стоїть|стоит|затриман(?:о|ий)?\s+на\s+станц)/u.test(text);
  const delay=Number(update.delayMinutes);
  return {held,state:held?"held":Number.isFinite(delay)&&delay>0?"delayed":"normal",delayMinutes:Number.isFinite(delay)&&delay>0?delay:0};
}

export function freezeDisruptedPosition({update={},routeResult=null,estimate=null,now=new Date(),sourceAgeMinutes=0}={}){
  const disruption=deriveOperationalDisruption(update);if(!disruption.held)return null;
  const measure=buildRouteMeasure(routeResult?.coordinates),age=Math.max(0,Number(sourceAgeMinutes)||0),freshness=evaluateFreshness(age);
  if(!measure)return null;
  const hasEstimate=Array.isArray(estimate?.coordinates)&&estimate.coordinates.every(Number.isFinite);
  const progress=hasEstimate&&Number.isFinite(Number(estimate?.calculation?.progress))?Number(estimate.calculation.progress):.5;
  const coordinates=hasEstimate?estimate.coordinates:interpolateAlongRoute(measure,measure.totalKm*progress);
  if(!coordinates)return null;
  const baseConfidence=hasEstimate?Number(estimate.confidence||.35):.14;
  const confidence=Math.max(.05,Math.min(.48,baseConfidence*.68*Math.exp(-age/360)));
  const routeEnvelope=hasEstimate?0:measure.totalKm*.52;
  const errorKm=Math.min(300,Math.max(Number(estimate?.errorKm)||25,routeEnvelope,25+age*.3));
  return {
    ...(estimate||{}),status:age>90?"stale":"estimated",coordinates,
    updatedAt:update.updatedAt||now.toISOString(),sourceUpdatedAt:update.updatedAt||null,
    calculatedAt:update.updatedAt||now.toISOString(),confidence:Number(confidence.toFixed(2)),errorKm:Number(errorKm.toFixed(1)),
    method:hasEstimate?"operational-hold-frozen-estimate":"operational-hold-route-envelope",
    lastConfirmedAt:null,freshness,sources:["operational-event","rail-geometry"],
    confidenceReasons:[
      {positive:false,text:"Движение остановлено; станция не определена"},
      {positive:hasEstimate,text:hasEstimate?"Положение зафиксировано на момент сообщения об остановке":"Показан центр вероятного участка маршрута"},
      {positive:false,text:`Неопределённость увеличена до ±${Math.round(errorKm)} км`},
    ],
    calculation:{...(estimate?.calculation||{}),progress:Number(progress.toFixed(3)),totalKm:Number(measure.totalKm.toFixed(1)),frozen:true,frozenAt:update.updatedAt||now.toISOString()},
    reasonCode:"operational_hold",reason:"Последнее вероятное положение на момент остановки; точная станция не подтверждена",
  };
}

export function deriveStationPresence(update, now = new Date()) {
  const station=String(update?.reportedStation||"").trim();
  if(!station)return null;
  const observedAt=new Date(update.updatedAt||now),ageMinutes=Math.max(0,(now-observedAt)/60000);
  const text=`${update.publicStatus||""} ${update.status||""}`.toLocaleLowerCase("uk");
  const sameDestination=normalizePlace(station)===normalizePlace(update.destination||"");
  const explicitDepot=update.operationalStatus==="depot";
  const explicitStop=deriveOperationalDisruption(update).held||/(прибув|прибыл|прибуття|на станц|кінцева|конечн)/u.test(text);
  if(!sameDestination&&!explicitDepot&&!explicitStop)return {station,kind:"passage",label:`Зафиксировано прохождение: ${station}`,ageMinutes:Number(ageMinutes.toFixed(1)),holdsPosition:false};
  const dwellMinutes=explicitDepot?12*60:sameDestination?180:60;
  const fresh=ageMinutes<=dwellMinutes;
  return {
    station,kind:explicitDepot?"depot":sameDestination?"destination-arrival":"station-stop",
    label:explicitDepot?`В депо · ${station}`:fresh?`На станции · ${station}`:`Последний факт: ${station}`,
    ageMinutes:Number(ageMinutes.toFixed(1)),holdsPosition:true,fresh,
    confidence:fresh?(sameDestination?.9:.86):.45,
    errorKm:fresh?1.2:4,
    retentionMinutes:dwellMinutes,
  };
}
export function deriveStationLifecycle(update, now = new Date(), previous = null) {
  const presence=deriveStationPresence(update,now),text=`${update?.publicStatus||""} ${update?.status||""}`.toLocaleLowerCase("uk");
  const departure=/(відправив|відправлено|вирушив|отправил|отправлен|прослідував далі)/u.test(text);
  const cancelled=/(скасован|відмінено|отмен)/u.test(text);
  let phase="in-transit",label="В пути",eventType="movement",certainty=.55;
  if(cancelled){phase="cancelled";label="Отменён";eventType="service";certainty=.95;}
  else if(presence?.kind==="depot"){phase=presence.fresh?"depot":"last-seen";label=presence.fresh?"В депо":presence.label;eventType="arrival";certainty=presence.confidence;}
  else if(departure&&presence){phase="departed";label=`Отправился · ${presence.station}`;eventType="departure";certainty=.88;}
  else if(presence?.kind==="destination-arrival"){phase=presence.fresh?"completed":"last-seen";label=presence.fresh?`Завершил рейс · ${presence.station}`:presence.label;eventType="arrival";certainty=presence.confidence;}
  else if(presence?.kind==="station-stop"){phase=presence.fresh?"dwelling":"last-seen";label=presence.fresh?`Стоянка · ${presence.station}`:presence.label;eventType="arrival";certainty=presence.confidence;}
  else if(presence?.kind==="passage"){phase="passed";label=presence.label;eventType="passage";certainty=.82;}
  else if(update?.positionEvidence==="station-board-window"){phase="scheduled";label="Ожидается по табло";eventType="schedule";certainty=.55;}
  const transition=previous?.phase&&previous.phase!==phase?`${previous.phase}->${phase}`:null;
  return {phase,label,eventType,certainty:Number(certainty||0),station:presence?.station||null,observedAt:update?.updatedAt||null,transition,isCurrent:presence?.fresh!==false};
}
function objectFromUpdate(update,routeResult,routeId,regions,now,sourceStatus,sourceAgeMinutes,stations,stationLookup,segmentCalibration){
  const identity=buildRunIdentity(update,now), origin=stationCoordinates(update.origin,stationLookup);
  const reportedAnchor=stationCoordinates(update.reportedStation,stationLookup);
  const freshness=evaluateFreshness(sourceAgeMinutes);
  const stationPresence=deriveStationPresence(update,now);
  const stationLifecycle=deriveStationLifecycle(update,now);
  const disruption=deriveOperationalDisruption(update);
  const isStationReport=Boolean(update.reportedStation&&["reported-station-passage","station-board-window"].includes(update.positionEvidence));
  const admission=positionAdmission(update,{hasRoute:Boolean(routeResult),sourceAgeMinutes});
  const estimated=admission.allowCalculated?estimatePosition(update,routeResult,now,sourceAgeMinutes,isStationReport?reportedAnchor:null,segmentCalibration):null;
  const reportConfidence=update.positionEvidence==="reported-station-passage"?0.82:update.positionEvidence==="station-board-window"?0.66:0.58;
  const reportErrorKm=update.positionEvidence==="reported-station-passage"?2:update.positionEvidence==="station-board-window"?5:3;
  const reportableAnchor=admission.allowReported&&freshness.canPosition&&reportedAnchor;
  const holdAt=update.updatedAt&&Number.isFinite(Date.parse(update.updatedAt))?new Date(update.updatedAt):now;
  const stopMomentEstimate=disruption.held&&routeResult?estimatePosition({...update,operationalStatus:"moving"},routeResult,holdAt,0,isStationReport?reportedAnchor:null,segmentCalibration):null;
  const heldPosition=disruption.held?freezeDisruptedPosition({update,routeResult,estimate:stopMomentEstimate||estimated,now,sourceAgeMinutes}):null;
  const retainedStationAnchor=stationPresence?.holdsPosition&&reportedAnchor;
  const reported=(reportableAnchor||retainedStationAnchor)&&(update.operationalStatus!=="moving"||isStationReport||stationPresence?.holdsPosition)?{
    status:freshness.frozen||stationPresence?.fresh===false?"stale":"reported",coordinates:reportedAnchor,updatedAt:update.updatedAt,
    sourceUpdatedAt:update.updatedAt,calculatedAt:now.toISOString(),confidence:stationPresence?.holdsPosition?(stationPresence.confidence||0.45):(freshness.frozen?0.28:reportConfidence),errorKm:stationPresence?.holdsPosition?(stationPresence.errorKm||4):(freshness.frozen?12:reportErrorKm),
    method:stationPresence?.fresh===false?"retained-last-confirmed-station":freshness.frozen?"stale-official-station-event":update.positionEvidence==="reported-station-passage"?"official-station-passage-report":update.positionEvidence==="station-board-window"?"official-station-board-window":"official-status-at-origin",lastConfirmedAt:update.updatedAt,
    freshness,sources:[update.sourceId||"uz-delay-dashboard"],
    confidenceReasons:freshnessReasons({freshness,hasRoute:Boolean(routeResult),hasForecast:Boolean(update.forecastArrival),anchorErrorKm:routeResult?.anchorErrorKm}),
  }:null;
  const unavailableDuringHold={status:"unknown",coordinates:null,updatedAt:update.updatedAt,sourceUpdatedAt:update.updatedAt,calculatedAt:now.toISOString(),confidence:0,errorKm:null,method:"operational-hold-without-station-anchor",lastConfirmedAt:null,freshness,sources:[update.sourceId||"public-status"],confidenceReasons:["Явная остановка движения без доступного станционного якоря"],reasonCode:"operational_hold",reason:"Движение остановлено; точная станция не подтверждена"};
  const position=(disruption.held?(reported||heldPosition||unavailableDuringHold):(stationPresence?.holdsPosition?reported||estimated:estimated||reported))||{
    status:"unknown",coordinates:null,updatedAt:update.updatedAt,sourceUpdatedAt:update.updatedAt,calculatedAt:now.toISOString(),confidence:0,errorKm:null,
    method:admission.reasonCode==="source_expired"?"source-snapshot-expired":admission.reasonCode,lastConfirmedAt:update.reportedStation?update.updatedAt:null,
    freshness,sources:["UZ official public status"],
    confidenceReasons:freshnessReasons({freshness,hasRoute:Boolean(routeResult),hasForecast:Boolean(update.forecastArrival),anchorErrorKm:routeResult?.anchorErrorKm}),
    reasonCode:admission.reasonCode,reason:admission.reason,
  };
  const quality=calculateQuality({
    hasRoute:Boolean(routeResult),hasForecast:Boolean(update.forecastArrival),sourceAgeMinutes,
    reliability:update.reliability,anchorErrorKm:routeResult?.anchorErrorKm,
  });
  const referenceTime=update.updatedAt?new Date(update.updatedAt):now;
  const forecastArrivalAt=zonedClock(update.forecastArrival,referenceTime)?.toISOString()||null;
  const events=buildOfficialEvents(update,identity.runId);
  const corridor=buildUncertaintyCorridor(position,routeResult?.coordinates);
  const waypointData=buildGeometricWaypoints(routeResult?.coordinates,stations,corridor);
  const stationPlan=buildStationPlan(waypointData.waypoints,update,position,forecastArrivalAt);
  const routeTimeline=[
    {kind:"origin",label:update.origin||"Пункт отправления",evidence:"route",timestamp:null},
    waypointData.previous?{kind:"model-past",label:waypointData.previous.name,evidence:"geometry",caption:"ОРИЕНТИР ПОЗАДИ РАСЧЁТНОГО УЧАСТКА",timestamp:null}:null,
    ["estimated","stale"].includes(position.status)?{kind:"estimate",label:position.status==="stale"?"Последнее допустимое расчётное положение":"Расчётное положение",evidence:"calculated",timestamp:position.calculatedAt}:null,
    waypointData.next?{kind:"model-next",label:waypointData.next.name,evidence:"geometry",caption:"СЛЕДУЮЩИЙ ГЕОМЕТРИЧЕСКИЙ ОРИЕНТИР",timestamp:null}:null,
    {kind:"destination",label:update.destination||"Пункт назначения",evidence:"route",timestamp:forecastArrivalAt},
  ].filter(Boolean);
  const queue=stationQueueForUpdate(update,now),queueCoordinates=queue?stationCoordinates(queue.station,stationLookup):null;
  return {
    id:identity.runId,runId:identity.runId,serviceDate:identity.serviceDate,directionId:identity.directionId,
    trainNumber:update.trainNumber,transport:"train",type:"passenger",name:`Поезд №${update.trainNumber}`,
    route:update.route,origin:update.origin,destination:update.destination,routeId,regions,routeCoordinates:routeResult?.coordinates||[],
    description:`Публичный рейс Укрзалізниці ${update.route}. Официальный статус: ${update.publicStatus}; задержка ${update.delayLabel||"не указана"}.`,
    rollingStock:"Тип состава не опубликован в источнике",operationalStatus:disruption.held?(stationPresence?.kind==="depot"?"depot":"station"):update.operationalStatus,
    stationPresence,stationLifecycle,disruption,registryState:update.registryState||"unobserved",positionAdmission:admission,
    stationQueue:queue&&queueCoordinates?{...queue,coordinates:queueCoordinates}:null,
    liveUpdate:update,telemetry:{speedKph:null},position,quality,
    evidence:evidenceFor(update,position,sourceStatus),events,corridor,routeTimeline,
    waypoints:waypointData.waypoints,stationPlan,
    forecast:{departureAt:zonedClock(update.forecastDeparture,referenceTime)?.toISOString()||null,arrivalAt:forecastArrivalAt},
    journey:{progress:position.calculation?.progress??null,lastEvent:events[0]||null,nextEvent:stationPlan.find(item=>item.status==="model-next")||null,previousWaypoint:waypointData.previous,nextWaypoint:waypointData.next},history:[],
  };
}

function segmentCalibrationFor(stats=[],trainNumber=""){
  const relevant=stats.filter((item)=>String(item.train_family)===String(trainNumber)&&Number(item.sample_count)>0);
  if(!relevant.length)return null;
  const samples=relevant.reduce((sum,item)=>sum+Number(item.sample_count||0),0);
  const spreadMinutes=relevant.reduce((sum,item)=>sum+Math.max(0,Number(item.p90_minutes||0)-Number(item.p10_minutes||0))*Number(item.sample_count||0),0)/Math.max(samples,1);
  return {samples,spreadMinutes:Number(spreadMinutes.toFixed(1)),segments:relevant.length};
}

export async function loadTransportData(now=new Date()){
  const [baseRoutes,regions,liveData,freightData,vesselData,sourceData,stationData,sourceRuntime]=await Promise.all([
    readJson("data/railways.geojson"),readJson("data/regions.geojson"),
    loadLiveSnapshot().then((result)=>result.snapshot).catch(()=>null),loadFreightSnapshot().then((result)=>result.snapshot).catch(()=>null),
    readJson("data/vessels.json",true).catch(()=>null),readJson("data/sources.json",true).catch(()=>null),
    readJson("data/stations.json",true).catch(()=>null),readJson("data/source-runtime.json",true).catch(()=>null),
  ]);
  const sourceStatus=liveData?.sourceStatus||{status:"unavailable",label:"UZ: источник недоступен",checkedAt:null};
  const generatedAt=liveData?.generatedAt||now.toISOString();
  const sourceAgeMinutes=Math.max(0,(now.getTime()-Date.parse(generatedAt))/60_000)||0;
  const runtimeStatuses=Object.fromEntries(Object.entries(sourceRuntime?.sources||{}).map(([id,entry])=>[id,typeof entry?.status==="object"?entry.status:entry]));
  const sourceRegistry=hydrateSourceRegistry(sourceData?.sources||[],{
    ...runtimeStatuses,
    "uz-delay-dashboard":runtimeStatuses["uz-delay-dashboard"]||sourceStatus,
    "osm-rail-geometry":{status:"snapshot",checkedAt:stationData?.generatedAt},
    "ais-provider":vesselData?.sourceStatus,
  },now);
  const sourceSummary=sourceRegistrySummary(sourceRegistry);
  const stations=stationData?.stations||[],stationLookup=buildStationLookup(stations);
  const graph=buildRailGraph(baseRoutes.features);
  const fusedUpdates=fuseServiceUpdates(liveData?.updates||[],now);
  const publicRailRoutes=await loadPublicRailRoutes(fusedUpdates);
  const publicRouteMap=new Map((publicRailRoutes.routes||[]).filter((item)=>item.status==="ready"&&item.geometry?.coordinates?.length>1).map((item)=>[item.key,item]));
  const materializeUpdates=(updates,at=now,prefix="uz-live-route")=>{
    const features=[];
    const materialized=(updates||[]).map((update,index)=>{
      const origin=stationCoordinates(update.origin,stationLookup),destination=stationCoordinates(update.destination,stationLookup),reported=stationCoordinates(update.reportedStation,stationLookup);
      const publicRoute=publicRouteMap.get(`${update.trainNumber}|${update.origin}|${update.destination}`);
      const fallbackRoute=origin&&destination?railPathViaAnchor(graph,origin,destination,reported):null;
      const routeResult=preferPhysicalRailRoute(publicRoute,fallbackRoute);
      const routeId=`${prefix}-${index}`;
      if(routeResult)features.push({
        type:"Feature",properties:{id:routeId,quality:publicRoute?.quality||0.76,source:publicRoute?.method||"schematic-rail-corridor-fallback",graphVersion:publicRoute?.versionId||null,viaConfirmedStation:Boolean(routeResult.viaAnchor),schematicFallback:!publicRoute},
        geometry:{type:"LineString",coordinates:routeResult.coordinates},
      });
      const regionAnchors=routeResult?.coordinates||(reported||origin||destination?[reported,origin,destination].filter(Boolean):[]);
      const updateAgeMinutes=ageOf(update.updatedAt||generatedAt,at);
      const segmentCalibration=segmentCalibrationFor(liveData?.segmentStats||[],update.trainNumber);
      return objectFromUpdate(update,routeResult,routeId,regionsForPoints(regionAnchors,regions.features),at,sourceStatus,updateAgeMinutes,stations,stationLookup,segmentCalibration);
    });
    return {objects:materialized,routes:{type:"FeatureCollection",features},routeMap:new Map(features.map(feature=>[feature.properties.id,feature]))};
  };
  const currentMaterialized=materializeUpdates(fusedUpdates,now);
  const freightMaterialized=materializePublicFreight(freightData,(coordinates)=>regionsForPoints(coordinates,regions.features),now);
  const objects=[...currentMaterialized.objects,...freightMaterialized.objects];
  const dynamicFeatures=[...currentMaterialized.routes.features,...freightMaterialized.features];
  const routes={type:"FeatureCollection",features:dynamicFeatures};
  const routeMap=new Map(dynamicFeatures.map((feature)=>[feature.properties.id,feature]));
  const regionList=[...new Map(regions.features.map((feature)=>[feature.properties.id,{id:feature.properties.id,name:feature.properties.name}])).values()].sort((a,b)=>a.name.localeCompare(b.name,"ru"));
  const positioned=objects.filter((object)=>object.position.coordinates).length;
  const forecastCoverage=objects.filter((object)=>object.liveUpdate.forecastArrival||object.liveUpdate.forecastDeparture).length;
  const stationQueues=groupStationQueues(objects);
  const diagnostics={
    sourceAgeMinutes:Number(sourceAgeMinutes.toFixed(1)),totalRuns:objects.length,positionedRuns:positioned,
    unknownRuns:objects.length-positioned,forecastCoverage,routeCoverage:dynamicFeatures.length,
    averageQuality:objects.length?Number((objects.reduce((sum,item)=>sum+item.quality,0)/objects.length).toFixed(2)):0,
    waypointCoverage:objects.filter((object)=>object.journey.nextWaypoint||object.journey.previousWaypoint).length,
    noRouteRuns:objects.filter((object)=>!object.routeCoordinates.length).length,physicalRouteRuns:currentMaterialized.routes.features.filter((feature)=>!feature.properties.schematicFallback).length,schematicRouteRuns:currentMaterialized.routes.features.filter((feature)=>feature.properties.schematicFallback).length,railRouteVersion:publicRailRoutes.versionId||null,
    rawObservations:(liveData?.updates||[]).length,canonicalRuns:objects.length,
    observedRuns:objects.filter((object)=>object.liveUpdate?.hasOperationalObservation).length,
    plannedOnlyRuns:objects.filter((object)=>object.positionAdmission?.reasonCode==="planned_only").length,
    stationQueueRuns:stationQueues.reduce((sum,group)=>sum+group.entries.length,0),stationQueueGroups:stationQueues.length,
    freightRuns:freightMaterialized.objects.length,freightCorridors:new Set(freightMaterialized.objects.map((object)=>object.freight?.corridorCode)).size,
    freightEligibleEvidence:Number(freightData?.diagnostics?.eligibleEvidence||0),
    exclusionReasons:objects.filter((object)=>!object.position.coordinates).reduce((result,object)=>{const key=object.positionAdmission?.reasonCode||"unknown";result[key]=(result[key]||0)+1;return result;},{}),
    sourcesConnected:sourceSummary.connected,sourcesTotal:sourceSummary.total,
    freshness:evaluateFreshness(sourceAgeMinutes),
    freshRuns:objects.filter((object)=>object.position.freshness?.key==="fresh").length,
    frozenRuns:objects.filter((object)=>object.position.freshness?.frozen&&object.position.coordinates).length,
    learnedSegments:(liveData?.segmentStats||[]).length,modelQuality:liveData?.modelQuality||{evaluations:0,maeMinutes:null,p80Coverage:null},algorithmVersion:"service-registry-v1+rail-posterior-v3+rail-corridor-v6",snapshotSchema:liveData?.schemaVersion||null,
  };
  const eventFeed=objects.flatMap((object)=>object.events.map((event)=>({...event,objectId:object.id,trainNumber:object.trainNumber,route:object.route,positionStatus:object.position.status})))
    .sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
  return {
    generatedAt,calculatedAt:now.toISOString(),dataMode:"UZ-public-event-fusion-v6+delayed-freight-v2",safetyNote:"Public passenger status and delayed aggregate freight corridors only; no exact freight position is exposed.",
    sourceStatus,sourceRegistry,sourceSummary,diagnostics,
    marineStatus:vesselData?.sourceStatus||{status:"unavailable",label:"AIS-провайдер не подключён; суда не отображаются"},
    freightStatus:freightData?.sourceStatus||{status:"unavailable",label:"Грузовой агрегированный слой недоступен"},
    liveFeed:fusedUpdates.map((update,index)=>({...update,objectId:objects[index]?.id||null})),eventFeed,
    objects,routes,routeMap,regions,regionList,stationQueues,
    buildTimelineObjects:(updates,at)=>materializeUpdates(fuseServiceUpdates(updates,new Date(at)),new Date(at),"uz-history-route"),
  };
}
