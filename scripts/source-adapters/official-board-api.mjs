import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { rankBoardStations } from "./board-intelligence.mjs";

export const BOARD_API_BASE = "https://app.uz.gov.ua/api/station-boards";
export const BOARD_API_USER_AGENT = "UZ/2 Web/1 User/guest";

const normalize = (value) => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("uk-UA")
  .replace(/\u00a0/g, " ")
  .replace(/[^\p{L}\p{N}]+/gu, "-")
  .replace(/^-|-$/g, "");

const formatter = new Intl.DateTimeFormat("uk-UA", {
  timeZone: "Europe/Kyiv",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function scheduledAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function delayLabel(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  return `+${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export function apiBoardToRecords(payload, observedAt = new Date().toISOString()) {
  const station = String(payload?.station?.name || payload?.station || "").trim();
  if (!station) return [];
  const convert = (items, boardType) => (Array.isArray(items) ? items : []).map((item) => {
    const at = scheduledAt(item?.time);
    return {
      station,
      stationId: payload?.station?.id == null ? null : String(payload.station.id),
      boardType,
      trainNumber: String(item?.train || "").trim(),
      route: String(item?.route || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(),
      scheduledTime: at ? formatter.format(new Date(at)) : "",
      scheduledAt: at,
      platform: item?.platform == null ? null : String(item.platform),
      delayMinutes: Number.isFinite(Number(item?.delay_minutes)) ? Number(item.delay_minutes) : null,
      delayLabel: delayLabel(item?.delay_minutes),
      observedAt,
    };
  });
  return [...convert(payload?.departures, "departure"), ...convert(payload?.arrivals, "arrival")]
    .filter((record) => record.trainNumber && record.route && record.scheduledAt);
}

export function selectApiStations(catalog, requestedStations = null) {
  const unique = [...new Map((Array.isArray(catalog) ? catalog : [])
    .filter((item) => item?.id != null && item?.name)
    .map((item) => [String(item.id), { id: String(item.id), name: String(item.name).trim() }])).values()];
  if (!Array.isArray(requestedStations) || !requestedStations.length) return unique;
  const requested = new Set(requestedStations.map(normalize));
  return unique.filter((item) => requested.has(normalize(item.name)));
}

async function fetchJson(url, headers, fetchImpl, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const requestHeaders = typeof headers === "function" ? headers() : headers;
      const response = await fetchImpl(url, { headers: requestHeaders, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        const error = new Error(`official board API HTTP ${response.status}`);
        error.status = response.status;
        const retryAfter = Number(response.headers.get("retry-after"));
        error.retryDelayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : ([429, 441].includes(response.status) ? 5_000 * attempt : 750 * attempt);
        throw error;
      }
      const type = response.headers.get("content-type") || "";
      if (!type.includes("application/json")) throw new Error(`official board API returned ${type || "non-JSON"}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if ([429, 441].includes(error?.status)) break;
      if (attempt < attempts) await wait(error?.retryDelayMs || 750 * attempt);
    }
  }
  throw lastError;
}

export async function fetchOfficialBoardRecords({
  stations = null,
  concurrency = process.env.BOARD_CONCURRENCY || 2,
  fetchImpl = fetch,
  sessionId = randomUUID(),
  requestDelayMs = process.env.BOARD_REQUEST_DELAY_MS || 1_500,
  stationOffset = null,
  updates = [],
  previousRecords = [],
  requestBudget = process.env.BOARD_REQUEST_BUDGET || 1,
} = {}) {
  const checkedAt = new Date().toISOString();
  const headers = {
    Accept: "application/json",
    "x-client-locale": "uk",
    "x-session-id": sessionId,
    "x-user-agent": BOARD_API_USER_AGENT,
  };
  const catalog = await fetchJson(BOARD_API_BASE, headers, fetchImpl);
  const ranked = rankBoardStations(selectApiStations(catalog, stations), { updates, previousRecords, now: checkedAt });
  if (!ranked.length) throw new Error("official board API returned no matching stations");
  const rawOffset = stationOffset == null ? 0 : Number(stationOffset);
  const offset = ((Number.isFinite(rawOffset) ? rawOffset : 0) % ranked.length + ranked.length) % ranked.length;
  const planned = [...ranked.slice(offset), ...ranked.slice(0, offset)];
  const records = [], failures = [], deferredStations = [];
  const budget = Math.max(1, Number(requestBudget) || 1);
  let attempted = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < planned.length) {
      const station = planned[cursor++];
      if (attempted >= budget) {
        deferredStations.push(...planned.slice(cursor - 1).map((item) => ({ station: item.name, stationId: item.id })));
        cursor = planned.length;
        break;
      }
      attempted += 1;
      try {
        const payload = await fetchJson(`${BOARD_API_BASE}/${encodeURIComponent(station.id)}`, headers, fetchImpl);
        records.push(...apiBoardToRecords(payload, new Date().toISOString()));
      } catch (error) {
        failures.push({ station: station.name, stationId: station.id, error: String(error?.message || error).slice(0, 240) });
        if ([429, 441].includes(error?.status)) {
          const deferred = planned.slice(cursor);
          deferredStations.push(...deferred.map((item) => ({ station: item.name, stationId: item.id, reason: `upstream-http-${error.status}` })));
          cursor = planned.length;
        }
      }
      await wait(Math.max(0, Number(requestDelayMs) || 0));
    }
  };
  const count = Math.max(1, Math.min(3, Number(concurrency) || 1, planned.length));
  await Promise.all(Array.from({ length: count }, worker));
  if (!records.length) throw new Error(`official board API returned no records; ${failures.length}/${planned.length} station failures`);
  return {
    checkedAt, records, failures, deferredStations, plannedStations: planned, transport: "official-json-api",
    scheduler: {
      strategy: "information-gain-v1", requestBudget: budget, attempted,
      selectedStation: records[0]?.station || planned[0]?.name || null,
      selectedReason: planned[0]?.reasons || [], selectedScore: planned[0]?.score || 0,
      rankedStations: planned.slice(0, 5).map(({ id, name, score, expectedTrains, reasons }) => ({ id, name, score, expectedTrains, reasons })),
    },
  };
}
