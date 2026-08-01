const clean = (value = "") => String(value ?? "").toLocaleLowerCase("uk")
  .replace(/[№.]/g, "").replace(/\s+/g, " ").trim();
const keyPart = (value = "") => clean(value).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

function kyivServiceDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(Number.isFinite(date.getTime()) ? date : new Date());
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function endpointPair(update = {}) {
  const routeParts = String(update.route || "").split(/\s*(?:→|—|–|->)\s*/u).filter(Boolean);
  return {
    origin: update.origin || routeParts[0] || "",
    destination: update.destination || routeParts.at(-1) || "",
  };
}

export function canonicalServiceKey(update = {}, now = new Date()) {
  const scheduled = Date.parse(update.scheduledStationAt || "");
  const observed = Date.parse(update.updatedAt || "");
  const serviceDate = kyivServiceDate(new Date(Number.isFinite(scheduled) ? scheduled : Number.isFinite(observed) ? observed : now));
  const endpoints = endpointPair(update);
  const direction = `${keyPart(endpoints.origin)}--${keyPart(endpoints.destination)}`;
  const fallback = keyPart(update.route || update.boardStation || "unknown-route");
  const trainNumber = String(update.trainNumber || "unknown").trim().replace(/\s+/g, "");
  return `uz:${serviceDate}:${trainNumber}:${direction === "--" ? fallback : direction}`;
}

const evidenceRank = (update = {}) => {
  if (update.positionEvidence === "reported-station-passage") return 600;
  if (update.operationalStatus === "depot") return 560;
  if (update.positionEvidence === "station-board-window") return 520;
  if (update.operationalStatus === "moving" && update.forecastArrival) return 430;
  if (update.operationalStatus === "moving") return 360;
  if (update.positionEvidence === "schedule-only") return 180;
  return 240;
};

function stationCall(update = {}) {
  const station = update.reportedStation || update.boardStation;
  if (!station) return null;
  return {
    station, boardType: update.boardType || null, scheduledAt: update.scheduledStationAt || null,
    observedAt: update.updatedAt || null, phase: update.stationWindowPhase || null,
    evidence: update.positionEvidence || "none", sourceId: update.sourceId || null,
  };
}

export function fuseServiceUpdates(updates = [], now = new Date()) {
  const groups = new Map();
  for (const update of updates) {
    if (!update?.trainNumber) continue;
    const key = canonicalServiceKey(update, now);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(update);
  }
  return [...groups.entries()].map(([canonicalServiceId, observations]) => {
    const ordered = [...observations].sort((left, right) =>
      evidenceRank(right) - evidenceRank(left) || Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
    const best = ordered[0];
    const merged = { ...best };
    for (const candidate of ordered) {
      for (const field of ["route", "origin", "destination", "forecastDeparture", "forecastArrival", "delayMinutes", "delayLabel", "reason", "reportedStation", "boardStation", "boardType", "scheduledStationAt", "stationWindowPhase", "stationWindowOffsetMinutes"]) {
        if ((merged[field] == null || merged[field] === "") && candidate[field] != null && candidate[field] !== "") merged[field] = candidate[field];
      }
    }
    const calls = ordered.map(stationCall).filter(Boolean);
    const uniqueCalls = [...new Map(calls.map((call) => [`${keyPart(call.station)}:${call.boardType}:${call.scheduledAt || call.observedAt}`, call])).values()]
      .sort((left, right) => Date.parse(left.scheduledAt || left.observedAt || 0) - Date.parse(right.scheduledAt || right.observedAt || 0));
    return {
      ...merged, canonicalServiceId, observationCount: observations.length,
      sourceIds: [...new Set(observations.map((item) => item.sourceId).filter(Boolean))],
      observations: ordered, stationCalls: uniqueCalls,
      hasOperationalObservation: observations.some((item) => item.positionEvidence !== "schedule-only" && item.operationalStatus !== "planned"),
      registryState: registryStateForUpdate(merged),
    };
  });
}

export function registryStateForUpdate(update = {}) {
  if (update.operationalStatus === "depot") return "depot";
  if (update.positionEvidence === "station-board-window") return update.boardType === "departure" ? "expected_at_station" : "at_station";
  if (update.positionEvidence === "reported-station-passage") return update.operationalStatus === "moving" ? "moving" : "at_station";
  if (update.operationalStatus === "moving") return "moving";
  if (update.positionEvidence === "schedule-only" || update.operationalStatus === "planned") return "planned";
  return "unobserved";
}

export function positionAdmission(update = {}, { hasRoute = false, sourceAgeMinutes = Infinity } = {}) {
  const evidence = update.positionEvidence || "none";
  const reportedStation = String(update.reportedStation || "").trim();
  const freshEnough = Number.isFinite(sourceAgeMinutes) && sourceAgeMinutes <= 180;
  if (!freshEnough) return { allowed: false, allowReported: false, allowCalculated: false, reasonCode: "source_expired", reason: "Источник устарел" };
  if (update.operationalStatus === "depot" && reportedStation) return { allowed: true, allowReported: true, allowCalculated: false, reasonCode: "confirmed_depot", reason: "Подтверждено нахождение в депо" };
  if (evidence === "reported-station-passage" && reportedStation) return { allowed: true, allowReported: true, allowCalculated: hasRoute && update.operationalStatus === "moving", reasonCode: "station_fact", reason: "Есть станционный факт" };
  if (evidence === "station-board-window" && reportedStation) return { allowed: true, allowReported: true, allowCalculated: false, reasonCode: "station_window", reason: "Поезд находится в актуальном окне станционного табло" };
  if (evidence === "schedule-only" || update.operationalStatus === "planned") return { allowed: false, allowReported: false, allowCalculated: false, reasonCode: "planned_only", reason: "Есть только расписание — факт отправления ещё не получен" };
  if (update.operationalStatus === "moving" && !hasRoute) return { allowed: false, allowReported: false, allowCalculated: false, reasonCode: "route_unavailable", reason: "Не построена железнодорожная геометрия маршрута" };
  if (update.operationalStatus === "moving" && !update.forecastArrival && !reportedStation) return { allowed: false, allowReported: false, allowCalculated: false, reasonCode: "forecast_unavailable", reason: "Нет станционного факта или прогноза прибытия" };
  if (update.operationalStatus === "moving" && hasRoute) return { allowed: true, allowReported: false, allowCalculated: true, reasonCode: "calculated_corridor", reason: "Допущен расчёт по маршруту и прогнозу" };
  return { allowed: false, allowReported: false, allowCalculated: false, reasonCode: "insufficient_evidence", reason: "Недостаточно данных для позиции" };
}

export function stationQueueForUpdate(update = {}, now = new Date()) {
  const station = update.reportedStation || update.boardStation || (update.operationalStatus === "depot" ? update.origin : null);
  if (!station) return null;
  if (update.operationalStatus === "depot") return { station, state: "depot", evidence: "confirmed", label: "В депо", confidence: .9 };
  if (update.positionEvidence === "station-board-window" && update.boardType === "departure") return { station, state: "waiting", evidence: "station-window", label: "Ожидается отправление", confidence: .66 };
  if (update.operationalStatus === "station" && update.reportedStation) return { station, state: "standing", evidence: "reported", label: "На станции", confidence: .78 };
  const scheduledAt = Date.parse(update.scheduledStationAt || "");
  const minutes = Number.isFinite(scheduledAt) ? (scheduledAt - now.getTime()) / 60_000 : Infinity;
  if (update.positionEvidence === "schedule-only" && update.boardType === "departure" && minutes >= -15 && minutes <= 120) {
    return { station, state: "scheduled", evidence: "schedule-only", label: "По расписанию, не подтверждено", confidence: .35 };
  }
  return null;
}

export function groupStationQueues(objects = []) {
  const groups = new Map();
  for (const object of objects) {
    const queue = object.stationQueue;
    if (!queue?.station || !Array.isArray(queue.coordinates)) continue;
    const key = keyPart(queue.station);
    if (!groups.has(key)) groups.set(key, { id: `station-queue:${key}`, station: queue.station, coordinates: queue.coordinates, entries: [] });
    groups.get(key).entries.push({
      objectId: object.id, trainNumber: object.trainNumber, route: object.route,
      state: queue.state, label: queue.label, evidence: queue.evidence,
      confidence: queue.confidence, scheduledAt: object.liveUpdate?.scheduledStationAt || null,
    });
  }
  return [...groups.values()].map((group) => ({
    ...group, entries: group.entries.sort((left, right) => Date.parse(left.scheduledAt || 0) - Date.parse(right.scheduledAt || 0)),
    confirmedCount: group.entries.filter((item) => ["depot", "standing"].includes(item.state)).length,
    waitingCount: group.entries.filter((item) => ["waiting", "scheduled"].includes(item.state)).length,
  })).sort((left, right) => right.entries.length - left.entries.length);
}
