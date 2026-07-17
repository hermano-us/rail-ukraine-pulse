import { buildRouteMeasure, haversineKm, interpolateAlongRoute } from "./positioning.js";

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
  "пшемисль головний":[22.767,49.784], "хелм":[23.472,51.132],
  "бухарест-норд":[26.074,44.447], "відень західний":[16.337,48.197],
  "будапешт-келеті":[19.083,47.5],
};

function normalizePlace(value = "") {
  return value.toLocaleLowerCase("uk").replace(/[.№]/g, "").replace(/\s+/g, " ").trim();
}
function stationCoordinates(value) { return STATIONS[normalizePlace(value)] || null; }
function pointKey(point) { return `${point[0].toFixed(3)},${point[1].toFixed(3)}`; }

function buildRailGraph(features) {
  const nodes = new Map(), edges = new Map();
  const addNode = (point) => {
    const key = pointKey(point);
    if (!nodes.has(key)) nodes.set(key, point);
    if (!edges.has(key)) edges.set(key, []);
    return key;
  };
  for (const feature of features) {
    const coordinates = feature.geometry?.coordinates || [];
    for (let index = 1; index < coordinates.length; index += 1) {
      const a = addNode(coordinates[index - 1]), b = addNode(coordinates[index]);
      const weight = haversineKm(nodes.get(a), nodes.get(b));
      edges.get(a).push({ key:b, weight }); edges.get(b).push({ key:a, weight });
    }
  }
  return { nodes, edges };
}

function nearestNode(graph, point) {
  let best = null;
  for (const [key, coordinates] of graph.nodes) {
    const distance = haversineKm(point, coordinates);
    if (!best || distance < best.distance) best = { key, distance };
  }
  return best;
}

function railPath(graph, origin, destination) {
  const start = nearestNode(graph, origin), finish = nearestNode(graph, destination);
  if (!start || !finish || start.distance > 140 || finish.distance > 140) return null;
  const distances = new Map([[start.key,0]]), previous = new Map(), pending = new Set(graph.nodes.keys());
  while (pending.size) {
    let current = null;
    for (const key of pending) if (distances.has(key) && (current === null || distances.get(key) < distances.get(current))) current = key;
    if (current === null || current === finish.key) break;
    pending.delete(current);
    for (const edge of graph.edges.get(current) || []) {
      if (!pending.has(edge.key)) continue;
      const candidate = distances.get(current) + edge.weight;
      if (candidate < (distances.get(edge.key) ?? Infinity)) {
        distances.set(edge.key,candidate); previous.set(edge.key,current);
      }
    }
  }
  if (!distances.has(finish.key)) return null;
  const keys = [];
  for (let key = finish.key; key; key = previous.get(key)) { keys.push(key); if (key === start.key) break; }
  return keys.reverse().map((key) => graph.nodes.get(key));
}

function parseTodayClock(value, now) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Kyiv", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const candidate = new Date(`${get("year")}-${get("month")}-${get("day")}T${match[1].padStart(2,"0")}:${match[2]}:00+03:00`);
  if (candidate.getTime() < now.getTime() - 90 * 60_000) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate;
}

function pointInFeature(point, feature) {
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return polygons.some((polygon) => {
    const ring = polygon[0]; let inside = false;
    for (let i=0,j=ring.length-1; i<ring.length; j=i++) {
      const [xi,yi]=ring[i], [xj,yj]=ring[j];
      if (((yi>point[1]) !== (yj>point[1])) && point[0] < ((xj-xi)*(point[1]-yi))/(yj-yi)+xi) inside=!inside;
    }
    return inside;
  });
}
function regionsForPath(path, features) {
  return path ? features.filter((feature) => path.some((point) => pointInFeature(point,feature))).map((feature) => feature.properties.id) : [];
}

function estimatedPosition(update, path, now) {
  const measure = buildRouteMeasure(path), arrival = parseTodayClock(update.forecastArrival, now);
  if (!measure || !arrival || update.operationalStatus !== "moving") return null;
  const remainingHours = Math.max(0,(arrival.getTime()-now.getTime())/3_600_000), nominalSpeedKph=62;
  const progress = Math.max(0.03,Math.min(0.97,1-(remainingHours*nominalSpeedKph)/measure.totalKm));
  const confidence = update.reliability?.toLocaleLowerCase("uk").includes("висок") ? 0.55 : 0.42;
  return {
    status:"estimated", coordinates:interpolateAlongRoute(measure,measure.totalKm*progress),
    updatedAt:update.updatedAt, confidence,
    errorKm:Number(Math.max(25,measure.totalKm*(1-confidence)*0.11).toFixed(1)),
    method:"UZ-arrival-forecast / rail-corridor back-calculation", lastConfirmedAt:update.updatedAt,
    sources:["UZ public delay dashboard","UZ forecast arrival","rail corridor geometry"],
    calculation:{ progress:Number(progress.toFixed(3)), totalKm:Number(measure.totalKm.toFixed(1)), nominalSpeedKph },
  };
}

function objectFromUpdate(update, path, routeId, regions, now) {
  const movingPosition = estimatedPosition(update,path,now), origin = stationCoordinates(update.origin);
  const position = movingPosition || (update.operationalStatus !== "moving" && origin ? {
    status:"reported", coordinates:origin, updatedAt:update.updatedAt, confidence:0.58, errorKm:3,
    method:"UZ-public-status-at-origin", lastConfirmedAt:update.updatedAt, sources:["UZ public delay dashboard"],
  } : {
    status:"unknown", coordinates:null, updatedAt:update.updatedAt, confidence:0, errorKm:null,
    method:path ? "forecast-arrival-unavailable" : "rail-route-unavailable", lastConfirmedAt:update.updatedAt,
    sources:["UZ public delay dashboard"],
  });
  return {
    id:`uz-live-${update.trainNumber.replace(/\W+/g,"-")}-${normalizePlace(update.origin).replace(/\W+/gu,"-")}`,
    trainNumber:update.trainNumber, transport:"train", type:"passenger", name:`Поезд №${update.trainNumber}`,
    route:update.route, routeId, regions,
    description:`Реальный публичный статус Укрзалізниці: ${update.publicStatus}. Задержка ${update.delayLabel || "не указана"}${update.reason ? `. Причина: ${update.reason}` : ""}.`,
    rollingStock:"Тип подвижного состава в публичном источнике не указан",
    operationalStatus:update.operationalStatus, liveUpdate:update, telemetry:{speedKph:null}, position,
    journey:{progress:position.calculation?.progress ?? null,lastEvent:null,nextEvent:null}, history:[],
  };
}

export async function loadTransportData(now = new Date()) {
  const [baseRoutes,regions,liveData,freightData] = await Promise.all([
    readJson("data/railways.geojson"), readJson("data/regions.geojson"),
    readJson("data/live.json",true).catch(()=>null), readJson("data/freight-aggregates.json",true).catch(()=>null),
  ]);
  const graph=buildRailGraph(baseRoutes.features), dynamicFeatures=[];
  const objects=(liveData?.updates || []).map((update,index)=>{
    const origin=stationCoordinates(update.origin), destination=stationCoordinates(update.destination);
    const path=origin&&destination ? railPath(graph,origin,destination) : null, routeId=`uz-live-route-${index}`;
    if(path) dynamicFeatures.push({type:"Feature",properties:{id:routeId,quality:0.72,source:"rail-corridor-model"},geometry:{type:"LineString",coordinates:path}});
    return objectFromUpdate(update,path,routeId,regionsForPath(path,regions.features),now);
  });
  const routes={type:"FeatureCollection",features:dynamicFeatures};
  const routeMap=new Map(dynamicFeatures.map((feature)=>[feature.properties.id,feature]));
  const regionList=[...new Map(regions.features.map((feature)=>[feature.properties.id,{id:feature.properties.id,name:feature.properties.name}])).values()].sort((a,b)=>a.name.localeCompare(b.name,"ru"));
  return {
    generatedAt:liveData?.generatedAt || now.toISOString(), dataMode:"UZ-public-real-only",
    safetyNote:"Only public passenger status data is displayed.",
    sourceStatus:liveData?.sourceStatus || {status:"unavailable",label:"UZ: источник недоступен"},
    marineStatus:{status:"unavailable",label:"AIS-провайдер не подключён; суда не отображаются"},
    freightStatus:freightData?.sourceStatus || {status:"unavailable",label:"Грузовые позиции не отображаются"},
    liveFeed:(liveData?.updates || []).map((update,index)=>({...update,objectId:objects[index]?.id || null})),
    objects,routes,routeMap,regions,regionList,
  };
}
