export const KOLEO_STATIONS_URL = "https://api.koleo.pl/v2/main/stations";
const RELEVANT = /dorohusk|che[łl]m|przemy[śs]l|medyka|rzesz[oó]w|lublin|warszawa|krak[oó]w|chop|czop|uzhhorod|u[żz]horod|mukachev|lw[oó]w|lviv|kij[oó]w|kyiv/iu;

export function parseKoleoStationCatalog(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.stations) ? payload.stations : [];
  const relevant = rows.map((item) => ({
    id: String(item.id ?? item.station_id ?? ""), name: String(item.name || item.display_name || "").trim(),
    latitude: Number(item.latitude ?? item.lat), longitude: Number(item.longitude ?? item.lon ?? item.lng),
    countryCode: item.country_code || item.countryCode || null, sourceId: "koleo-station-catalog",
  })).filter((item) => item.id && item.name && RELEVANT.test(item.name));
  return { total: rows.length, relevant };
}

export async function collectKoleoCatalog({ previous = {}, fetchImpl = fetch, ttlHours = Number(process.env.KOLEO_CATALOG_TTL_HOURS || 168) } = {}) {
  const checkedAt = new Date().toISOString();
  if (process.env.KOLEO_CATALOG_ENABLED === "0") return { status: { status: "disabled", checkedAt, label: "KOLEO: отключено" }, stations: [], recordsCount: 0 };
  const lastSuccess = previous.status?.lastSuccessfulAt || previous.catalogCheckedAt || previous.status?.checkedAt;
  const age = Date.parse(checkedAt) - Date.parse(lastSuccess || "");
  if (previous.recordsCount > 1000 && Number.isFinite(age) && age >= 0 && age < ttlHours * 3_600_000) {
    return { ...previous, status: { ...previous.status, status: "snapshot", checkedAt, label: `KOLEO: кэш ${previous.recordsCount} станций`, cacheHit: true } };
  }
  try {
    const response = await fetchImpl(KOLEO_STATIONS_URL, {
      headers: { Accept: "application/json", "X-KOLEO-Version": "2", "X-KOLEO-Client": "Nuxt-c0191c0", "User-Agent": "RailUkrainePulse/3.0 cross-border-reference" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseKoleoStationCatalog(await response.json());
    if (parsed.total < 1000) throw new Error(`catalog volume anomaly ${parsed.total}`);
    return {
      status: { status: "snapshot", checkedAt, lastSuccessfulAt: checkedAt, label: `KOLEO: ${parsed.total} станций · ${parsed.relevant.length} пограничных ориентиров`, capabilities: ["cross-border-station-id", "station-coordinate", "reference-only"] },
      catalogCheckedAt: checkedAt, recordsCount: parsed.total, stations: parsed.relevant,
    };
  } catch (error) {
    const hasCache = previous.recordsCount > 1000;
    return { ...previous, status: { status: hasCache ? "stale" : "unavailable", checkedAt, lastSuccessfulAt: lastSuccess || null, label: hasCache ? "KOLEO: последний справочный снимок" : "KOLEO: недоступно", error: String(error?.message || error).slice(0, 400) }, stations: previous.stations || [], recordsCount: previous.recordsCount || 0 };
  }
}
