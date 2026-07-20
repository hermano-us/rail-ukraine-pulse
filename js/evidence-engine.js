import { buildRouteMeasure, haversineKm, interpolateAlongRoute, projectDistanceOnRoute } from "./positioning.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function buildOfficialEvents(update, runId) {
  const base = {
    runId,
    occurredAt: update.updatedAt,
    receivedAt: update.updatedAt,
    sourceId: "uz-delay-dashboard",
    sourceLabel: "Укрзалізниця",
    authority: "official",
    confidence: 1,
  };
  return [
    { ...base, id: `${runId}:status:${update.updatedAt}`, type: "movement_status", label: "Статус движения", value: update.publicStatus || "Не указан" },
    { ...base, id: `${runId}:delay:${update.updatedAt}`, type: "delay", label: "Задержка", value: update.delayLabel || "Не указана", numericValue: update.delayMinutes },
    update.forecastDeparture ? { ...base, id: `${runId}:departure-forecast:${update.updatedAt}`, type: "forecast_departure", label: "Прогноз отправления", value: update.forecastDeparture } : null,
    update.forecastArrival ? { ...base, id: `${runId}:arrival-forecast:${update.updatedAt}`, type: "forecast_arrival", label: "Прогноз прибытия", value: update.forecastArrival } : null,
    update.reason && update.reason !== "—" ? { ...base, id: `${runId}:reason:${update.updatedAt}`, type: "disruption_reason", label: "Причина изменения графика", value: update.reason } : null,
  ].filter(Boolean);
}

function routeSlice(measure, startKm, endKm) {
  if (!measure) return [];
  const start = clamp(startKm, 0, measure.totalKm);
  const end = clamp(endKm, start, measure.totalKm);
  const points = [interpolateAlongRoute(measure, start)];
  for (let index = 1; index < measure.coordinates.length - 1; index += 1) {
    if (measure.cumulative[index] > start && measure.cumulative[index] < end) points.push(measure.coordinates[index]);
  }
  points.push(interpolateAlongRoute(measure, end));
  return points;
}

export function buildUncertaintyCorridor(position, coordinates) {
  const measure = buildRouteMeasure(coordinates);
  const progress = position?.calculation?.progress;
  if (!measure || !Number.isFinite(progress) || !Number.isFinite(position?.errorKm)) return null;
  const centerKm = measure.totalKm * clamp(progress, 0, 1);
  const radiusKm = Math.max(2, position.errorKm);
  const fromKm = clamp(centerKm - radiusKm, 0, measure.totalKm);
  const toKm = clamp(centerKm + radiusKm, 0, measure.totalKm);
  return {
    fromKm: Number(fromKm.toFixed(1)),
    toKm: Number(toKm.toFixed(1)),
    centerKm: Number(centerKm.toFixed(1)),
    totalKm: Number(measure.totalKm.toFixed(1)),
    widthKm: Number((toKm - fromKm).toFixed(1)),
    coordinates: routeSlice(measure, fromKm, toKm),
    method: "confidence-bounded-rail-corridor-v1",
  };
}

export function buildGeometricWaypoints(coordinates, stations = [], corridor = null) {
  const measure = buildRouteMeasure(coordinates);
  if (!measure) return { waypoints: [], previous: null, next: null };
  const projected = stations.map((station) => {
    const distanceKm = projectDistanceOnRoute(measure, station.coordinates);
    const routePoint = interpolateAlongRoute(measure, distanceKm);
    const offsetKm = haversineKm(routePoint, station.coordinates);
    return { ...station, distanceKm: Number(distanceKm.toFixed(1)), offsetKm: Number(offsetKm.toFixed(1)) };
  }).filter((station) => station.offsetKm <= (station.routeToleranceKm || 18))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .filter((station, index, items) => index === 0 || station.distanceKm - items[index - 1].distanceKm >= 18);

  if (!corridor) return { waypoints: projected, previous: null, next: null };
  const waypoints = projected.map((station) => ({
    ...station,
    phase: station.distanceKm < corridor.fromKm ? "behind-model" : station.distanceKm <= corridor.toKm ? "inside-corridor" : "ahead-model",
    evidence: "rail-geometry",
  }));
  return {
    waypoints,
    previous: [...waypoints].reverse().find((station) => station.distanceKm < corridor.fromKm) || null,
    next: waypoints.find((station) => station.distanceKm > corridor.toKm) || null,
  };
}

export function hydrateSourceRegistry(catalog = [], runtime = {}, now = new Date()) {
  return catalog.map((source) => {
    const live = runtime[source.id] || {};
    const checkedAt = live.checkedAt || source.checkedAt || null;
    const ageMinutes = checkedAt ? Math.max(0, (now.getTime() - Date.parse(checkedAt)) / 60_000) : null;
    const catalogCapabilities=Array.isArray(source.capabilities)?source.capabilities:[];
    const runtimeCapabilities=live.capabilities&& !Array.isArray(live.capabilities)?live.capabilities:null;
    return {
      ...source,
      ...live,
      capabilities:Array.isArray(live.capabilities)?live.capabilities:catalogCapabilities,
      runtimeCapabilities,
      checkedAt,
      ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(1)) : null,
      state: live.status || source.state || "planned",
    };
  }).sort((a, b) => (a.priority || 99) - (b.priority || 99));
}

export function sourceRegistrySummary(sources = []) {
  const connected = sources.filter((source) => ["online", "snapshot", "archive"].includes(source.state)).length;
  const official = sources.filter((source) => source.authority === "official").length;
  const realtime = sources.filter((source) => Array.isArray(source.capabilities) && source.capabilities.includes("position") && source.state === "online").length;
  return { total: sources.length, connected, official, realtime };
}
