/** Pure geospatial helpers and the train position estimator. */

const EARTH_RADIUS_KM = 6371.0088;

export const POSITION_STATUSES = {
  confirmed: { label: "Подтверждено", color: "#48d9e6" },
  estimated: { label: "Расчётное положение", color: "#ff9d52" },
  reported: { label: "Сообщено", color: "#f2ce61" },
  stale: { label: "Устарело", color: "#82919a" },
  unknown: { label: "Неизвестно", color: "#667783" },
};

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function haversineKm(a, b) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function buildRouteMeasure(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulative.push(cumulative[index - 1] + haversineKm(coordinates[index - 1], coordinates[index]));
  }
  return { coordinates, cumulative, totalKm: cumulative.at(-1) };
}

export function interpolateAlongRoute(measure, distanceKm) {
  if (!measure) return null;
  const target = clamp(distanceKm, 0, measure.totalKm);
  let index = 1;
  while (index < measure.cumulative.length && measure.cumulative[index] < target) index += 1;
  if (index >= measure.coordinates.length) return [...measure.coordinates.at(-1)];
  const startDistance = measure.cumulative[index - 1];
  const segmentLength = Math.max(measure.cumulative[index] - startDistance, Number.EPSILON);
  const ratio = (target - startDistance) / segmentLength;
  const start = measure.coordinates[index - 1];
  const end = measure.coordinates[index];
  return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
}

/** Approximate point-to-LineString projection, adequate for route station anchors. */
export function projectDistanceOnRoute(measure, point) {
  if (!measure || !Array.isArray(point)) return null;
  const referenceLat = (point[1] * Math.PI) / 180;
  const scaleX = Math.cos(referenceLat);
  let best = { squared: Infinity, distanceKm: 0 };

  for (let index = 1; index < measure.coordinates.length; index += 1) {
    const a = measure.coordinates[index - 1];
    const b = measure.coordinates[index];
    const ax = (a[0] - point[0]) * scaleX;
    const ay = a[1] - point[1];
    const bx = (b[0] - point[0]) * scaleX;
    const by = b[1] - point[1];
    const dx = bx - ax;
    const dy = by - ay;
    const ratio = clamp(-(ax * dx + ay * dy) / Math.max(dx * dx + dy * dy, Number.EPSILON));
    const px = ax + dx * ratio;
    const py = ay + dy * ratio;
    const squared = px * px + py * py;
    if (squared < best.squared) {
      const segmentKm = measure.cumulative[index] - measure.cumulative[index - 1];
      best = { squared, distanceKm: measure.cumulative[index - 1] + segmentKm * ratio };
    }
  }
  return best.distanceKm;
}

function eventTime(event) {
  if (event.actualAt) return new Date(event.actualAt).getTime();
  const planned = new Date(event.plannedAt).getTime();
  return planned + (event.delayMinutes || 0) * 60_000;
}

function eventDistance(event, measure) {
  if (Number.isFinite(event.routeDistanceKm)) return clamp(event.routeDistanceKm, 0, measure.totalKm);
  return projectDistanceOnRoute(measure, event.coordinates);
}

function directPosition(train, nowMs, staleAfterMinutes) {
  const position = train.position;
  if (!position?.coordinates || !position.updatedAt || position.status === "estimated") return null;
  const ageMinutes = (nowMs - new Date(position.updatedAt).getTime()) / 60_000;
  const status = ageMinutes > staleAfterMinutes ? "stale" : (position.status || "confirmed");
  return {
    ...position,
    status,
    confidence: status === "stale" ? Math.min(position.confidence ?? 0.35, 0.35) : (position.confidence ?? (status === "reported" ? 0.78 : 0.98)),
    errorKm: position.errorKm ?? (status === "confirmed" ? 0.05 : status === "reported" ? 0.8 : 5),
    method: position.method || (status === "reported" ? "infrastructure-report" : "direct-position-feed"),
    lastConfirmedAt: position.lastConfirmedAt || (position.status === "confirmed" ? position.updatedAt : null),
    sources: position.sources || [train.source || "position-feed"],
  };
}

export function estimateTrainPosition(train, routeFeature, now = new Date(), options = {}) {
  const staleAfterMinutes = options.staleAfterMinutes ?? 12;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const direct = directPosition(train, nowMs, staleAfterMinutes);
  if (direct) return direct;

  const coordinates = routeFeature?.geometry?.coordinates;
  const measure = buildRouteMeasure(coordinates);
  const schedule = (train.schedule || [])
    .filter((event) => event.plannedAt && (event.coordinates || Number.isFinite(event.routeDistanceKm)))
    .map((event) => ({ ...event, calculatedAt: eventTime(event) }))
    .sort((a, b) => a.calculatedAt - b.calculatedAt);

  if (!measure || schedule.length < 2 || !Number.isFinite(nowMs)) {
    return unknownPosition(train.position, "insufficient-route-or-schedule");
  }

  let previous = null;
  let next = null;
  for (const event of schedule) {
    if (event.calculatedAt <= nowMs) previous = event;
    if (event.calculatedAt > nowMs) { next = event; break; }
  }

  if (!previous || !next) {
    const nearest = previous || next;
    const ageMinutes = nearest ? Math.abs(nowMs - nearest.calculatedAt) / 60_000 : Infinity;
    if (nearest && ageMinutes <= staleAfterMinutes) {
      const distanceKm = eventDistance(nearest, measure);
      return {
        status: nearest.eventStatus === "reported" ? "reported" : "stale",
        coordinates: interpolateAlongRoute(measure, distanceKm),
        updatedAt: new Date(nearest.calculatedAt).toISOString(),
        confidence: nearest.eventStatus === "reported" ? 0.72 : 0.32,
        errorKm: nearest.eventStatus === "reported" ? 0.9 : 4,
        method: "nearest-route-event",
        lastConfirmedAt: nearest.eventStatus === "confirmed" ? new Date(nearest.calculatedAt).toISOString() : null,
        sources: ["schedule", "rail-geometry", nearest.eventStatus || "event"],
      };
    }
    return unknownPosition(train.position, "outside-known-schedule-window");
  }

  const startKm = eventDistance(previous, measure);
  const endKm = eventDistance(next, measure);
  if (!Number.isFinite(startKm) || !Number.isFinite(endKm)) return unknownPosition(train.position, "route-anchor-failed");

  const windowMs = Math.max(next.calculatedAt - previous.calculatedAt, 1);
  const progress = clamp((nowMs - previous.calculatedAt) / windowMs);
  const distanceKm = startKm + (endKm - startKm) * progress;
  const lastConfirmed = [...schedule]
    .reverse()
    .find((event) => event.calculatedAt <= nowMs && event.eventStatus === "confirmed");
  const lastConfirmedAt = lastConfirmed ? new Date(lastConfirmed.calculatedAt).toISOString() : train.position?.lastConfirmedAt || null;

  const gapHours = windowMs / 3_600_000;
  const confirmationAgeHours = lastConfirmedAt ? Math.max(0, nowMs - new Date(lastConfirmedAt).getTime()) / 3_600_000 : 8;
  const delayMinutes = Math.max(Math.abs(previous.delayMinutes || 0), Math.abs(next.delayMinutes || 0));
  const eventQuality = previous.eventStatus === "confirmed" ? 0.96 : previous.eventStatus === "reported" ? 0.84 : 0.7;
  const geometryQuality = train.geometryQuality ?? routeFeature.properties?.quality ?? 0.9;
  const confidence = clamp(
    eventQuality * 0.55 + geometryQuality * 0.35 + 0.1
      - Math.min(0.27, gapHours * 0.07)
      - Math.min(0.25, confirmationAgeHours * 0.035)
      - Math.min(0.14, delayMinutes / 300),
    0.08,
    0.97,
  );
  const segmentKm = Math.abs(endKm - startKm);
  const errorKm = Math.max(0.4, Math.min(80, 0.35 + segmentKm * (1 - confidence) * 0.32));

  return {
    status: "estimated",
    coordinates: interpolateAlongRoute(measure, distanceKm),
    updatedAt: now.toISOString(),
    confidence: Number(confidence.toFixed(2)),
    errorKm: Number(errorKm.toFixed(1)),
    method: "schedule-route-interpolation",
    lastConfirmedAt,
    sources: ["schedule", "station-event", "delay-feed", "rail-geometry"],
    calculation: {
      progress: Number(progress.toFixed(3)),
      fromEventId: previous.id,
      toEventId: next.id,
      fromDistanceKm: Number(startKm.toFixed(2)),
      toDistanceKm: Number(endKm.toFixed(2)),
    },
  };
}

export function unknownPosition(previous = {}, reason = "insufficient-data") {
  return {
    status: "unknown",
    coordinates: previous?.coordinates || null,
    updatedAt: previous?.updatedAt || null,
    confidence: 0,
    errorKm: null,
    method: reason,
    lastConfirmedAt: previous?.lastConfirmedAt || null,
    sources: previous?.sources || [],
  };
}

export function resolveVesselPosition(vessel, now = new Date(), staleAfterMinutes = 20) {
  const position = vessel.position;
  if (!position?.coordinates) return unknownPosition(position, "no-ais-position");
  const ageMinutes = position.updatedAt ? (now.getTime() - new Date(position.updatedAt).getTime()) / 60_000 : Infinity;
  const status = ageMinutes > staleAfterMinutes ? "stale" : (position.status || "confirmed");
  return {
    ...position,
    status,
    confidence: status === "stale" ? Math.min(position.confidence ?? 0.3, 0.3) : (position.confidence ?? 0.98),
    errorKm: position.errorKm ?? (status === "confirmed" ? 0.1 : 3),
    method: position.method || "ais-position-report",
    lastConfirmedAt: position.lastConfirmedAt || position.updatedAt,
    sources: position.sources || ["AIS"],
  };
}

