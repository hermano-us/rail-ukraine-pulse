const EVENT_TYPES = new Set([
  "movement_status",
  "delay_update",
  "forecast_arrival",
  "forecast_departure",
  "station_report",
  "platform_update",
]);

export function normalizeToken(value = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("uk")
    .replace(/[.№]/g, "")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isoDate(value, fallback = null) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

export function serviceDateFor(update, observedAt = new Date().toISOString()) {
  return isoDate(update.serviceDate || update.updatedAt || observedAt, observedAt).slice(0, 10);
}

export function runIdFor(update, observedAt) {
  const trainNumber = normalizeToken(update.trainNumber).replace(/\s/g, "");
  const direction = normalizeToken(update.route || `${update.origin || ""}-${update.destination || ""}`)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return `uz:${serviceDateFor(update, observedAt)}:${trainNumber || "unknown"}:${direction || "unknown"}`;
}

function eventValue(update, type) {
  if (type === "movement_status") return update.publicStatus || update.operationalStatus;
  if (type === "delay_update") return Number.isFinite(Number(update.delayMinutes)) ? Number(update.delayMinutes) : update.delayLabel;
  if (type === "forecast_arrival") return update.forecastArrival;
  if (type === "forecast_departure") return update.forecastDeparture;
  if (type === "station_report") return update.reportedStation;
  if (type === "platform_update") return update.platform;
  return null;
}

function eventTypes(update) {
  return [
    update.publicStatus || update.operationalStatus ? "movement_status" : null,
    update.delayLabel || Number.isFinite(Number(update.delayMinutes)) ? "delay_update" : null,
    update.forecastArrival ? "forecast_arrival" : null,
    update.forecastDeparture ? "forecast_departure" : null,
    update.reportedStation ? "station_report" : null,
    update.platform ? "platform_update" : null,
  ].filter(Boolean);
}

function reliabilityFor(update, type) {
  const official = String(update.sourceId || "").startsWith("uz-");
  if (type === "station_report") {
    if (update.positionEvidence === "reported-station-passage") return 0.9;
    if (update.positionEvidence === "station-board-window") return 0.78;
  }
  if (official) return 0.82;
  return 0.58;
}

export function updateToEvents(update, options = {}) {
  if (!update?.trainNumber) return [];
  const observedAt = isoDate(options.observedAt || new Date(), new Date().toISOString());
  const occurredAt = isoDate(update.updatedAt, observedAt);
  const runId = runIdFor(update, observedAt);

  return eventTypes(update).map((type) => {
    const value = eventValue(update, type);
    const identity = [runId, type, normalizeToken(value), occurredAt, update.sourceId || "unknown"].join("|");
    return {
      eventId: `evt_${fnv1a(identity)}`,
      runId,
      trainNumber: String(update.trainNumber),
      serviceDate: serviceDateFor(update, observedAt),
      type,
      value,
      station: type === "station_report" ? String(update.reportedStation) : null,
      occurredAt,
      observedAt,
      sourceId: update.sourceId || "unknown",
      sourceUrl: update.sourceEventUrl || update.source || null,
      authority: String(update.sourceId || "").startsWith("uz-") ? "official" : "reference",
      reliability: reliabilityFor(update, type),
      positionEvidence: update.positionEvidence || "none",
      rawUpdate: update,
    };
  });
}

export function updatesToEvents(updates, options = {}) {
  const unique = new Map();
  for (const update of Array.isArray(updates) ? updates : []) {
    for (const event of updateToEvents(update, options)) unique.set(event.eventId, event);
  }
  return [...unique.values()];
}

export function validateEvent(event) {
  const errors = [];
  if (!String(event?.eventId || "").startsWith("evt_")) errors.push("eventId");
  if (!event?.runId) errors.push("runId");
  if (!event?.trainNumber) errors.push("trainNumber");
  if (!EVENT_TYPES.has(event?.type)) errors.push("type");
  if (!Number.isFinite(Date.parse(event?.occurredAt))) errors.push("occurredAt");
  if (!Number.isFinite(Date.parse(event?.observedAt))) errors.push("observedAt");
  if (!event?.sourceId) errors.push("sourceId");
  if (!(Number(event?.reliability) >= 0 && Number(event?.reliability) <= 1)) errors.push("reliability");
  return { valid: errors.length === 0, errors };
}

