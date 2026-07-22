import { pathToFileURL } from "node:url";

const API = String(process.env.RAIL_API_URL || "").replace(/\/$/, "");
const TOKEN = process.env.RAIL_INGEST_TOKEN || "";
const SOURCE_ID = "data-gov-ua-barrier-free";
const DATASET_URL = "https://data.gov.ua/dataset/38997a1f-2e86-4bd7-9054-cd9cd206d825";
const RESOURCE_URL = "https://data.gov.ua/dataset/546b7215-44f3-42eb-bf16-f74c9883a0b8/resource/f67b18b4-736a-4fd9-89ed-4b3fdfb59003/download/establishments.geojson";
const DRY_RUN = process.argv.includes("--dry-run");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithRetry(url, options = {}, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, headers: { "User-Agent": "RailUkrainePulse/1.0 (open-data enrichment)", ...(options.headers || {}) } });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`HTTP ${response.status}`); await response.body?.cancel();
    } catch (error) { lastError = error; }
    if (attempt < attempts) await sleep(Math.min(15_000, 1_000 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

function categorySummary(category) {
  const criteria = Array.isArray(category.criteria) ? category.criteria : [];
  const count = (value) => criteria.filter((item) => item.value === value).length;
  return {
    id: String(category.id || ""),
    yes: count("\u0442\u0430\u043a"),
    no: count("\u043d\u0456"),
    notApplicable: count("\u043d\u0435 \u0437\u0430\u0441\u0442\u043e\u0441\u043e\u0432\u0443\u0454\u0442\u044c\u0441\u044f"),
    photoCount: criteria.reduce((sum, item) => sum + (Array.isArray(item.photos) ? item.photos.length : 0), 0),
  };
}

export function normalizeAccessibilityFeature(feature) {
  const properties = feature?.properties || {}; const coordinates = feature?.geometry?.coordinates || [];
  if (properties.kind !== "\u0410\u0417\u0421" || feature?.geometry?.type !== "Point") return null;
  const lng = Number(coordinates[0] ?? properties.lon); const lat = Number(coordinates[1] ?? properties.lat);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const categories = (properties.categories || []).map(categorySummary);
  return {
    externalId: String(properties.id ?? feature.id),
    sourceUrl: properties.url || `https://lun.ua/misto/barrier-free/${properties.id ?? feature.id}`,
    datasetUrl: DATASET_URL,
    title: properties.title || null,
    address: [properties.addressPostName, properties.addressThoroughfare, properties.addressLocatorDesignator].filter(Boolean).join(", ") || null,
    lat, lng,
    rating: Number.isFinite(Number(properties.rating)) ? Number(properties.rating) : null,
    assessment: properties.ratingAuthority || null,
    assessedAt: properties.updateDate || null,
    photoCount: categories.reduce((sum, category) => sum + category.photoCount, 0),
    summary: {
      categories,
      yes: categories.reduce((sum, category) => sum + category.yes, 0),
      no: categories.reduce((sum, category) => sum + category.no, 0),
      notApplicable: categories.reduce((sum, category) => sum + category.notApplicable, 0),
      region: properties.addressAdminUnitL2 || null,
    },
  };
}

async function main() {
  if (!DRY_RUN && (!API || TOKEN.length < 24)) throw new Error("RAIL_API_URL and RAIL_INGEST_TOKEN are required");
  console.log("Downloading official accessibility establishments dataset");
  const response = await fetchWithRetry(RESOURCE_URL);
  if (!response.ok) throw new Error(`data.gov.ua HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 130_000_000) throw new Error(`Dataset unexpectedly large: ${length} bytes`);
  const payload = JSON.parse(new TextDecoder().decode(await response.arrayBuffer()));
  const records = (payload.features || []).map(normalizeAccessibilityFeature).filter(Boolean);
  if (!records.length) throw new Error("Official dataset returned no fuel stations; refusing an empty enrichment import");
  console.log(`Normalized ${records.length} official fuel accessibility cards`);
  if (DRY_RUN) return;
  let accepted = 0; let reviewed = 0;
  for (let offset = 0; offset < records.length; offset += 25) {
    const chunk = records.slice(offset, offset + 25);
    const result = await fetchWithRetry(`${API}/api/fuel/v1/accessibility/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: SOURCE_ID, generatedAt: new Date().toISOString(), records: chunk }),
    });
    const body = await result.json();
    if (!result.ok) throw new Error(`Accessibility API HTTP ${result.status}: ${JSON.stringify(body)}`);
    accepted += Number(body.accepted || 0); reviewed += Number(body.reviewed || 0);
    console.log(`Processed ${Math.min(offset + chunk.length, records.length)}/${records.length}`);
  }
  console.log(`Accessibility import complete: ${accepted} matched, ${reviewed} queued for review`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
