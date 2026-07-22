import { createHash } from "node:crypto";

const API = String(process.env.RAIL_API_URL || "").replace(/\/$/, "");
const TOKEN = process.env.RAIL_INGEST_TOKEN || "";
const OVERPASS = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const DRY_RUN = process.argv.includes("--dry-run");
const QUERY = `[out:json][timeout:180];area[\"ISO3166-1\"=\"UA\"][admin_level=2]->.ua;(nwr[\"amenity\"=\"fuel\"](area.ua););out center tags;`;
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithRetry(url, options, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(Math.min(12_000, 750 * 2 ** (attempt - 1)));
  }
  throw lastError;
}


function geohash(lat, lng, length) {
  let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180, even = true, bits = 0, value = 0, output = "";
  while (output.length < length) {
    const midpoint = even ? (minLng + maxLng) / 2 : (minLat + maxLat) / 2;
    const coordinate = even ? lng : lat;
    if (coordinate >= midpoint) { value = value * 2 + 1; if (even) minLng = midpoint; else minLat = midpoint; }
    else { value *= 2; if (even) maxLng = midpoint; else maxLat = midpoint; }
    even = !even; bits += 1;
    if (bits === 5) { output += BASE32[value]; bits = 0; value = 0; }
  }
  return output;
}

function stableId(externalId) {
  const hex = createHash("sha256").update(`openstreetmap:${externalId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function address(tags) {
  const parts = [[tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "), tags["addr:city"], tags["addr:postcode"]].filter(Boolean);
  return parts.join(", ") || null;
}

function mediaFromTags(tags) {
  const commons = String(tags.wikimedia_commons || "");
  let imageUrl = null;
  if (commons.startsWith("File:")) {
    imageUrl = `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(commons.slice(5))}`;
  } else {
    try {
      const candidate = new URL(tags.image || "");
      if (candidate.protocol === "https:" && ["upload.wikimedia.org", "commons.wikimedia.org"].includes(candidate.hostname)) imageUrl = candidate.href;
    } catch {}
  }
  return { imageUrl, commonsUrl: commons ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(commons.replaceAll(" ", "_"))}` : null, mapillaryUrl: tags.mapillary ? `https://www.mapillary.com/app/?pKey=${encodeURIComponent(tags.mapillary)}` : null };
}

function normalize(element) {
  const lat = Number(element.lat ?? element.center?.lat); const lng = Number(element.lon ?? element.center?.lon); const tags = element.tags || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const externalId = `${element.type}/${element.id}`;
  const fuelTags = Object.fromEntries(Object.entries(tags).filter(([key]) => key.startsWith("fuel:") || key.startsWith("payment:")).slice(0, 80));
  const completeness = [tags.name, tags.brand, tags.operator, address(tags), tags.opening_hours].filter(Boolean).length;
  return {
    stationId: stableId(externalId), externalId, externalUrl: `https://www.openstreetmap.org/${externalId}`,
    name: tags.name || tags.brand || tags.operator || "АЗС", brand: tags.brand || null, operator: tags.operator || null,
    lat, lng, geohash6: geohash(lat, lng, 6), geohash8: geohash(lat, lng, 8),
    region: tags["addr:region"] || null, city: tags["addr:city"] || tags["addr:place"] || null, address: address(tags),
    openingHours: tags.opening_hours || null, phone: tags.phone || tags["contact:phone"] || null, website: tags.website || tags["contact:website"] || null,
    paymentCards: Object.keys(tags).some((key) => key.startsWith("payment:cards") && tags[key] === "yes"),
    services: { shop: tags.shop || null, carWash: tags.car_wash === "yes", toilets: tags.toilets === "yes", wifi: tags.internet_access === "wlan" || tags.internet_access === "yes", cafe: tags.cafe === "yes", restaurant: tags.restaurant === "yes", atm: tags.atm === "yes", compressedAir: tags.compressed_air === "yes", parking: tags.parking || null, wheelchair: tags.wheelchair || null, description: tags.description || null, fuel: fuelTags, media: mediaFromTags(tags) },
    catalogConfidence: Math.min(0.92, 0.58 + completeness * 0.055), raw: { osmType: element.type, osmId: element.id, tags },
  };
}

async function main() {
  console.log(`Requesting real OSM fuel catalog from ${OVERPASS}`);
  const response = await fetchWithRetry(OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "RailUkrainePulse/1.0 (catalog import)" }, body: new URLSearchParams({ data: QUERY }) });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json(); const stations = (payload.elements || []).map(normalize).filter(Boolean);
  if (!stations.length) throw new Error("OSM returned no fuel stations; refusing to publish an empty catalog");
  console.log(`Normalized ${stations.length} real stations`);
  if (DRY_RUN) return;
  if (!API || TOKEN.length < 24) throw new Error("RAIL_API_URL and RAIL_INGEST_TOKEN are required");
  let accepted = 0;
  for (let offset = 0; offset < stations.length; offset += 500) {
    const chunk = stations.slice(offset, offset + 500);
    const ingest = await fetchWithRetry(`${API}/api/fuel/v1/import`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: "openstreetmap", generatedAt: new Date().toISOString(), stations: chunk }) });
    const result = await ingest.json(); if (!ingest.ok) throw new Error(`Fuel API HTTP ${ingest.status}: ${JSON.stringify(result)}`);
    accepted += Number(result.accepted || 0); console.log(`Imported ${Math.min(offset + chunk.length, stations.length)}/${stations.length}`);
  }
  console.log(`Fuel catalog import complete: ${accepted} accepted`);
}

await main();
