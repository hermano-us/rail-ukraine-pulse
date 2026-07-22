import { haversineKm, parseBbox } from "./domain.js";

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
const publicStation = (row) => ({ id: row.station_id, name: row.canonical_name || row.brand || "АЗС", brand: row.brand, operator: row.operator_name, lat: row.latitude, lng: row.longitude, region: row.region_code, city: row.city, address: row.address, openingHours: row.opening_hours, phone: row.phone, website: row.website, paymentCards: Boolean(row.payment_cards), services: safeParse(row.services_json), catalogConfidence: row.catalog_confidence, status: row.public_status || "unknown", statusConfidence: row.status_confidence || 0, statusVerifiedAt: row.status_verified_at, statusExpiresAt: row.status_expires_at, conflictState: row.conflict_state || "none", fuels: safeParse(row.fuel_json), prices: safeParse(row.prices_json), resolvedAt: row.resolved_at });

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
  if (zoom < 8) {
    const cell = zoom <= 5 ? 1 : zoom === 6 ? 0.5 : 0.22;
    const result = await env.DB.prepare(`SELECT AVG(s.latitude) lat,AVG(s.longitude) lng,COUNT(*) count FROM fuel_stations s LEFT JOIN fuel_current_state c ON c.station_id=s.station_id WHERE ${where} GROUP BY CAST(s.latitude/${cell} AS INTEGER),CAST(s.longitude/${cell} AS INTEGER) LIMIT 1000`).bind(...binds).all();
    return json({ mode: "clusters", clusters: rows(result).map((item) => ({ lat: item.lat, lng: item.lng, count: item.count })), bbox: [minLng, minLat, maxLng, maxLat] }, 200, request, env, "public, max-age=60");
  }
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 1200));
  const result = await env.DB.prepare(`SELECT s.*,c.public_status,c.status_confidence,c.status_verified_at,c.status_expires_at,c.conflict_state,c.fuel_json,c.prices_json,c.resolved_at FROM fuel_stations s LEFT JOIN fuel_current_state c ON c.station_id=s.station_id WHERE ${where} LIMIT ${limit}`).bind(...binds).all();
  return json({ mode: "stations", stations: rows(result).map(publicStation), bbox: [minLng, minLat, maxLng, maxLat] }, 200, request, env, "public, max-age=45");
}

async function stationDetail(request, env, stationId) {
  const station = await env.DB.prepare("SELECT s.*,c.public_status,c.status_confidence,c.status_verified_at,c.status_expires_at,c.conflict_state,c.fuel_json,c.prices_json,c.resolved_at FROM fuel_stations s LEFT JOIN fuel_current_state c ON c.station_id=s.station_id WHERE s.station_id=?1 AND s.lifecycle_status='active'").bind(stationId).first();
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

export async function handleFuelRequest(request, env, auth) {
  const url = new URL(request.url); const path = url.pathname;
  if (request.method === "GET" && path === "/api/fuel/v1/health") return health(request, env);
  if (request.method === "GET" && path === "/api/fuel/v1/stations") return listStations(request, env, url);
  if (request.method === "GET" && path === "/api/fuel/v1/nearby") return nearby(request, env, url);
  if (request.method === "GET" && path.startsWith("/api/fuel/v1/stations/")) return stationDetail(request, env, decodeURIComponent(path.slice(22)));
  if (request.method === "POST" && path === "/api/fuel/v1/import") return importStations(request, env, auth.authorized);
  if (request.method === "GET" && path === "/api/fuel/admin/overview") {
    if (!auth.authorizedAdmin()) return json({ error: "unauthorized" }, 401, request, env);
    const result = await env.DB.prepare("SELECT status,COUNT(*) count FROM fuel_moderation_queue GROUP BY status").all();
    return json({ moderation: rows(result) }, 200, request, env);
  }
  return null;
}
