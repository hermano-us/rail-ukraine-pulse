import { decodeHtml, fetchText, normalizeTrainNumber, splitRoute } from "./html.mjs";

export const SWRAILWAY_STATION_URL = "https://swrailway.gov.ua/timetable/eltrain/?sid=5001";

const cellTexts = (row) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => decodeHtml(match[1]));
const firstTrainNumber = (value) => normalizeTrainNumber(String(value || "").match(/\d{3,4}(?:\s*\/\s*\d{3,4})?/)?.[0] || "");

export function parseSwRailwayStationSchedule(html, { station = "Львів-Приміський", observedAt = new Date().toISOString() } = {}) {
  const records = [], plannedUpdates = [];
  for (const match of html.matchAll(/<tr[^>]*class=["'][^"']*\bonx?\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = cellTexts(match[1]);
    if (cells.length < 8) continue;
    const trainNumber = firstTrainNumber(cells[0]);
    const route = splitRoute(cells[3]);
    const validFrom = cells[6]?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
    const validTo = cells[7]?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
    const serviceDate = observedAt.slice(0, 10);
    if ((validFrom && serviceDate < validFrom) || (validTo && serviceDate > validTo)) continue;
    if (!trainNumber || !route.origin || !route.destination || (!/^\d{1,2}:\d{2}$/.test(cells[4]) && !/^\d{1,2}:\d{2}$/.test(cells[5]))) continue;
    const base = { station, trainNumber, route: route.route, observedAt, circulation: cells[2] || null, validFrom, validTo, sourceId: "swrailway-commuter-schedule" };
    if (/^\d{1,2}:\d{2}$/.test(cells[4])) records.push({ ...base, boardType: "arrival", scheduledTime: cells[4], platform: null, delayLabel: "" });
    if (/^\d{1,2}:\d{2}$/.test(cells[5])) records.push({ ...base, boardType: "departure", scheduledTime: cells[5], platform: null, delayLabel: "" });
    plannedUpdates.push({
      trainNumber, ...route, updatedAt: observedAt,
      source: SWRAILWAY_STATION_URL, sourceId: "swrailway-commuter-schedule",
      sourceEvidence: "official-regional-planned-timetable", positionEvidence: "none",
      scheduleValidity: { from: validFrom, to: validTo, circulation: cells[2] || null },
    });
  }
  return { records, plannedUpdates: [...new Map(plannedUpdates.map((item) => [`${item.trainNumber}:${item.route}`, item])).values()] };
}

export async function collectSwRailway({ previous = {}, fetchImpl = null, ttlHours = Number(process.env.SWRAILWAY_TTL_HOURS || 12) } = {}) {
  const checkedAt = new Date().toISOString();
  if (process.env.SWRAILWAY_ENABLED === "0") return { status: { status: "disabled", checkedAt, label: "ЮЗЖД: отключено" }, records: [], plannedUpdates: [] };
  const lastSuccess = previous.status?.lastSuccessfulAt || previous.status?.checkedAt;
  const age = Date.parse(checkedAt) - Date.parse(lastSuccess || "");
  if (previous.records?.length && Number.isFinite(age) && age >= 0 && age < ttlHours * 3_600_000) {
    return { ...previous, status: { ...previous.status, status: "snapshot", checkedAt, label: `ЮЗЖД: кэш ${previous.records.length} станционных вызовов`, cacheHit: true } };
  }
  try {
    const html = fetchImpl ? await (async () => {
      const response = await fetchImpl(SWRAILWAY_STATION_URL, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })() : await fetchText(SWRAILWAY_STATION_URL, { timeoutMs: 20_000 });
    const parsed = parseSwRailwayStationSchedule(html, { observedAt: checkedAt });
    if (!parsed.records.length) throw new Error("schedule returned no parseable rows");
    return { status: { status: "snapshot", checkedAt, lastSuccessfulAt: checkedAt, label: `ЮЗЖД: ${parsed.plannedUpdates.length} пригородных рейсов`, capabilities: ["planned-commuter-schedule", "station-calls", "validity-window"] }, ...parsed };
  } catch (error) {
    const hasCache = previous.records?.length > 0;
    return { ...previous, status: { status: hasCache ? "stale" : "unavailable", checkedAt, lastSuccessfulAt: lastSuccess || null, label: hasCache ? "ЮЗЖД: последний справочный снимок" : "ЮЗЖД: недоступно", error: String(error?.message || error).slice(0, 400) }, records: previous.records || [], plannedUpdates: previous.plannedUpdates || [] };
  }
}
