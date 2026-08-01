import { decodeHtml, fetchText, normalizeTrainNumber, parseDelayMinutes, splitRoute } from "./html.mjs";
import { classifyBoardWindow } from "./station-board-coverage.mjs";

export const ANYTRAIN_DELAY_URL = "https://anytrain.com.ua/tablo-zatrymok";
export const ANYTRAIN_STATIONS = [
  { id: "2200001", name: "Київ-Пас." },
  { id: "2218000", name: "Львів" },
  { id: "2204001", name: "Харків-Пас." },
  { id: "2208001", name: "Одеса-Головна" },
  { id: "2210700", name: "Дніпро-Головний" },
  { id: "2210800", name: "\u0417\u0430\u043f\u043e\u0440\u0456\u0436\u0436\u044f-1" },
];

const clean = (value = "") => decodeHtml(value).replace(/^[▲△]\s*/u, "").trim();
const classBody = (html, name) => html.match(new RegExp(`<[^>]+class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"))?.[1] || "";
const classText = (html, name) => clean(classBody(html, name));
const allClassBodies = (html, name) => [...html.matchAll(new RegExp(`<[^>]+class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "gi"))].map((match) => clean(match[1]));
const siblingClassTexts = (html, name, nextNames) => [...html.matchAll(new RegExp(
  `<span[^>]+class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>\\s*(?=<span[^>]+class=["'][^"']*\\b(?:${nextNames.join("|")})\\b)`,
  "gi",
))].map((match) => clean(match[1]));
const siblingClassText = (html, name, nextNames) => siblingClassTexts(html, name, nextNames)[0] || "";
const rowBodies = (html, station = false) => [...html.matchAll(/<div\s+class=["']([^"']*\bbrow\b[^"']*)["'][^>]*>([\s\S]*?)<\/div>/gi)]
  .filter((match) => !/\bbhead\b/i.test(match[1]) && (station ? /\bsbrow\b/i.test(match[1]) : !/\bsbrow\b/i.test(match[1])))
  .map((match) => match[2]);

function zonedClockToIso(clock, now = new Date(), timeZone = "Europe/Kyiv") {
  const match = String(clock || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match || !Number.isFinite(now.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const localBase = Date.UTC(parts.year, parts.month - 1, parts.day, Number(match[1]), Number(match[2]));
  const offsetAt = (instant) => {
    const value = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second) - instant;
  };
  const today = localBase - offsetAt(localBase);
  const candidates = [today - 86_400_000, today, today + 86_400_000].sort((left, right) => Math.abs(left - now) - Math.abs(right - now));
  const preferred = candidates.find((candidate) => candidate <= now.getTime() + 10 * 60_000) ?? candidates[0];
  return new Date(preferred).toISOString();
}

export function parseAnyTrainUpdatedAt(html, observedAt = new Date().toISOString()) {
  const label = classText(html, "live") || clean(html.match(/Дані\s+УЗ[\s\S]{0,80}?оновлено\s+\d{1,2}:\d{2}/iu)?.[0] || "");
  return zonedClockToIso(label, new Date(observedAt));
}

export function parseAnyTrainDelayBoard(html, observedAt = new Date().toISOString()) {
  const sourceUpdatedAt = parseAnyTrainUpdatedAt(html, observedAt) || observedAt;
  return rowBodies(html).map((body) => {
    const trainNumber = normalizeTrainNumber(classText(body, "bno"));
    const routeMatch = body.match(/<[^>]+class=["'][^"']*\bbrt\b[^"']*["'][^>]*>\s*<b[^>]*>([\s\S]*?)<\/b>/i);
    const route = splitRoute(clean(routeMatch?.[1] || classText(body, "brt")));
    const delayLabel = siblingClassText(body, "bdel", ["bst"]);
    const status = classText(body, "bst") || clean(classBody(body, "brt").match(/<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "В дорозі");
    const forecasts = allClassBodies(body, "beta").map((value) => value === "—" ? null : value.match(/\b\d{1,2}:\d{2}\b/)?.[0] || null);
    const reliability = clean(body.match(/title=["']Надійність прогнозу:\s*([^"']+)/iu)?.[1] || "Середня");
    const parsedForecasts = siblingClassTexts(body, "beta", ["beta", "bcause"]).map((value) => value.match(/\b\d{1,2}:\d{2}\b/)?.[0] || null);
    const reason = classText(body, "bcause");
    return {
      trainNumber, ...route, delayMinutes: parseDelayMinutes(delayLabel), delayLabel,
      publicStatus: status || "В дорозі", operationalStatus: /вокзал|станц|очіку/iu.test(status) ? "station" : "moving",
      forecastDeparture: parsedForecasts[0], forecastArrival: parsedForecasts[1], reliability,
      reason: reason && reason !== "—" ? reason : null, updatedAt: sourceUpdatedAt,
      source: ANYTRAIN_DELAY_URL, sourceId: "anytrain-uz-delay", sourceEvidence: "uz-derived-licensed-agent-board",
      positionEvidence: "none",
    };
  }).filter((update) => update.trainNumber && update.route && Number.isFinite(update.delayMinutes));
}

export function parseAnyTrainStationBoard(html, station, observedAt = new Date().toISOString()) {
  const sourceUpdatedAt = parseAnyTrainUpdatedAt(html, observedAt) || observedAt;
  const records = rowBodies(html, true).map((body) => {
    const routeText = clean(body.match(/<[^>]+class=["'][^"']*\bbrt\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    const scheduledTime = clean(body.match(/<[^>]+class=["'][^"']*\bsbtime\b[^"']*["'][^>]*>[\s\S]*?<b[^>]*>([\s\S]*?)<\/b>/i)?.[1] || "");
    const forecastTime = clean(body.match(/<[^>]+class=["'][^"']*\bsbtime\b[^"']*["'][^>]*>[\s\S]*?<i[^>]*>([\s\S]*?)<\/i>/i)?.[1] || "") || null;
    return {
      station, boardType: "departure", trainNumber: classText(body, "bno"), route: routeText,
      scheduledTime, forecastTime, platform: null, delayLabel: siblingClassText(body, "bdel", ["bcause"]),
      reason: classText(body, "bcause"), observedAt: sourceUpdatedAt,
    };
  }).filter((record) => normalizeTrainNumber(record.trainNumber) && record.route && /^\d{1,2}:\d{2}$/.test(record.scheduledTime));
  const updates = records.map((record) => {
    const route = splitRoute(record.route);
    const window = classifyBoardWindow({ ...record, scheduledTime: record.forecastTime || record.scheduledTime });
    const delayMinutes = parseDelayMinutes(record.delayLabel);
    return {
      trainNumber: normalizeTrainNumber(record.trainNumber), ...route, delayMinutes,
      delayLabel: Number.isFinite(delayMinutes) ? record.delayLabel : "",
      publicStatus: `Табло AnyTrain ${station}: відправлення ${record.forecastTime || record.scheduledTime}`,
      operationalStatus: window.isStationFact ? "station" : "planned",
      forecastDeparture: record.forecastTime || record.scheduledTime, forecastArrival: null,
      reliability: "Похідне табло УЗ", reason: record.reason && record.reason !== "—" ? record.reason : null,
      updatedAt: record.observedAt, source: `${ANYTRAIN_DELAY_URL.replace("tablo-zatrymok", "tablo-vokzalu")}`,
      sourceId: "anytrain-uz-station-board", sourceEvidence: "uz-derived-licensed-agent-station-board",
      positionEvidence: window.isStationFact ? "station-board-window" : "schedule-only",
      reportedStation: window.isStationFact ? station : null, boardStation: station, boardType: "departure",
      scheduledStationAt: window.scheduledAt, stationWindowPhase: window.phase, stationWindowOffsetMinutes: window.offsetMinutes,
    };
  });
  return { records, updates, sourceUpdatedAt };
}

const keepRecent = (items, now, hours) => (Array.isArray(items) ? items : []).filter((item) => {
  const age = Date.parse(now) - Date.parse(item?.updatedAt || item?.observedAt || "");
  return Number.isFinite(age) && age >= 0 && age <= hours * 3_600_000;
});

export async function collectAnyTrain({ previous = {}, fetchImpl = null, stationBudget = Number(process.env.ANYTRAIN_STATION_BUDGET || 2), stationOffset = previous.scheduler?.nextOffset || 0 } = {}) {
  const checkedAt = new Date().toISOString();
  if (process.env.ANYTRAIN_ENABLED === "0") return { status: { status: "disabled", checkedAt, label: "AnyTrain: отключён" }, records: [], updates: [], scheduler: { nextOffset: stationOffset } };
  const getText = fetchImpl ? async (url) => {
    const response = await fetchImpl(url, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(18_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } : (url) => fetchText(url, { timeoutMs: 18_000, headers: { Accept: "text/html" } });
  const failures = [], freshRecords = [], freshUpdates = [];
  let delayUpdates = [], sourceUpdatedAt = null, delayOnline = false;
  try {
    const html = await getText(ANYTRAIN_DELAY_URL);
    delayUpdates = parseAnyTrainDelayBoard(html, checkedAt);
    sourceUpdatedAt = parseAnyTrainUpdatedAt(html, checkedAt);
    if (!delayUpdates.length) throw new Error("delay board returned no parseable rows");
    delayOnline = true;
  } catch (error) { failures.push({ scope: "delay-board", error: String(error?.message || error).slice(0, 300) }); }
  const budget = Math.max(0, Math.min(ANYTRAIN_STATIONS.length, Number(stationBudget) || 0));
  const selected = Array.from({ length: budget }, (_, index) => ANYTRAIN_STATIONS[(Number(stationOffset) + index) % ANYTRAIN_STATIONS.length]);
  for (const station of selected) {
    try {
      const html = await getText(`https://anytrain.com.ua/tablo-vokzalu?station=${encodeURIComponent(station.id)}`);
      const parsed = parseAnyTrainStationBoard(html, station.name, checkedAt);
      if (!parsed.records.length) throw new Error("station board returned no parseable rows");
      freshRecords.push(...parsed.records); freshUpdates.push(...parsed.updates);
    } catch (error) { failures.push({ scope: `station:${station.id}`, error: String(error?.message || error).slice(0, 300) }); }
  }
  const refreshedStations = new Set(freshRecords.map((item) => item.station));
  const cachedRecords = keepRecent(previous.records, checkedAt, 4).filter((item) => !refreshedStations.has(item.station));
  const records = [...freshRecords, ...cachedRecords];
  const cachedStationUpdates = keepRecent(previous.updates, checkedAt, 4).filter((item) => item.sourceId === "anytrain-uz-station-board" && !refreshedStations.has(item.boardStation || item.reportedStation));
  if (!delayOnline) delayUpdates = keepRecent(previous.updates, checkedAt, 3).filter((item) => item.sourceId === "anytrain-uz-delay");
  const updates = [...delayUpdates, ...freshUpdates, ...cachedStationUpdates];
  const ageMinutes = sourceUpdatedAt ? Math.max(0, (Date.parse(checkedAt) - Date.parse(sourceUpdatedAt)) / 60_000) : null;
  const hasFreshStation = freshRecords.length > 0;
  const statusValue = delayOnline && Number.isFinite(ageMinutes) && ageMinutes <= 45 && (!budget || hasFreshStation) ? "online"
    : delayOnline || hasFreshStation ? "degraded" : updates.length ? "stale" : "unavailable";
  const scheduler = { strategy: "rotating-station-budget-v1", selectedStations: selected.map((item) => item.name), requestBudget: budget + 1, nextOffset: (Number(stationOffset) + budget) % ANYTRAIN_STATIONS.length };
  return {
    status: { status: statusValue, checkedAt, sourceUpdatedAt, lastSuccessfulAt: delayOnline || hasFreshStation ? checkedAt : previous.status?.lastSuccessfulAt || null,
      label: `AnyTrain: ${delayUpdates.length} задержек · ${freshRecords.length} строк табло`, error: failures.length ? failures.map((item) => `${item.scope}: ${item.error}`).join("; ").slice(0, 500) : null,
      capabilities: ["derived-uz-delay", "station-board", "forecast", "reason"], scheduler },
    records, updates, failures, scheduler,
  };
}
