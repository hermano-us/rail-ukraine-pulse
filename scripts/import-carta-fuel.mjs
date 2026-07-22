import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const API = String(process.env.RAIL_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.RAIL_INGEST_TOKEN || "";
const DATA = new URL(process.env.CARTA_DATA_PATH || "../AZC/azs_full_data.json", import.meta.url);
const SHARED_PHONE_LIMIT = 10;
const photoAsset = (relativePath) => `${createHash("sha256").update(String(relativePath)).digest("hex").slice(0, 20)}.jpg`;
const compact = (value) => String(value || "").normalize("NFKC").trim();
const brandFromName = (name) => compact(name).split(",")[0].replace(/^(?:АЗС|АГЗС)\s*/iu, "").trim() || null;
const cityFromAddress = (address) => compact(address).match(/^(?:г\.|м\.)\s*([^,]+)/iu)?.[1]?.trim() || null;
const stableId = (externalId) => {
  const chars = createHash("sha256").update(`carta-ua:${externalId}`).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  return `${chars.slice(0, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}-${chars.slice(16, 20).join("")}-${chars.slice(20).join("")}`;
};

async function fetchWithRetry(url, options, attempts = 4) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      throw new Error(`${response.status} ${await response.text()}`);
    } catch (caught) {
      error = caught;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw error;
}

const raw = JSON.parse(await readFile(DATA, "utf8"));
if (!Array.isArray(raw) || raw.length < 700) throw new Error("Carta.ua dataset is missing or unexpectedly small");
const phoneFrequency = new Map();
for (const item of raw) {
  const phone = compact(item.phone);
  if (phone) phoneFrequency.set(phone, (phoneFrequency.get(phone) || 0) + 1);
}
const seen = new Set();
const records = [];
for (const item of raw) {
  const lat = Number(item.lat);
  const lng = Number(item.lng);
  const externalId = compact(item.id);
  if (!externalId || lat < 44 || lat > 53 || lng < 21 || lng > 41) continue;
  const brand = brandFromName(item.name);
  const duplicateKey = `${lat.toFixed(6)},${lng.toFixed(6)}|${String(brand || "").toLowerCase()}`;
  if (seen.has(duplicateKey)) continue;
  seen.add(duplicateKey);
  const phone = compact(item.phone);
  const imageUrls = (Array.isArray(item.local_photos) ? item.local_photos : []).map((relativePath) => `/assets/fuel/carta/${photoAsset(relativePath)}`);
  records.push({
    stationId: stableId(externalId), externalId, externalUrl: item.url,
    name: compact(item.name), brand, address: compact(item.address), city: cityFromAddress(item.address), lat, lng,
    phone: phone && (phoneFrequency.get(phone) || 0) <= SHARED_PHONE_LIMIT ? phone : null,
    email: compact(item.email) || null, imageUrls,
    raw: { source: "Carta.ua partner dataset", photoCount: imageUrls.length },
  });
}
if (records.length < 700) throw new Error(`Only ${records.length} valid Carta.ua stations; refusing partial import`);
if (!TOKEN) throw new Error("RAIL_INGEST_TOKEN is required");

let accepted = 0;
let matched = 0;
let inserted = 0;
for (let offset = 0; offset < records.length; offset += 40) {
  const chunk = records.slice(offset, offset + 40);
  const response = await fetchWithRetry(`${API}/api/fuel/v1/partner/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sourceId: "carta-ua", generatedAt: new Date().toISOString(), records: chunk }),
  });
  const result = await response.json();
  accepted += Number(result.accepted || 0);
  matched += Number(result.matched || 0);
  inserted += Number(result.inserted || 0);
  console.log(`Carta.ua ${Math.min(offset + chunk.length, records.length)}/${records.length}: ${result.accepted} accepted`);
}
console.log(`Carta.ua import complete: ${accepted} accepted, ${matched} matched, ${inserted} new`);
