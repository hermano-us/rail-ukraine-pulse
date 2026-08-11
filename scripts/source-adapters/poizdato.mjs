import { decodeHtml, normalizeTrainNumber } from "./html.mjs";

const ENDPOINT = "https://poizdato.net/search/get-part-stations";
const BASE_URL = "https://poizdato.net";
export const POIZDATO_TERMS = ["Київ", "Львів", "Харків", "Одеса", "Дніпро", "Запоріжжя", "Ковель", "Чоп", "Жмеринка"];

export function parsePoizdatoStations(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.response) ? payload.response : [];
  return rows.map((item) => {
    const coordinates = String(item.coordinates || "").split(",").map(Number);
    return {
      id: String(item.id || ""), name: String(item.name || "").trim(), countryId: item.country_id == null ? null : String(item.country_id),
      latitude: Number.isFinite(coordinates[0]) ? coordinates[0] : null,
      longitude: Number.isFinite(coordinates[1]) ? coordinates[1] : null,
      sourceId: "poizdato-station-reference",
    };
  }).filter((item) => item.id && item.name && item.latitude != null && item.longitude != null);
}

const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const routeKey = (item = {}) => `${normalizeTrainNumber(item.trainNumber)}:${normalize(item.origin)}>${normalize(item.destination)}`;
const trainParts = (value) => new Set(normalizeTrainNumber(value).split("/").map((part) => part.replace(/^0+(?=\d)/, "")).filter(Boolean));
const sameTrain = (left, right) => [...trainParts(left)].some((part) => trainParts(right).has(part));
const cleanText = (value) => decodeHtml(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export function parsePoizdatoTrainRoute(html, expected = {}) {
  const select = String(html || "").match(/<select[^>]+id=["']active_station["'][^>]*>([\s\S]*?)<\/select>/i)?.[1] || "";
  let stations = [...select.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map((match) => cleanText(match[1])).filter(Boolean);
  const unique = [];
  for (const station of stations) if (!unique.some((item) => normalize(item) === normalize(station))) unique.push(station);
  stations = unique;
  const from = stations.findIndex((station) => normalize(station) === normalize(expected.origin));
  const to = stations.findIndex((station) => normalize(station) === normalize(expected.destination));
  if (from >= 0 && to >= 0 && from !== to) stations = from < to ? stations.slice(from, to + 1) : stations.slice(to, from + 1).reverse();
  if (stations.length < 3 || normalize(stations[0]) !== normalize(expected.origin) || normalize(stations.at(-1)) !== normalize(expected.destination)) return [];
  return stations;
}

export function discoverPoizdatoTrainRouteUrl(html, trainNumber) {
  const links = [...String(html || "").matchAll(/href=["']([^"']*\/rozklad-poizda\/[^"']+)["']/gi)].map((match) => match[1]);
  const match = links.find((link) => sameTrain(decodeURIComponent(link).split("/rozklad-poizda/")[1]?.split("--")[0], trainNumber));
  return match ? new URL(match, BASE_URL).toString() : null;
}

async function fetchRouteTemplate(update, fetchImpl) {
  const form = new URLSearchParams({ dir_from:update.origin, st_from_id:"0", dir_where:update.destination, st_where_id:"0", dir_date:"", dir_time_from:"", dir_time_to:"", dir_long_distance:"1", dir_suburban:"1", dir_submit:"Знайти" });
  const search = await fetchImpl(`${BASE_URL}/rozklad-poizdiv/`, { method:"POST", headers:{ Accept:"text/html", "Content-Type":"application/x-www-form-urlencoded", "User-Agent":"RailUkrainePulse/4.0 route-registry" }, body:form, signal:AbortSignal.timeout(20_000) });
  if (!search.ok) throw new Error(`route search HTTP ${search.status}`);
  const sourceUrl = discoverPoizdatoTrainRouteUrl(await search.text(), update.trainNumber);
  if (!sourceUrl) throw new Error("route page not found");
  const page = await fetchImpl(sourceUrl, { headers:{ Accept:"text/html", "User-Agent":"RailUkrainePulse/4.0 route-registry" }, signal:AbortSignal.timeout(20_000) });
  if (!page.ok) throw new Error(`route page HTTP ${page.status}`);
  const orderedStations = parsePoizdatoTrainRoute(await page.text(), update);
  if (orderedStations.length < 3) throw new Error("route page has no bounded station sequence");
  return { key:routeKey(update), trainNumber:update.trainNumber, origin:update.origin, destination:update.destination, orderedStations, sourceUrl, fetchedAt:new Date().toISOString() };
}

export async function collectPoizdatoTrainRoutes({ updates = [], previous = {}, fetchImpl = fetch, budget = Number(process.env.POIZDATO_ROUTE_BUDGET || 5), ttlHours = Number(process.env.POIZDATO_ROUTE_TTL_HOURS || 168) } = {}) {
  const checkedAt = new Date().toISOString(), cutoff = Date.parse(checkedAt) - Math.max(24, ttlHours) * 3_600_000;
  const retained = (previous.routes || []).filter((item) => Date.parse(item.fetchedAt || 0) >= cutoff), routes = new Map(retained.map((item) => [item.key || routeKey(item), item]));
  const candidates = [...new Map(updates.filter((item) => item?.trainNumber && item?.origin && item?.destination && item.origin !== item.destination).map((item) => [routeKey(item), item])).values()]
    .filter((item) => !routes.has(routeKey(item))).sort((left, right) => Number(right.operationalStatus === "moving") - Number(left.operationalStatus === "moving") || Number(right.delayMinutes || 0) - Number(left.delayMinutes || 0));
  const selected = candidates.slice(0, Math.max(0, Math.min(12, Number(budget) || 0))), failures = [];
  for (const update of selected) {
    try { const route = await fetchRouteTemplate(update, fetchImpl); routes.set(route.key, route); }
    catch (error) { failures.push({ key:routeKey(update), trainNumber:update.trainNumber, error:String(error?.message || error).slice(0, 240) }); }
  }
  const values = [...routes.values()], accepted = Math.max(0, values.length - retained.length);
  return { status:{ status:values.length ? failures.length ? "degraded" : "snapshot" : "unavailable", checkedAt, lastSuccessfulAt:accepted ? checkedAt : previous.status?.lastSuccessfulAt || null, label:`Poizdato routes: ${values.length} шаблонов · ${accepted} новых`, error:failures.length ? failures.map((item) => `${item.trainNumber}: ${item.error}`).join("; ").slice(0, 500) : null, capabilities:["ordered-train-stops","route-template"], scheduler:{ strategy:"moving-first-route-budget-v1", requestBudget:selected.length, remaining:Math.max(0, candidates.length - selected.length) } }, routes:values, failures };
}

export function enrichUpdatesWithPoizdatoRoutes(updates = [], routes = []) {
  const index = new Map(routes.map((item) => [item.key || routeKey(item), item]));
  return updates.map((update) => { const route = index.get(routeKey(update)); return route ? { ...update, orderedStations:route.orderedStations, routeTemplateSource:route.sourceUrl } : update; });
}
export async function collectPoizdatoStations({ previous = {}, fetchImpl = fetch, terms = POIZDATO_TERMS, budget = Number(process.env.POIZDATO_REQUEST_BUDGET || 2), ttlHours = Number(process.env.POIZDATO_TTL_HOURS || 24) } = {}) {
  const checkedAt = new Date().toISOString();
  if (process.env.POIZDATO_ENABLED === "0") return { status: { status: "disabled", checkedAt, label: "Poizdato: отключено" }, stations: [], scheduler: { nextOffset: 0 } };
  const previousSuccess = previous.status?.lastSuccessfulAt || previous.status?.checkedAt;
  const age = Date.parse(checkedAt) - Date.parse(previousSuccess || "");
  if (previous.stations?.length && Number.isFinite(age) && age >= 0 && age < ttlHours * 3_600_000) {
    return { ...previous, status: { ...previous.status, status: "snapshot", checkedAt, label: `Poizdato: кэш ${previous.stations.length} станций`, cacheHit: true } };
  }
  const offset = Number(previous.scheduler?.nextOffset || 0) % Math.max(1, terms.length);
  const selected = Array.from({ length: Math.max(1, Math.min(terms.length, Number(budget) || 1)) }, (_, index) => terms[(offset + index) % terms.length]);
  const stations = new Map((previous.stations || []).map((item) => [item.id, item])), failures = [];
  let accepted = 0;
  for (const term of selected) {
    try {
      const url = `${ENDPOINT}?term=${encodeURIComponent(term)}&lang=uk`;
      const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "RailUkrainePulse/3.0 station-reference" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers?.get?.("content-type") || "";
      if (contentType && !/json/i.test(contentType)) throw new Error(`unexpected content-type ${contentType}`);
      const parsed = parsePoizdatoStations(await response.json());
      if (!parsed.length) throw new Error("no station candidates");
      parsed.forEach((item) => stations.set(item.id, item)); accepted += parsed.length;
    } catch (error) { failures.push({ term, error: String(error?.message || error).slice(0, 240) }); }
  }
  const scheduler = { strategy: "rotating-reference-budget-v1", selectedTerms: selected, requestBudget: selected.length, nextOffset: (offset + selected.length) % terms.length };
  const values = [...stations.values()];
  const status = accepted ? (failures.length ? "degraded" : "snapshot") : values.length ? "stale" : "unavailable";
  return {
    status: { status, checkedAt, lastSuccessfulAt: accepted ? checkedAt : previousSuccess || null, label: `Poizdato: ${values.length} станций в справочном кэше`, error: failures.length ? failures.map((item) => `${item.term}: ${item.error}`).join("; ").slice(0, 500) : null, capabilities: ["station-alias", "station-coordinate", "reference-only"], scheduler },
    stations: values, failures, scheduler,
  };
}
