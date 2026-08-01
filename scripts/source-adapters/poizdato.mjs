const ENDPOINT = "https://poizdato.net/search/get-part-stations";
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
