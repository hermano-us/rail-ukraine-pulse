export const FREIGHT_PUBLIC_POLICY = Object.freeze({
  minimumDelayMinutes: 24 * 60,
  maximumAgeHours: 7 * 24,
  minimumIndependentSources: 2,
  corroborationWindowHours: 6,
  minimumUncertaintyKm: 35,
  exactPositions: false,
  exposeIdentifiers: false,
  exposeRawEvidence: false,
});

export const FREIGHT_CORRIDORS = Object.freeze({
  "kyiv-korosten": Object.freeze({
    code: "kyiv-korosten",
    kind: "line",
    label: "Київ — Коростень",
    origin: "Київ",
    destination: "Коростень",
    coordinates: Object.freeze([[30.484, 50.4406], [30.259, 50.521], [29.917, 50.64], [29.25, 50.77], [28.642, 50.953]]),
    directionAliases: Object.freeze({ "київ": "Київ", "киев": "Київ", "коростень": "Коростень" }),
  }),
  "kryvyi-rih": Object.freeze({
    code: "kryvyi-rih",
    kind: "area",
    label: "Криворізький залізничний район",
    origin: "Криворізький залізничний район",
    destination: "Криворізький залізничний район",
    coordinates: Object.freeze([[32.95, 47.72], [33.95, 47.72], [33.95, 48.35], [32.95, 48.35], [32.95, 47.72]]),
    directionAliases: Object.freeze({}),
  }),
  "zaporizhzhia": Object.freeze({
    code: "zaporizhzhia",
    kind: "area",
    label: "Запорізький залізничний район",
    origin: "Запорізький залізничний район",
    destination: "Запорізький залізничний район",
    coordinates: Object.freeze([[34.45, 47.45], [35.75, 47.45], [35.75, 48.15], [34.45, 48.15], [34.45, 47.45]]),
    directionAliases: Object.freeze({}),
  }),
});

const SOURCE_GROUPS = Object.freeze({
  "freight-tg-mr-boyanchik": "boyanchik-network",
  "freight-tg-mishan4ik": "boyanchik-network",
  "freight-tg-irpin": "irpin-observers",
  "freight-tg-korosten-kyiv": "korosten-kyiv-observers",
  "freight-tg-korosten": "korosten-perehon",
});

export function freightSourceGroup(sourceId = "") {
  const value = String(sourceId).trim().toLocaleLowerCase("en-US");
  return SOURCE_GROUPS[value] || value.replace(/-chat$/, "") || "unknown";
}

export function freightCorridor(code = "") {
  return FREIGHT_CORRIDORS[String(code).trim()] || null;
}

export function generalizedFreightDirection(corridor, value = "") {
  const normalized = String(value).normalize("NFKC").trim().toLocaleLowerCase("uk-UA");
  if (!normalized || !corridor) return null;
  for (const [alias, label] of Object.entries(corridor.directionAliases || {})) {
    if (normalized.includes(alias)) return label;
  }
  return null;
}

export function roundedFreightTime(value, bucketMinutes = 15) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const bucket = Math.max(15, Number(bucketMinutes) || 15) * 60_000;
  return new Date(Math.floor(timestamp / bucket) * bucket).toISOString();
}
