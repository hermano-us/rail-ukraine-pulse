import { haversineKm, parseBbox } from "./domain.js";
import { importPartnerStations } from "./partner.js";

function cors(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGIN || "*").split(",").map((item) => item.trim());
  return { "Access-Control-Allow-Origin": allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] || "null", Vary: "Origin" };
}
function json(value, status, request, env, cache = "no-store") {
  return new Response(`${JSON.stringify(value)}\n`, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...cors(request, env) } });
}
const rows = (result) => result?.results || [];
const safeParse = (value, fallback = {}) => { try { return JSON.parse(value || ""); } catch { return fallback; } };
const publicStation = (row) => ({ id: row.station_id, name: row.canonical_name || row.brand || "АЗС", brand: row.brand, operator: row.operator_name, lat: row.latitude, lng: row.longitude, region: row.region_code, city: row.city, address: row.address, openingHours: row.opening_hours, phone: row.phone, website: row.website, paymentCards: Boolean(row.payment_cards), services: safeParse(row.services_json), catalogConfidence: row.catalog_confidence, status: row.public_status || "unknown", statusConfidence: row.status_confidence || 0, statusVerifiedAt: row.status_verified_at, statusExpiresAt: row.status_expires_at, conflictState: row.conflict_state || "none", fuels: safeParse(row.fuel_json), prices: safeParse(row.prices_json), resolvedAt: row.resolved_at, accessibility: row.accessibility_source_id ? { sourceId: row.accessibility_source_id, sourceUrl: row.accessibility_source_url, rating: row.accessibility_rating, assessment: row.accessibility_assessment, assessedAt: row.accessibility_assessed_at, confidence: row.accessibility_confidence, summary: safeParse(row.accessibility_summary_json), photoCount: Number(row.accessibility_photo_count || 0), attribution: row.accessibility_attribution } : null });

async function health(request, env) {
  const [stations, latest] = await Promise.all([env.DB.prepare("SELECT COUNT(*) count FROM fuel_stations WHERE lifecycle_status='active'").first(), env.DB.prepare("SELECT source_id,status,finished_at,received_count,error FROM fuel_import_runs ORDER BY started_at DESC LIMIT 1").first()]);
  return json({ status: "ok", catalog: { stations: Number(stations?.count || 0), latestImport: latest || null }, generatedAt: new Date().toISOString() }, 200, request, env, "public, max-age=60");
}

async function listStations(request, env, url) {
  const [minLng, minLat, maxLng, maxLat] = parseBbox(url.searchParams.get("bbox"));
  const zoom = Math.max(4, Math.min(18, Number(url.searchParams.get("zoom")) || 7));
  const status = url.searchParams.get("status"); const brand = url.searchParams.get("brand"); const fuel = url.searchParams.get("fuel");
  const clauses = ["s.lifecycle_status='active'", "s.longitude BETWEEN ?1 AND ?3", "s.latitude BETWEEN ?2 AND ?4"];
  const binds = [minLng, minLat, maxLng, maxLat];
  if (status && status !== "all") { clauses.push(`COALESCE(c.public_status,'unknown')=?${binds.length + 1}`); binds.push(status); }
  if (brand) { clauses.push(`LOWER(COALESCE(s.brand,'') || ' ' || COALESCE(s.canonical_name,'') || ' ' || COALESCE(s.city,'') || ' ' || COALESCE(s.address,'')) LIKE ?${binds.length + 1}`); binds.push(`%${brand.toLowerCase()}%`); }
  if (fuel) { clauses.push(`COALESCE(c.fuel_json,'{}') LIKE ?${binds.length + 1}`); binds.push(`%\"${fuel}\"%`); }
  const where = clauses.join(" AND ");
  if (zoom < 11) {
    const cellByZoom = { 4: 4, 5: 3, 6: 2, 7: 1, 8: 0.5, 9: 0.25, 10: 0.125 };
    const cell = cellByZoom[Math.round(zoom)] || 0.075;
    const result = await env.DB.prepare(`SELECT AVG(s.latitude) lat,AVG(s.longitude) lng,COUNT(*) count FROM fuel_stations s LEFT JOIN fuel_current_state c ON c.station_id=s.station_id WHERE ${where} GROUP BY CAST(s.latitude/${cell} AS INTEGER),CAST(s.longitude/${cell} AS INTEGER) LIMIT 1000`).bind(...binds).all();
    return json({ mode: "clusters", clusters: rows(result).map((item) => ({ lat: item.lat, lng: item.lng, count: item.count })), bbox: [minLng, minLat, maxLng, maxLat] }, 200, request, env, "public, max-age=60");
  }
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 1200));
  const result = await env.DB.prepare(`SELECT s.*,c.public_status,c.status_confidence,c.status_verified_at,c.status_expires_at,c.conflict_state,c.fuel_json,c.prices_json,c.resolved_at FROM fuel_stations s LEFT JOIN fuel_current_state c ON c.station_id=s.station_id WHERE ${where} LIMIT ${limit}`).bind(...binds).all();
  return json({ mode: "stations", stations: rows(result).map(publicStation), bbox: [minLng, minLat, maxLng, maxLat] }, 200, request, env, "public, max-age=45");
}

async function stationDetail(request, env, stationId) {
  const station = await env.DB.prepare("SELECT s.*,c.public_status,c.status_confidence,c.status_verified_at,c.status_expires_at,c.conflict_state,c.fuel_json,c.prices_json,c.resolved_at,a.source_id accessibility_source_id,a.source_url accessibility_source_url,a.rating accessibility_rating,a.assessment accessibility_assessment,a.assessed_at accessibility_assessed_at,a.confidence accessibility_confidence,a.summary_json accessibility_summary_json,a.photo_count accessibility_photo_count,a.attribution accessibility_attribution FROM fuel_stations s LEFT JOIN fuel_current_state c ON c.station_id=s.station_id LEFT JOIN fuel_accessibility_profiles a ON a.station_id=s.station_id WHERE s.station_id=?1 AND s.lifecycle_status='active'").bind(stationId).first();
  if (!station) return json({ error: "not_found" }, 404, request, env);
  const sourceResult = await env.DB.prepare("SELECT r.source_id,r.external_url,r.last_seen_at,r.license_type,r.usage_permission,r.match_score,s.name source_name FROM fuel_station_source_records r JOIN fuel_sources s ON s.source_id=r.source_id WHERE r.station_id=?1 AND r.usage_permission IN ('open_license','official_api','partner_feed') ORDER BY r.is_primary DESC,r.match_score DESC").bind(stationId).all();
  return json({ station: publicStation(station), sources: rows(sourceResult).map((item) => ({ id: item.source_id, name: item.source_name, url: item.external_url, lastSeenAt: item.last_seen_at, license: item.license_type, confidence: item.match_score })) }, 200, request, env, "public, max-age=45");
}

async function nearby(request, env, url) {
  const lat = Number(url.searchParams.get("lat")); const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "invalid_coordinates" }, 400, request, env);
  const radius = Math.max(1, Math.min(100, Number(url.searchParams.get("radius")) || 20)); const latDelta = radius / 111; const lngDelta = radius / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const result = await env.DB.prepare("SELECT s.*,c.public_status,c.status_confidence,c.status_verified_at,c.status_expires_at,c.conflict_state,c.fuel_json,c.prices_json,c.resolved_at FROM fuel_stations s LEFT JOIN fuel_current_state c ON c.station_id=s.station_id WHERE s.lifecycle_status='active' AND s.latitude BETWEEN ?1 AND ?2 AND s.longitude BETWEEN ?3 AND ?4 LIMIT 1000").bind(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta).all();
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 25));
  const stations = rows(result).map((row) => ({ ...publicStation(row), distanceKm: haversineKm(lat, lng, row.latitude, row.longitude) })).filter((item) => item.distanceKm <= radius).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
  return json({ stations, radiusKm: radius }, 200, request, env, "public, max-age=45");
}

async function importStations(request, env, authorized) {
  if (!authorized()) return json({ error: "unauthorized" }, 401, request, env);
  const body = await request.json(); const stations = Array.isArray(body.stations) ? body.stations : [];
  if (body.sourceId !== "openstreetmap" || !stations.length || stations.length > 1000) return json({ error: "invalid_import", maxStations: 1000 }, 400, request, env);
  const now = new Date().toISOString(); const importId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO fuel_import_runs(import_id,source_id,started_at,status,received_count) VALUES(?1,?2,?3,'running',?4)").bind(importId, body.sourceId, now, stations.length).run();
  const statements = [];
  for (const station of stations) {
    const lat = Number(station.lat); const lng = Number(station.lng);
    if (!station.stationId || !station.externalId || lat < 44 || lat > 53 || lng < 21 || lng > 41) continue;
    statements.push(env.DB.prepare("INSERT INTO fuel_stations(station_id,canonical_name,brand,operator_name,latitude,longitude,geohash6,geohash8,region_code,city,address,opening_hours,phone,website,payment_cards,services_json,catalog_confidence,lifecycle_status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'active',?18,?18) ON CONFLICT(station_id) DO UPDATE SET canonical_name=excluded.canonical_name,brand=excluded.brand,operator_name=excluded.operator_name,latitude=excluded.latitude,longitude=excluded.longitude,geohash6=excluded.geohash6,geohash8=excluded.geohash8,region_code=excluded.region_code,city=excluded.city,address=excluded.address,opening_hours=excluded.opening_hours,phone=excluded.phone,website=excluded.website,payment_cards=excluded.payment_cards,services_json=excluded.services_json,catalog_confidence=excluded.catalog_confidence,lifecycle_status='active',updated_at=excluded.updated_at").bind(station.stationId, station.name || null, station.brand || null, station.operator || null, lat, lng, station.geohash6 || null, station.geohash8 || null, station.region || null, station.city || null, station.address || null, station.openingHours || null, station.phone || null, station.website || null, station.paymentCards ? 1 : 0, JSON.stringify(station.services || {}), Math.max(0, Math.min(1, Number(station.catalogConfidence) || 0.5)), now));
    statements.push(env.DB.prepare("INSERT INTO fuel_station_source_records(record_id,station_id,source_id,external_id,external_url,source_type,latitude,longitude,name,brand,address,raw_payload_json,license_type,usage_permission,last_seen_at,last_checked_at,match_score,match_status,match_reasons_json,is_primary,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'catalog',?6,?7,?8,?9,?10,?11,'ODbL-1.0','open_license',?12,?12,?13,'matched','[\"stable_external_id\"]',1,?12,?12) ON CONFLICT(source_id,external_id) DO UPDATE SET station_id=excluded.station_id,external_url=excluded.external_url,latitude=excluded.latitude,longitude=excluded.longitude,name=excluded.name,brand=excluded.brand,address=excluded.address,raw_payload_json=excluded.raw_payload_json,last_seen_at=excluded.last_seen_at,last_checked_at=excluded.last_checked_at,match_score=excluded.match_score,updated_at=excluded.updated_at").bind(`${body.sourceId}:${station.externalId}`, station.stationId, body.sourceId, station.externalId, station.externalUrl || null, lat, lng, station.name || null, station.brand || null, station.address || null, JSON.stringify(station.raw || {}), now, Math.max(0, Math.min(1, Number(station.catalogConfidence) || 0.5))));
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO fuel_current_state(station_id,public_status,status_confidence,conflict_state,resolved_at,resolver_version) VALUES(?1,'unknown',0,'none',?2,'fuel-resolver-v1')").bind(station.stationId, now));
  }
  for (let i = 0; i < statements.length; i += 75) await env.DB.batch(statements.slice(i, i + 75));
  const accepted = Math.floor(statements.length / 3);
  await env.DB.batch([env.DB.prepare("UPDATE fuel_import_runs SET finished_at=?1,status='success',inserted_count=?2 WHERE import_id=?3").bind(now, accepted, importId), env.DB.prepare("UPDATE fuel_sources SET last_checked_at=?1,updated_at=?1 WHERE source_id=?2").bind(now, body.sourceId), env.DB.prepare("INSERT INTO fuel_source_health_checks(check_id,source_id,status,checked_at,records_count) VALUES(?1,?2,'online',?3,?4)").bind(crypto.randomUUID(), body.sourceId, now, accepted)]);
  return json({ ok: true, importId, received: stations.length, accepted }, 202, request, env);
}


export function accessibilityMatchScore(record, candidate) {
  const distanceKm = haversineKm(Number(record.lat), Number(record.lng), Number(candidate.latitude), Number(candidate.longitude));
  const distanceScore = distanceKm <= 0.03 ? 0.86 : distanceKm <= 0.08 ? 0.74 : distanceKm <= 0.15 ? 0.58 : distanceKm <= 0.3 ? 0.4 : 0;
  const tokens = (value) => new Set(String(value || "").normalize("NFKD").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 2));
  const expected = tokens(record.title); const actual = tokens([candidate.canonical_name, candidate.brand, candidate.operator_name].filter(Boolean).join(" "));
  const overlap = expected.size ? [...expected].filter((token) => actual.has(token)).length / expected.size : 0;
  return { distanceKm, score: Math.min(1, distanceScore + Math.min(0.14, overlap * 0.14)) };
}

async function importAccessibility(request, env, authorized) {
  if (!authorized()) return json({ error: "unauthorized" }, 401, request, env);
  const body = await request.json(); const records = Array.isArray(body.records) ? body.records : [];
  if (body.sourceId !== "data-gov-ua-barrier-free" || !records.length || records.length > 100) return json({ error: "invalid_import", maxRecords: 100 }, 400, request, env);
  const now = new Date().toISOString(); const importId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO fuel_import_runs(import_id,source_id,started_at,status,received_count) VALUES(?1,?2,?3,'running',?4)").bind(importId, body.sourceId, now, records.length).run();
  const statements = []; let accepted = 0; let reviewed = 0;
  for (const record of records) {
    const lat = Number(record.lat); const lng = Number(record.lng); const externalId = String(record.externalId || "");
    if (!externalId || lat < 44 || lat > 53 || lng < 21 || lng > 41) continue;
    const delta = 0.004;
    const candidates = rows(await env.DB.prepare("SELECT station_id,canonical_name,brand,operator_name,latitude,longitude,address FROM fuel_stations WHERE lifecycle_status='active' AND latitude BETWEEN ?1 AND ?2 AND longitude BETWEEN ?3 AND ?4 LIMIT 20").bind(lat - delta, lat + delta, lng - delta, lng + delta).all());
    const ranked = candidates.map((candidate) => ({ candidate, ...accessibilityMatchScore(record, candidate) })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best && best.score >= 0.64 && best.distanceKm <= 0.18) {
      const confidence = Math.min(0.98, best.score * 0.9 + 0.08);
      statements.push(env.DB.prepare("INSERT INTO fuel_accessibility_profiles(station_id,source_id,external_id,source_url,rating,assessment,assessed_at,confidence,summary_json,photo_count,attribution,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12) ON CONFLICT(station_id) DO UPDATE SET source_id=excluded.source_id,external_id=excluded.external_id,source_url=excluded.source_url,rating=excluded.rating,assessment=excluded.assessment,assessed_at=excluded.assessed_at,confidence=excluded.confidence,summary_json=excluded.summary_json,photo_count=excluded.photo_count,attribution=excluded.attribution,updated_at=excluded.updated_at").bind(best.candidate.station_id, body.sourceId, externalId, record.sourceUrl, Number.isFinite(Number(record.rating)) ? Number(record.rating) : null, record.assessment || null, record.assessedAt || null, confidence, JSON.stringify(record.summary || {}), Math.max(0, Number(record.photoCount) || 0), "Ministry for Communities and Territories Development of Ukraine / LUN Misto, CC BY 4.0", now));
      statements.push(env.DB.prepare("INSERT INTO fuel_station_source_records(record_id,station_id,source_id,external_id,external_url,source_type,latitude,longitude,name,address,raw_payload_json,license_type,usage_permission,last_seen_at,last_checked_at,match_score,match_status,match_reasons_json,is_primary,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'official_open_data',?6,?7,?8,?9,?10,'CC-BY-4.0','open_license',?11,?11,?12,'matched',?13,0,?11,?11) ON CONFLICT(source_id,external_id) DO UPDATE SET station_id=excluded.station_id,external_url=excluded.external_url,latitude=excluded.latitude,longitude=excluded.longitude,name=excluded.name,address=excluded.address,raw_payload_json=excluded.raw_payload_json,last_seen_at=excluded.last_seen_at,last_checked_at=excluded.last_checked_at,match_score=excluded.match_score,match_status='matched',match_reasons_json=excluded.match_reasons_json,updated_at=excluded.updated_at").bind(`${body.sourceId}:${externalId}`, best.candidate.station_id, body.sourceId, externalId, record.sourceUrl, lat, lng, record.title || null, record.address || null, JSON.stringify({ rating: record.rating, assessment: record.assessment, assessedAt: record.assessedAt, summary: record.summary }), now, confidence, JSON.stringify(["nearest-rail-pulse-catalog-station", `distance:${best.distanceKm.toFixed(3)}km`])));
      accepted += 1;
    } else {
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO fuel_moderation_queue(queue_id,entity_type,entity_id,priority,reason,status,created_at) VALUES(?1,'source_candidate',?2,55,?3,'open',?4)").bind(`${body.sourceId}:${externalId}`, `${body.sourceId}:${externalId}`, best ? `ambiguous_match:${best.distanceKm.toFixed(3)}km:${best.score.toFixed(2)}` : "no_nearby_catalog_station", now));
      reviewed += 1;
    }
  }
  for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
  await env.DB.batch([
    env.DB.prepare("UPDATE fuel_import_runs SET finished_at=?1,status='success',inserted_count=?2,review_count=?3 WHERE import_id=?4").bind(now, accepted, reviewed, importId),
    env.DB.prepare("UPDATE fuel_sources SET last_checked_at=?1,updated_at=?1 WHERE source_id=?2").bind(now, body.sourceId),
    env.DB.prepare("INSERT INTO fuel_source_health_checks(check_id,source_id,status,checked_at,records_count) VALUES(?1,?2,'online',?3,?4)").bind(crypto.randomUUID(), body.sourceId, now, accepted),
  ]);
  return json({ ok: true, importId, received: records.length, accepted, reviewed }, 202, request, env);
}

export async function handleFuelRequest(request, env, auth) {
  const url = new URL(request.url); const path = url.pathname;
  if (request.method === "GET" && path === "/api/fuel/v1/health") return health(request, env);
  if (request.method === "GET" && path === "/api/fuel/v1/stations") return listStations(request, env, url);
  if (request.method === "GET" && path === "/api/fuel/v1/nearby") return nearby(request, env, url);
  if (request.method === "GET" && path.startsWith("/api/fuel/v1/stations/")) return stationDetail(request, env, decodeURIComponent(path.slice(22)));
  if (request.method === "POST" && path === "/api/fuel/v1/import") return importStations(request, env, auth.authorized);
  if (request.method === "POST" && path === "/api/fuel/v1/partner/import") return importPartnerStations(request, env, auth.authorized, json);
  if (request.method === "POST" && path === "/api/fuel/v1/accessibility/import") return importAccessibility(request, env, auth.authorized);
  if (request.method === "GET" && path === "/api/fuel/admin/overview") {
    if (!auth.authorizedAdmin()) return json({ error: "unauthorized" }, 401, request, env);
    const result = await env.DB.prepare("SELECT status,COUNT(*) count FROM fuel_moderation_queue GROUP BY status").all();
    return json({ moderation: rows(result) }, 200, request, env);
  }
  return null;
}
