import { estimateTrainPosition, resolveVesselPosition } from "./positioning.js";

async function readJson(url, optional = false) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    if (optional && response.status === 404) return null;
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

function shiftedDataset(dataset) {
  if (!dataset?.demoMode) return dataset;
  const shiftMs = Date.now() - new Date(dataset.generatedAt).getTime();
  const timeKey = /(?:At|timestamp)$/;
  const walk = (value, key = "") => {
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, walk(child, childKey)]));
    if (typeof value === "string" && timeKey.test(key) && !Number.isNaN(Date.parse(value))) return new Date(Date.parse(value) + shiftMs).toISOString();
    return value;
  };
  return walk(dataset);
}

const PLACE_ALIASES = new Map(Object.entries({
  "львов":"lviv", "львів":"lviv", "днепр":"dnipro", "дніпро":"dnipro", "днепр-главный":"dnipro", "дніпро-головний":"dnipro",
  "киев":"kyiv", "київ":"kyiv", "київ-пас":"kyiv", "одесса":"odesa", "одеса":"odesa", "одеса-головна":"odesa",
  "харьков":"kharkiv", "харків":"kharkiv", "харків-пас":"kharkiv", "ужгород":"uzhhorod", "черновцы":"chernivtsi", "чернівці":"chernivtsi",
  "ивано-франковск":"ivano-frankivsk", "івано-франківськ":"ivano-frankivsk", "сумы":"sumy", "суми":"sumy", "чернигов":"chernihiv", "чернігів":"chernihiv",
  "херсон":"kherson", "николаев":"mykolaiv", "миколаїв":"mykolaiv", "миколаїв-пас":"mykolaiv", "запорожье":"zaporizhzhia", "запоріжжя-1":"zaporizhzhia",
}));

function canonicalPlace(value = "") {
  const normalized = value.toLocaleLowerCase("uk").replace(/[.№]/g, "").replace(/\s+/g, " ").trim();
  return PLACE_ALIASES.get(normalized) || normalized;
}

function routeEnds(route = "") {
  const parts = route.split(/\s*(?:→|—|–)\s*/).filter(Boolean);
  return parts.length >= 2 ? [canonicalPlace(parts[0]), canonicalPlace(parts.at(-1))] : [];
}

function selectUpdate(object, updateList = []) {
  if (!updateList.length) return undefined;
  const expected = routeEnds(object.route);
  const directional = updateList.filter((update) => update.origin && update.destination);
  if (expected.length === 2 && directional.length) {
    return directional.find((update) => {
      const actual = [canonicalPlace(update.origin), canonicalPlace(update.destination)];
      return actual[0] === expected[0] && actual[1] === expected[1];
    });
  }
  return updateList.at(-1);
}
function applyPublicUpdate(object, updateLists) {
  const update = selectUpdate(object, updateLists.get(String(object.trainNumber)) || []);
  if (!update) return object;
  return {
    ...object,
    schedule: (object.schedule || []).map((event) => ({
      ...event,
      delayMinutes: Number.isFinite(update.delayMinutes) ? update.delayMinutes : event.delayMinutes,
    })),
    operationalStatus: update.operationalStatus || object.operationalStatus,
    liveUpdate: update,
  };
}

function effectiveEventTime(event) {
  const base = Date.parse(event.actualAt || event.plannedAt || event.timestamp);
  if (!Number.isFinite(base)) return null;
  return base + (event.actualAt ? 0 : Number(event.delayMinutes || 0) * 60_000);
}

function journeyState(object, now) {
  const events = (object.schedule || []).map((event) => ({ ...event, effectiveMs: effectiveEventTime(event) })).filter((event) => Number.isFinite(event.effectiveMs)).sort((a, b) => a.effectiveMs - b.effectiveMs);
  if (!events.length) return { progress: null, lastEvent: null, nextEvent: null };
  const nowMs = now.getTime();
  let lastIndex = -1;
  for (let index = 0; index < events.length; index += 1) if (events[index].effectiveMs <= nowMs) lastIndex = index;
  const lastEvent = lastIndex >= 0 ? events[lastIndex] : null;
  const nextEvent = events[lastIndex + 1] || null;
  let progress = lastIndex < 0 ? 0 : nextEvent ? lastIndex / Math.max(1, events.length - 1) : 1;
  if (lastEvent && nextEvent && nextEvent.effectiveMs > lastEvent.effectiveMs) {
    const segment = Math.max(0, Math.min(1, (nowMs - lastEvent.effectiveMs) / (nextEvent.effectiveMs - lastEvent.effectiveMs)));
    progress = (lastIndex + segment) / Math.max(1, events.length - 1);
  }
  return {
    progress,
    lastEvent: lastEvent ? { ...lastEvent, timestamp: new Date(lastEvent.effectiveMs).toISOString(), evidence: lastEvent.actualAt ? "confirmed" : "model" } : null,
    nextEvent: nextEvent ? { ...nextEvent, timestamp: new Date(nextEvent.effectiveMs).toISOString(), evidence: nextEvent.actualAt ? "confirmed" : "schedule" } : null,
  };
}

function positionFor(object, route, now) {
  if (object.transport === "vessel") return resolveVesselPosition(object, now);
  const position = estimateTrainPosition(object, route, now, { staleAfterMinutes: 45 });
  if (position.status !== "estimated") return position;
  return {
    ...position,
    confidence: Math.min(position.confidence, 0.86),
    errorKm: Math.max(position.errorKm || 0, 8),
    method: "public-schedule-route-interpolation",
    sources: [...new Set([...(position.sources || []), "UZ public timetable scenario", "geoBoundaries / OSM corridor"])],
  };
}

export async function loadTransportData(now = new Date()) {
  const [trainDataRaw, vesselData, routes, regions, liveData, freightData] = await Promise.all([
    readJson("data/trains.json"), readJson("data/vessels.json"), readJson("data/railways.geojson"),
    readJson("data/regions.geojson"), readJson("data/live.json", true).catch(() => null),
    readJson("data/freight-aggregates.json", true).catch(() => null),
  ]);
  const trainData = shiftedDataset(trainDataRaw);
  const routeMap = new Map(routes.features.map((feature) => [feature.properties.id, feature]));
  const updateLists = new Map();
  for (const update of liveData?.updates || []) {
    const key = String(update.trainNumber);
    if (!updateLists.has(key)) updateLists.set(key, []);
    updateLists.get(key).push(update);
  }
  const trains = trainData.objects.map((object) => applyPublicUpdate(object, updateLists));
  const objects = [...trains, ...(vesselData.objects || [])].map((object) => ({
    ...object,
    journey: object.transport === "train" ? journeyState(object, now) : null,
    position: positionFor(object, routeMap.get(object.routeId), now),
  }));
  const regionList = [...new Map(regions.features.map((feature) => [feature.properties.id, {
    id: feature.properties.id, name: feature.properties.name,
  }])).values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));

  return {
    generatedAt: liveData?.generatedAt || trainData.generatedAt,
    dataMode: liveData?.updates?.length ? "public-status-plus-model" : trainData.dataMode,
    safetyNote: trainData.safetyNote,
    sourceStatus: liveData?.sourceStatus || { status: "demo", label: "Сценарный набор" },
    marineStatus: vesselData.sourceStatus,
    freightStatus: freightData?.sourceStatus || { status: "unavailable", label: "Грузовой агрегат не загружен" },
liveFeed: (liveData?.updates || []).map((update) => ({
      ...update,
      objectId: objects.find((object) => selectUpdate(object, [update]) === update)?.id || null,
    })),
    objects, routes, routeMap, regions, regionList,
  };
}

