import { haversineKm } from "./domain.js";

const rows = (result) => result?.results || [];
const safeParse = (value, fallback = {}) => { try { return JSON.parse(value || ""); } catch { return fallback; } };
const normalize = (value) => String(value || "").normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tokens = (value) => new Set(normalize(value).split(/\s+/).filter((item) => item.length > 2));
const overlap = (left, right) => {
  const expected = tokens(left); const actual = tokens(right);
  return expected.size ? [...expected].filter((token) => actual.has(token)).length / expected.size : 0;
};

export function partnerMatchScore(record, candidate) {
  const distanceKm = haversineKm(Number(record.lat), Number(record.lng), Number(candidate.latitude), Number(candidate.longitude));
  const distanceScore = distanceKm <= 0.03 ? 0.64 : distanceKm <= 0.08 ? 0.55 : distanceKm <= 0.15 ? 0.42 : distanceKm <= 0.3 ? 0.25 : 0;
  const expectedBrand = normalize(record.brand);
  const actualBrand = normalize(candidate.brand || candidate.operator_name || candidate.canonical_name);
  const brandScore = expectedBrand && actualBrand && (expectedBrand === actualBrand || expectedBrand.includes(actualBrand) || actualBrand.includes(expectedBrand)) ? 0.26 : 0;
  const brandConflict = expectedBrand && actualBrand && !brandScore ? 0.38 : 0;
  const nameScore = Math.min(0.12, overlap(record.name, [candidate.canonical_name, candidate.brand, candidate.operator_name].filter(Boolean).join(" ")) * 0.12);
  const addressScore = Math.min(0.14, overlap(record.address, candidate.address) * 0.14);
  return { distanceKm, score: Math.max(0, Math.min(1, distanceScore + brandScore + nameScore + addressScore - brandConflict)) };
}

function mergedServices(current, record) {
  const services = { ...safeParse(current) };
  const imageUrls = Array.isArray(record.imageUrls) ? record.imageUrls.filter((value) => typeof value === "string" && value.startsWith("/assets/fuel/carta/")) : [];
  if (imageUrls.length) services.media = { ...(services.media || {}), imageUrl: imageUrls[0], imageUrls, attribution: "Carta.ua — partner data", sourceUrl: record.externalUrl || null };
  if (record.email) services.contacts = { ...(services.contacts || {}), email: String(record.email) };
  return services;
}

export async function importPartnerStations(request, env, authorized, json) {
  if (!authorized()) return json({ error: "unauthorized" }, 401, request, env);
  const body = await request.json();
  const records = Array.isArray(body.records) ? body.records : [];
  if (body.sourceId !== "carta-ua" || !records.length || records.length > 50) return json({ error: "invalid_import", maxRecords: 50 }, 400, request, env);
  const now = new Date().toISOString();
  const importId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO fuel_import_runs(import_id,source_id,started_at,status,received_count) VALUES(?1,?2,?3,'running',?4)").bind(importId, body.sourceId, now, records.length).run();
  const statements = [];
  let accepted = 0; let matched = 0; let inserted = 0;
  for (const record of records) {
    const lat = Number(record.lat); const lng = Number(record.lng); const externalId = String(record.externalId || "");
    if (!externalId || !record.stationId || lat < 44 || lat > 53 || lng < 21 || lng > 41) continue;
    const delta = 0.0045;
    const candidates = rows(await env.DB.prepare("SELECT station_id,canonical_name,brand,operator_name,latitude,longitude,address,services_json FROM fuel_stations WHERE lifecycle_status='active' AND latitude BETWEEN ?1 AND ?2 AND longitude BETWEEN ?3 AND ?4 LIMIT 30").bind(lat - delta, lat + delta, lng - delta, lng + delta).all());
    const ranked = candidates.map((candidate) => ({ candidate, ...partnerMatchScore(record, candidate) })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const isMatch = Boolean(best && best.score >= 0.7 && best.distanceKm <= 0.18);
    const stationId = isMatch ? best.candidate.station_id : String(record.stationId);
    const services = mergedServices(isMatch ? best.candidate.services_json : null, record);
    if (isMatch) {
      statements.push(env.DB.prepare("UPDATE fuel_stations SET canonical_name=COALESCE(canonical_name,?1),brand=COALESCE(brand,?2),city=COALESCE(city,?3),address=COALESCE(address,?4),phone=COALESCE(phone,?5),services_json=?6,catalog_confidence=MAX(catalog_confidence,0.88),updated_at=?7 WHERE station_id=?8").bind(record.name || null, record.brand || null, record.city || null, record.address || null, record.phone || null, JSON.stringify(services), now, stationId));
      matched += 1;
    } else {
      statements.push(env.DB.prepare("INSERT INTO fuel_stations(station_id,canonical_name,brand,latitude,longitude,city,address,phone,services_json,catalog_confidence,lifecycle_status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0.88,'active',?10,?10) ON CONFLICT(station_id) DO UPDATE SET canonical_name=excluded.canonical_name,brand=excluded.brand,latitude=excluded.latitude,longitude=excluded.longitude,city=excluded.city,address=excluded.address,phone=excluded.phone,services_json=excluded.services_json,catalog_confidence=MAX(fuel_stations.catalog_confidence,excluded.catalog_confidence),lifecycle_status='active',updated_at=excluded.updated_at").bind(stationId, record.name || null, record.brand || null, lat, lng, record.city || null, record.address || null, record.phone || null, JSON.stringify(services), now));
      inserted += 1;
    }
    const matchScore = isMatch ? best.score : 0.88;
    const reasons = isMatch ? ["spatial-brand-address-match", `distance:${best.distanceKm.toFixed(3)}km`] : ["new-partner-catalog-station"];
    statements.push(env.DB.prepare("INSERT INTO fuel_station_source_records(record_id,station_id,source_id,external_id,external_url,source_type,latitude,longitude,name,brand,address,raw_payload_json,license_type,usage_permission,last_seen_at,last_checked_at,match_score,match_status,match_reasons_json,is_primary,created_at,updated_at) VALUES(?1,?2,'carta-ua',?3,?4,'partner_catalog',?5,?6,?7,?8,?9,?10,'Partner permission','partner_feed',?11,?11,?12,?13,?14,?15,?11,?11) ON CONFLICT(source_id,external_id) DO UPDATE SET station_id=excluded.station_id,external_url=excluded.external_url,latitude=excluded.latitude,longitude=excluded.longitude,name=excluded.name,brand=excluded.brand,address=excluded.address,raw_payload_json=excluded.raw_payload_json,last_seen_at=excluded.last_seen_at,last_checked_at=excluded.last_checked_at,match_score=excluded.match_score,match_status=excluded.match_status,match_reasons_json=excluded.match_reasons_json,updated_at=excluded.updated_at").bind(`carta-ua:${externalId}`, stationId, externalId, record.externalUrl || null, lat, lng, record.name || null, record.brand || null, record.address || null, JSON.stringify({ ...(record.raw || {}), email: record.email || null, imageUrls: record.imageUrls || [] }), now, matchScore, isMatch ? "matched" : "new_station_candidate", JSON.stringify(reasons), isMatch ? 0 : 1));
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO fuel_current_state(station_id,public_status,status_confidence,conflict_state,resolved_at,resolver_version) VALUES(?1,'unknown',0,'none',?2,'fuel-resolver-v1')").bind(stationId, now));
    accepted += 1;
  }
  for (let index = 0; index < statements.length; index += 75) await env.DB.batch(statements.slice(index, index + 75));
  await env.DB.batch([
    env.DB.prepare("UPDATE fuel_import_runs SET finished_at=?1,status='success',inserted_count=?2,updated_count=?3 WHERE import_id=?4").bind(now, inserted, matched, importId),
    env.DB.prepare("UPDATE fuel_sources SET last_checked_at=?1,updated_at=?1 WHERE source_id='carta-ua'").bind(now),
    env.DB.prepare("INSERT INTO fuel_source_health_checks(check_id,source_id,status,checked_at,records_count) VALUES(?1,'carta-ua','online',?2,?3)").bind(crypto.randomUUID(), now, accepted),
  ]);
  return json({ ok: true, importId, received: records.length, accepted, matched, inserted }, 202, request, env);
}
