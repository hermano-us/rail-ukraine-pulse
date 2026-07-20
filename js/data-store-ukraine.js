import { buildRouteMeasure, haversineKm, interpolateAlongRoute, projectDistanceOnRoute } from "./positioning.js";
import { estimatePosterior } from "../shared/rail-posterior.js";
import { buildGeometricWaypoints, buildOfficialEvents, buildUncertaintyCorridor, hydrateSourceRegistry, sourceRegistrySummary } from "./evidence-engine.js";
import { evaluateFreshness, freshnessConfidenceFactor, freshnessReasons, sourceAgeMinutes as ageOf } from "./freshness-policy.js";
import { loadLiveSnapshot } from "./live-data-client.js";

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
  return { serviceDate, directionId, runId:`uz:${serviceDate}:${update.trainNumber}:${directionId}` };
}

function buildRailGraph(features) {
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

function railPath(graph, origin, destination) {
  const start=nearestNode(graph,origin), finish=nearestNode(graph,destination);
  if(!start||!finish||start.distance>140||finish.distance>140)return null;
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
  return { coordinates:keys.reverse().map((key)=>graph.nodes.get(key)), anchorErrorKm:Number((start.distance+finish.distance).toFixed(1)) };
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

export function estimatePosition(update,routeResult,now,sourceAgeMinutes,stationAnchor=null){
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
        model:"station-anchored-posterior",p50:posterior.corridor.p50,p90:posterior.corridor.p90,
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
    method:"rail-corridor-v5",lastConfirmedAt:update.updatedAt,freshness,
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

function objectFromUpdate(update,routeResult,routeId,regions,now,sourceStatus,sourceAgeMinutes,stations,stationLookup){
  const identity=buildRunIdentity(update,now), origin=stationCoordinates(update.origin,stationLookup);
  const reportedAnchor=stationCoordinates(update.reportedStation,stationLookup)||origin;
  const freshness=evaluateFreshness(sourceAgeMinutes);
  const isStationReport=Boolean(update.reportedStation&&["reported-station-passage","station-board-window"].includes(update.positionEvidence));
  const estimated=estimatePosition(update,routeResult,now,sourceAgeMinutes,isStationReport?reportedAnchor:null);
  const reportConfidence=update.positionEvidence==="reported-station-passage"?0.82:update.positionEvidence==="station-board-window"?0.66:0.58;
  const reportErrorKm=update.positionEvidence==="reported-station-passage"?2:update.positionEvidence==="station-board-window"?5:3;
  const reported=freshness.canPosition&&reportedAnchor&&(update.operationalStatus!=="moving"||isStationReport)?{
    status:freshness.frozen?"stale":"reported",coordinates:reportedAnchor,updatedAt:update.updatedAt,
    sourceUpdatedAt:update.updatedAt,calculatedAt:now.toISOString(),confidence:freshness.frozen?0.28:reportConfidence,errorKm:freshness.frozen?12:reportErrorKm,
    method:freshness.frozen?"stale-official-station-event":update.positionEvidence==="reported-station-passage"?"official-station-passage-report":update.positionEvidence==="station-board-window"?"official-station-board-window":"official-status-at-origin",lastConfirmedAt:update.updatedAt,
    freshness,sources:[update.sourceId||"uz-delay-dashboard"],
    confidenceReasons:freshnessReasons({freshness,hasRoute:Boolean(routeResult),hasForecast:Boolean(update.forecastArrival),anchorErrorKm:routeResult?.anchorErrorKm}),
  }:null;
  const position=estimated||reported||{
    status:"unknown",coordinates:null,updatedAt:update.updatedAt,sourceUpdatedAt:update.updatedAt,calculatedAt:now.toISOString(),confidence:0,errorKm:null,
    method:!freshness.canPosition?"source-snapshot-expired":routeResult?"forecast-arrival-unavailable":"rail-route-unavailable",lastConfirmedAt:update.updatedAt,
    freshness,sources:["UZ official public status"],
    confidenceReasons:freshnessReasons({freshness,hasRoute:Boolean(routeResult),hasForecast:Boolean(update.forecastArrival),anchorErrorKm:routeResult?.anchorErrorKm}),
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
  const routeTimeline=[
    {kind:"origin",label:update.origin||"Пункт отправления",evidence:"route",timestamp:null},
    waypointData.previous?{kind:"model-past",label:waypointData.previous.name,evidence:"geometry",caption:"ОРИЕНТИР ПОЗАДИ РАСЧЁТНОГО УЧАСТКА",timestamp:null}:null,
    ["estimated","stale"].includes(position.status)?{kind:"estimate",label:position.status==="stale"?"Последнее допустимое расчётное положение":"Расчётное положение",evidence:"calculated",timestamp:position.calculatedAt}:null,
    waypointData.next?{kind:"model-next",label:waypointData.next.name,evidence:"geometry",caption:"СЛЕДУЮЩИЙ ГЕОМЕТРИЧЕСКИЙ ОРИЕНТИР",timestamp:null}:null,
    {kind:"destination",label:update.destination||"Пункт назначения",evidence:"route",timestamp:forecastArrivalAt},
  ].filter(Boolean);
  return {
    id:identity.runId,runId:identity.runId,serviceDate:identity.serviceDate,directionId:identity.directionId,
    trainNumber:update.trainNumber,transport:"train",type:"passenger",name:`Поезд №${update.trainNumber}`,
    route:update.route,origin:update.origin,destination:update.destination,routeId,regions,
    description:`Публичный рейс Укрзалізниці ${update.route}. Официальный статус: ${update.publicStatus}; задержка ${update.delayLabel||"не указана"}.`,
    rollingStock:"Тип состава не опубликован в источнике",operationalStatus:update.operationalStatus,
    liveUpdate:update,telemetry:{speedKph:null},position,quality,
    evidence:evidenceFor(update,position,sourceStatus),events,corridor,routeTimeline,
    waypoints:waypointData.waypoints,
    forecast:{departureAt:zonedClock(update.forecastDeparture,referenceTime)?.toISOString()||null,arrivalAt:forecastArrivalAt},
    journey:{progress:position.calculation?.progress??null,lastEvent:events[0]||null,nextEvent:null,previousWaypoint:waypointData.previous,nextWaypoint:waypointData.next},history:[],
  };
}

export async function loadTransportData(now=new Date()){
  const [baseRoutes,regions,liveData,freightData,vesselData,sourceData,stationData,sourceRuntime]=await Promise.all([
    readJson("data/railways.geojson"),readJson("data/regions.geojson"),
    loadLiveSnapshot().then((result)=>result.snapshot).catch(()=>null),readJson("data/freight-aggregates.json",true).catch(()=>null),
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
  const graph=buildRailGraph(baseRoutes.features),dynamicFeatures=[];
  const objects=(liveData?.updates||[]).map((update,index)=>{
    const origin=stationCoordinates(update.origin,stationLookup),destination=stationCoordinates(update.destination,stationLookup),reported=stationCoordinates(update.reportedStation,stationLookup);
    const routeResult=origin&&destination?railPath(graph,origin,destination):null;
    const routeId=`uz-live-route-${index}`;
    if(routeResult)dynamicFeatures.push({
      type:"Feature",properties:{id:routeId,quality:0.72,source:"rail-corridor-graph"},
      geometry:{type:"LineString",coordinates:routeResult.coordinates},
    });
    const regionAnchors=routeResult?.coordinates||(reported||origin||destination?[reported,origin,destination].filter(Boolean):[]);
    const updateAgeMinutes=ageOf(update.updatedAt||generatedAt,now);
    return objectFromUpdate(update,routeResult,routeId,regionsForPoints(regionAnchors,regions.features),now,sourceStatus,updateAgeMinutes,stations,stationLookup);
  });
  const routes={type:"FeatureCollection",features:dynamicFeatures};
  const routeMap=new Map(dynamicFeatures.map((feature)=>[feature.properties.id,feature]));
  const regionList=[...new Map(regions.features.map((feature)=>[feature.properties.id,{id:feature.properties.id,name:feature.properties.name}])).values()].sort((a,b)=>a.name.localeCompare(b.name,"ru"));
  const positioned=objects.filter((object)=>object.position.coordinates).length;
  const forecastCoverage=objects.filter((object)=>object.liveUpdate.forecastArrival||object.liveUpdate.forecastDeparture).length;
  const diagnostics={
    sourceAgeMinutes:Number(sourceAgeMinutes.toFixed(1)),totalRuns:objects.length,positionedRuns:positioned,
    unknownRuns:objects.length-positioned,forecastCoverage,routeCoverage:dynamicFeatures.length,
    averageQuality:objects.length?Number((objects.reduce((sum,item)=>sum+item.quality,0)/objects.length).toFixed(2)):0,
    waypointCoverage:objects.filter((object)=>object.journey.nextWaypoint||object.journey.previousWaypoint).length,
    sourcesConnected:sourceSummary.connected,sourcesTotal:sourceSummary.total,
    freshness:evaluateFreshness(sourceAgeMinutes),
    freshRuns:objects.filter((object)=>object.position.freshness?.key==="fresh").length,
    frozenRuns:objects.filter((object)=>object.position.freshness?.frozen&&object.position.coordinates).length,
    algorithmVersion:"rail-posterior-v1+rail-corridor-v5",snapshotSchema:liveData?.schemaVersion||null,
  };
  const eventFeed=objects.flatMap((object)=>object.events.map((event)=>({...event,objectId:object.id,trainNumber:object.trainNumber,route:object.route,positionStatus:object.position.status})))
    .sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
  return {
    generatedAt,calculatedAt:now.toISOString(),dataMode:"UZ-public-event-fusion-v5",safetyNote:"Only public passenger status data is displayed.",
    sourceStatus,sourceRegistry,sourceSummary,diagnostics,
    marineStatus:vesselData?.sourceStatus||{status:"unavailable",label:"AIS-провайдер не подключён; суда не отображаются"},
    freightStatus:freightData?.sourceStatus||{status:"unavailable",label:"Грузовые позиции не отображаются"},
    liveFeed:(liveData?.updates||[]).map((update,index)=>({...update,objectId:objects[index]?.id||null})),eventFeed,
    objects,routes,routeMap,regions,regionList,
  };
}
