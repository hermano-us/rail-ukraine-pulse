const UKRAINE_BOUNDS = { minLatitude: 43.5, maxLatitude: 53.5, minLongitude: 21, maxLongitude: 42 };
const STATION_TAGS = new Set(["station", "halt", "junction"]);
const TRACK_TAGS = new Set(["rail", "narrow_gauge"]);

const insideBounds = (latitude, longitude) => Number.isFinite(latitude) && Number.isFinite(longitude)
  && latitude >= UKRAINE_BOUNDS.minLatitude && latitude <= UKRAINE_BOUNDS.maxLatitude
  && longitude >= UKRAINE_BOUNDS.minLongitude && longitude <= UKRAINE_BOUNDS.maxLongitude;

export function normalizeStationAlias(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("uk-UA")
    .replace(/[’'`]/g, "ʼ")
    .replace(/\b(станція|станция|station|вокзал)\b/gu, " ")
    .replace(/\b(залізнична|железнодорожная)\b/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
}

export function stationAliasVariants(value) {
  const normalized = normalizeStationAlias(value), variants = new Set();
  if (!normalized) return variants;
  variants.add(normalized);
  const withoutPassengerSuffix = normalized
    .replace(/-(пас|пасажирський|пасс|пассажирский|головний|главный)$/u, "")
    .replace(/-(пас|пасс)$/u, "");
  if (withoutPassengerSuffix.length >= 3) variants.add(withoutPassengerSuffix);
  variants.add(normalized.replace(/-(\d+)$/u, "$1"));
  return variants;
}

export function haversineKm(left, right) {
  const [leftLongitude, leftLatitude] = left || [], [rightLongitude, rightLatitude] = right || [];
  if (![leftLongitude, leftLatitude, rightLongitude, rightLatitude].every(Number.isFinite)) return Infinity;
  const radians = (value) => value * Math.PI / 180;
  const latitudeDistance = radians(rightLatitude - leftLatitude), longitudeDistance = radians(rightLongitude - leftLongitude);
  const a = Math.sin(latitudeDistance / 2) ** 2 + Math.cos(radians(leftLatitude)) * Math.cos(radians(rightLatitude)) * Math.sin(longitudeDistance / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const elementKey = (element) => `${element.type}/${element.id}`;
const aliasFields = ["name", "name:uk", "name:ru", "name:en", "official_name", "short_name", "alt_name", "loc_name", "ref"];

export function mergeOverpassElements(collections = []) {
  const merged = new Map();
  for (const collection of collections) for (const element of collection?.elements || []) {
    const key = elementKey(element), previous = merged.get(key);
    merged.set(key, previous ? { ...element, ...previous, tags: { ...(element.tags || {}), ...(previous.tags || {}) }, nodes: previous.nodes || element.nodes } : element);
  }
  return [...merged.values()];
}

function coordinatesForElement(element, nodeById) {
  if (element.type === "node" && insideBounds(Number(element.lat), Number(element.lon))) return [Number(element.lon), Number(element.lat)];
  const coordinates = (element.nodes || []).map((id) => nodeById.get(String(id))).filter(Boolean);
  if (!coordinates.length) return null;
  return [coordinates.reduce((sum, point) => sum + point[0], 0) / coordinates.length, coordinates.reduce((sum, point) => sum + point[1], 0) / coordinates.length];
}

function pushAlias(station, value, { language = null, type = "name", source = "reviewed", confidence = 1 } = {}) {
  if (!value) return;
  const key = normalizeStationAlias(value);
  if (!key || station.aliases.some((item) => item.key === key && item.value === value)) return;
  station.aliases.push({ key, value: String(value), language, type, source, confidence });
}

function reviewedStation(value) {
  const coordinates = [Number(value.coordinates?.[0]), Number(value.coordinates?.[1])];
  const station = { stationId:String(value.id),officialName:String(value.name),stationType:value.stationType || "station",coordinates,osmType:null,osmId:null,graphNodeId:null,matchMethod:"reviewed",matchConfidence:1,aliases:[],metadata:{reviewed:true} };
  pushAlias(station, value.id, { type:"canonical_id" }); pushAlias(station, value.name);
  for (const alias of value.aliases || []) pushAlias(station, alias);
  return station;
}

export function buildStationRegistry({ reviewedStations = [], osmElements = [] } = {}) {
  const nodeById = new Map(osmElements.filter((item) => item.type === "node" && insideBounds(Number(item.lat), Number(item.lon))).map((item) => [String(item.id), [Number(item.lon), Number(item.lat)]]));
  const stations = reviewedStations.map(reviewedStation), reviewedAliasIndex = new Map();
  for (const station of stations) for (const alias of station.aliases) for (const variant of stationAliasVariants(alias.value)) {
    const group = reviewedAliasIndex.get(variant) || []; group.push(station); reviewedAliasIndex.set(variant, group);
  }
  const excludedStationModes=new Set(["tram","subway","light_rail","monorail","funicular"]);
  const osmStations = osmElements.filter((element) => STATION_TAGS.has(element.tags?.railway) && element.tags?.train!=="no" && !excludedStationModes.has(element.tags?.station) && aliasFields.some((field) => element.tags?.[field]));
  for (const element of osmStations) {
    const coordinates = coordinatesForElement(element, nodeById); if (!coordinates) continue;
    const names = aliasFields.flatMap((field) => String(element.tags?.[field] || "").split(";").map((value) => ({ field, value:value.trim() })).filter((item) => item.value));
    const exact = new Set();
    for (const name of names) for (const variant of stationAliasVariants(name.value)) for (const candidate of reviewedAliasIndex.get(variant) || []) exact.add(candidate);
    let station = exact.size === 1 ? [...exact][0] : null, matchMethod = station ? "osm-name" : null, matchConfidence = station ? .99 : 0;
    if (!station) {
      const nearby = stations.map((candidate) => ({ candidate, distance:haversineKm(candidate.coordinates, coordinates) })).filter((item) => item.distance <= .75).sort((left, right) => left.distance - right.distance);
      if (nearby.length === 1) { station = nearby[0].candidate; matchMethod = "osm-proximity"; matchConfidence = Math.max(.85, 1 - nearby[0].distance / 5); }
    }
    if (!station) {
      const officialName = element.tags["name:uk"] || element.tags.name || element.tags["name:ru"] || element.tags.ref;
      station = { stationId:`osm-${element.type}-${element.id}`,officialName,stationType:element.tags.railway,coordinates,osmType:element.type,osmId:String(element.id),graphNodeId:null,matchMethod:"osm-new",matchConfidence:.9,aliases:[],metadata:{reviewed:false} };
      stations.push(station);
    } else {
      station.osmType = element.type; station.osmId = String(element.id); station.matchMethod = matchMethod; station.matchConfidence = Math.max(station.matchConfidence, matchConfidence); station.metadata.osmMatched = true;
      if (element.type === "node") station.graphNodeId = String(element.id);
    }
    for (const name of names) pushAlias(station, name.value, { language:name.field.startsWith("name:") ? name.field.slice(5) : null, type:name.field, source:"openstreetmap", confidence:matchConfidence || .9 });
  }
  const aliasOwners = new Map();
  for (const station of stations) for (const alias of station.aliases) {
    const owners = aliasOwners.get(alias.key) || new Set(); owners.add(station.stationId); aliasOwners.set(alias.key, owners);
  }
  const conflicts = [...aliasOwners].filter(([, owners]) => owners.size > 1).map(([aliasKey, owners]) => ({ aliasKey, stationIds:[...owners] }));
  const conflictKeys = new Set(conflicts.map((item) => item.aliasKey));
  for (const station of stations) station.aliases = station.aliases.filter((alias) => !conflictKeys.has(alias.key));
  return { stations, conflicts };
}

class MinHeap {
  constructor() { this.values = []; }
  push(value) { this.values.push(value); let index=this.values.length-1; while(index>0){const parent=(index-1)>>1;if(this.values[parent].distance<=value.distance)break;this.values[index]=this.values[parent];index=parent;}this.values[index]=value; }
  pop() { if(!this.values.length)return null;const first=this.values[0],last=this.values.pop();if(this.values.length){let index=0;while(true){const left=index*2+1,right=left+1;if(left>=this.values.length)break;let child=right<this.values.length&&this.values[right].distance<this.values[left].distance?right:left;if(this.values[child].distance>=last.distance)break;this.values[index]=this.values[child];index=child;}this.values[index]=last;}return first; }
  get size() { return this.values.length; }
}

function spatialKey(longitude, latitude, cellSize = .1) { return `${Math.floor(longitude / cellSize)}:${Math.floor(latitude / cellSize)}`; }

function nearestRailNode(coordinates, spatialIndex, nodeById, maximumKm = 5) {
  const [longitude, latitude] = coordinates, centerLongitude=Math.floor(longitude/.1),centerLatitude=Math.floor(latitude/.1);let best=null;
  for(let radius=0;radius<=2;radius+=1)for(let x=centerLongitude-radius;x<=centerLongitude+radius;x+=1)for(let y=centerLatitude-radius;y<=centerLatitude+radius;y+=1)for(const nodeId of spatialIndex.get(`${x}:${y}`)||[]){const distance=haversineKm(coordinates,nodeById.get(nodeId));if(distance<=maximumKm&&(!best||distance<best.distance))best={nodeId,distance};}
  return best;
}

function perpendicularDistance(point, start, end) {
  const [x,y]=point,[x1,y1]=start,[x2,y2]=end,dx=x2-x1,dy=y2-y1;if(dx===0&&dy===0)return Math.hypot(x-x1,y-y1);const t=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy)));return Math.hypot(x-(x1+t*dx),y-(y1+t*dy));
}

export function simplifyGeometry(points, tolerance = .00012) {
  if (points.length <= 2) return points;
  let maximum=0,index=0;for(let current=1;current<points.length-1;current+=1){const distance=perpendicularDistance(points[current],points[0],points.at(-1));if(distance>maximum){maximum=distance;index=current;}}
  if(maximum<=tolerance)return [points[0],points.at(-1)];
  return [...simplifyGeometry(points.slice(0,index+1),tolerance).slice(0,-1),...simplifyGeometry(points.slice(index),tolerance)];
}

export function buildRailGraph({ osmElements = [], registry, maximumSegmentKm = 250, maximumNeighbors = 12 } = {}) {
  const nodeById=new Map(osmElements.filter((item)=>item.type==="node"&&insideBounds(Number(item.lat),Number(item.lon))).map((item)=>[String(item.id),[Number(item.lon),Number(item.lat)]]));
  const ways=osmElements.filter((item)=>item.type==="way"&&TRACK_TAGS.has(item.tags?.railway)&&Array.isArray(item.nodes)&&item.nodes.length>=2),adjacency=new Map(),railNodeIds=new Set();
  const addEdge=(from,to,way)=>{const fromPoint=nodeById.get(from),toPoint=nodeById.get(to);if(!fromPoint||!toPoint)return;const distance=haversineKm(fromPoint,toPoint);if(!(distance>0&&distance<25))return;const group=adjacency.get(from)||[];group.push({to,distance,wayId:String(way.id),railwayType:way.tags.railway,usage:way.tags.usage||null,tracks:Number(way.tags.tracks)||null,electrified:way.tags.electrified||null});adjacency.set(from,group);railNodeIds.add(from);railNodeIds.add(to);};
  for(const way of ways){for(let index=1;index<way.nodes.length;index+=1){const from=String(way.nodes[index-1]),to=String(way.nodes[index]);addEdge(from,to,way);addEdge(to,from,way);}}
  const spatialIndex=new Map();for(const nodeId of railNodeIds){const point=nodeById.get(nodeId),key=spatialKey(point[0],point[1]),group=spatialIndex.get(key)||[];group.push(nodeId);spatialIndex.set(key,group);}
  const stationIdsAtNode=new Map(),unmatchedStations=[];
  for(const station of registry.stations){let snap=station.graphNodeId&&railNodeIds.has(String(station.graphNodeId))?{nodeId:String(station.graphNodeId),distance:0}:nearestRailNode(station.coordinates,spatialIndex,nodeById);if(!snap){unmatchedStations.push(station.stationId);continue;}station.graphNodeId=snap.nodeId;station.metadata={...station.metadata,graphSnapDistanceKm:Number(snap.distance.toFixed(3))};const group=stationIdsAtNode.get(snap.nodeId)||[];group.push(station.stationId);stationIdsAtNode.set(snap.nodeId,group);}
  const segments=new Map();
  for(const station of registry.stations){const start=station.graphNodeId;if(!start||!adjacency.has(start))continue;const heap=new MinHeap(),distanceByNode=new Map([[start,0]]),previous=new Map();heap.push({nodeId:start,distance:0});let found=0;
    while(heap.size&&found<maximumNeighbors){const current=heap.pop();if(current.distance!==distanceByNode.get(current.nodeId)||current.distance>maximumSegmentKm)continue;const destinations=(stationIdsAtNode.get(current.nodeId)||[]).filter((id)=>id!==station.stationId);if(destinations.length){for(const destinationId of destinations){const path=[],wayIds=new Set();let cursor=current.nodeId;while(cursor){path.push(cursor);const step=previous.get(cursor);if(!step)break;wayIds.add(step.edge.wayId);cursor=step.nodeId;}path.reverse();const coordinates=simplifyGeometry(path.map((id)=>nodeById.get(id)).filter(Boolean));if(coordinates.length>=2){const key=`${station.stationId}>${destinationId}`,existing=segments.get(key);if(!existing||current.distance<existing.distanceKm)segments.set(key,{segmentId:key,fromStationId:station.stationId,toStationId:destinationId,geometry:{type:"LineString",coordinates},distanceKm:Number(current.distance.toFixed(3)),railwayType:"rail",sourceWayIds:[...wayIds],geometryQuality:.98});}}found+=destinations.length;continue;}
      for(const edge of adjacency.get(current.nodeId)||[]){const nextDistance=current.distance+edge.distance;if(nextDistance>=Number(distanceByNode.get(edge.to)??Infinity)||nextDistance>maximumSegmentKm)continue;distanceByNode.set(edge.to,nextDistance);previous.set(edge.to,{nodeId:current.nodeId,edge});heap.push({nodeId:edge.to,distance:nextDistance});}
    }
  }
  const undirectedSegments=new Map();for(const segment of segments.values()){const pair=[segment.fromStationId,segment.toStationId].sort(),key=`${pair[0]}<->${pair[1]}`,existing=undirectedSegments.get(key);if(existing&&existing.distanceKm<=segment.distanceKm)continue;const canonicalDirection=segment.fromStationId===pair[0],geometry=canonicalDirection?segment.geometry:{...segment.geometry,coordinates:[...segment.geometry.coordinates].reverse()};undirectedSegments.set(key,{...segment,segmentId:key,fromStationId:pair[0],toStationId:pair[1],geometry,bidirectional:true});}
  return { stations:registry.stations,segments:[...undirectedSegments.values()],unmatchedStations,stats:{osmNodes:nodeById.size,railWays:ways.length,railNodes:railNodeIds.size,matchedStations:registry.stations.length-unmatchedStations.length,unmatchedStations:unmatchedStations.length,segments:undirectedSegments.size} };
}
