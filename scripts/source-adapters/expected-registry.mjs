import { runIdFor, serviceDateFor } from "../../backend/src/domain/events.js";
import { normalizeTrainNumber, splitRoute } from "./html.mjs";

const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

const parseClock = (value, serviceDate) => {
  if (Number.isFinite(Date.parse(value || ""))) return new Date(value).toISOString();
  const match = String(value || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return match ? `${serviceDate}T${match[1].padStart(2, "0")}:${match[2]}:00+03:00` : null;
};

const updateKey = (trainNumber, route) => `${normalizeTrainNumber(trainNumber)}:${normalize(route)}`;

export function buildExpectedRuns(updates = [], boardRecords = [], generatedAt = new Date().toISOString()) {
  const result = new Map(), updateIndex = new Map();
  for (const update of updates) {
    if (!update?.trainNumber) continue;
    const key = updateKey(update.trainNumber, update.route);
    if (!updateIndex.has(key) || update.sourceId === "uz-public-board") updateIndex.set(key, update);
  }
  const add = (update, extra = {}) => {
    if (!update?.trainNumber) return;
    const serviceDate = serviceDateFor(update, generatedAt), runId = runIdFor(update, generatedAt);
    const current = result.get(runId) || {
      expectedId: `expected:${runId}`, runId, serviceDate, trainNumber: String(update.trainNumber),
      origin: update.origin || null, destination: update.destination || null, route: update.route || null,
      scheduledDeparture: null, scheduledArrival: null, sourceIds: [], discoveryCount: 0,
      metadata: { stations: [], stationCalls: [], boardObservationCount: 0 },
    };
    current.sourceIds = [...new Set([...current.sourceIds, update.sourceId || "unknown"])];
    current.discoveryCount += 1;
    if (extra.station) {
      if (!current.metadata.stations.some((station) => normalize(station) === normalize(extra.station))) current.metadata.stations.push(extra.station);
      const scheduledAt = update.scheduledStationAt || parseClock(extra.scheduledTime, serviceDate);
      const callKey = `${normalize(extra.station)}:${extra.boardType || "unknown"}:${scheduledAt || extra.scheduledTime || "unknown"}`;
      if (!current.metadata.stationCalls.some((call) => call.key === callKey)) current.metadata.stationCalls.push({
        key: callKey, station: extra.station, boardType: extra.boardType || null, scheduledAt,
        platform: extra.platform && extra.platform !== "–" ? extra.platform : null,
        observedAt: extra.observedAt || generatedAt,
      });
      current.metadata.boardObservationCount += 1;
      const stationKey = normalize(extra.station);
      if (extra.boardType === "departure" && stationKey === normalize(current.origin)) current.scheduledDeparture ||= scheduledAt;
      if (extra.boardType === "arrival" && stationKey === normalize(current.destination)) current.scheduledArrival ||= scheduledAt;
    }
    result.set(runId, current);
  };
  for (const update of updates) add(update);
  for (const record of boardRecords) {
    const route = splitRoute(record.route);
    const update = updateIndex.get(updateKey(record.trainNumber, route.route)) || [...updateIndex.values()].find((item) => normalizeTrainNumber(item.trainNumber) === normalizeTrainNumber(record.trainNumber) && normalize(item.origin) === normalize(route.origin) && normalize(item.destination) === normalize(route.destination)) || {
      trainNumber: record.trainNumber,
      route: route.route || record.route || null,
      origin: route.origin || null,
      destination: route.destination || null,
      sourceId: record.sourceId || "station-board-registry",
      updatedAt: record.observedAt || generatedAt,
      serviceDate: record.serviceDate || generatedAt.slice(0, 10),
      positionEvidence: "schedule-only",
    };
    add(update, record);
  }
  return [...result.values()].sort((left, right) => left.trainNumber.localeCompare(right.trainNumber, undefined, { numeric: true }));
}
