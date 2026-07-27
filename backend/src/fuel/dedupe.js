import { haversineKm } from "./domain.js";

const rows = (result) => result?.results || [];
const normalize = (value) => String(value || "").normalize("NFKD").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const aliases = new Map([
  ["кло", "klo"], ["окко", "okko"], ["укрнафта", "ukrnafta"], ["ukr nafta", "ukrnafta"],
  ["брсм", "brsm"], ["брсм нафта", "brsm"], ["brsm nafta", "brsm"],
  ["батнафта", "batnafta"], ["батнанефть", "batnafta"], ["batnafta", "batnafta"],
  ["авиас", "avias"], ["авіас", "avias"], ["амик", "amic"], ["амік", "amic"],
  ["тат нафта", "tatnafta"], ["татнафта", "tatnafta"], ["татнефть", "tatnafta"],
  ["сан ойл", "sunoil"], ["санойл", "sunoil"], ["sun oil", "sunoil"],
]);
const genericNames = new Set(["", "азс", "агзс", "агнкс", "заправка", "автозаправка", "fuel", "gas station", "petrol station"]);

export function canonicalFuelBrand(station) {
  const raw = normalize(station?.brand || station?.operator_name || station?.canonical_name).replace(/^(?:азс|агзс)\s+/u, "");
  return genericNames.has(raw) ? "" : aliases.get(raw) || raw;
}

function facilityProfile(station) {
  const text = normalize([station?.canonical_name, station?.brand, station?.operator_name, station?.services_json].filter(Boolean).join(" "));
  const gas = /\u0430\u0433\u0437\u0441|\u0430\u0433\u043d\u043a\u0441|\u0433\u0430\u0437|\u043f\u0440\u043e\u043f\u0430\u043d|\u043c\u0435\u0442\u0430\u043d|\bgas\b|\blpg\b|\bcng\b/u.test(text);
  const liquid = /\u0431\u0435\u043d\u0437|\u0434\u0438\u0437|\u0434\u043f\b|\bpetrol\b|\bdiesel\b/u.test(text);
  return gas && !liquid ? "gas_only" : liquid && !gas ? "liquid" : gas && liquid ? "mixed" : "unknown";
}
function sameAddress(left, right) {
  const a = normalize(left.address); const b = normalize(right.address);
  return a.length >= 6 && b.length >= 6 && a === b;
}

export function catalogDuplicateDecision(left, right) {
  const distanceKm = haversineKm(Number(left.latitude), Number(left.longitude), Number(right.latitude), Number(right.longitude));
  if (!Number.isFinite(distanceKm) || distanceKm > 0.03) return { duplicate: false, distanceKm, reason: "distance" };
  const leftFacility = facilityProfile(left); const rightFacility = facilityProfile(right);
  if ((leftFacility === "gas_only" && rightFacility === "liquid") || (leftFacility === "liquid" && rightFacility === "gas_only")) return { duplicate: false, distanceKm, reason: "facility_type_conflict" };
  if ((leftFacility === "gas_only" && rightFacility === "unknown") || (leftFacility === "unknown" && rightFacility === "gas_only")) return { duplicate: false, distanceKm, reason: "facility_type_uncertain" };
  const leftBrand = canonicalFuelBrand(left); const rightBrand = canonicalFuelBrand(right);
  if (leftBrand && rightBrand && leftBrand !== rightBrand) return { duplicate: false, distanceKm, reason: "brand_conflict" };
  if (leftBrand && rightBrand && leftBrand === rightBrand && distanceKm <= 0.025) return { duplicate: true, distanceKm, reason: "same_brand" };
  if ((!leftBrand || !rightBrand) && distanceKm <= 0.012) return { duplicate: true, distanceKm, reason: "generic_overlap" };
  if ((!leftBrand || !rightBrand) && distanceKm <= 0.025 && sameAddress(left, right)) return { duplicate: true, distanceKm, reason: "same_address" };
  return { duplicate: false, distanceKm, reason: "insufficient_evidence" };
}

function quality(station) {
  return (canonicalFuelBrand(station) ? 8 : 0) + (!genericNames.has(normalize(station.canonical_name)) ? 3 : 0) + (station.address ? 2 : 0) + Math.min(8, Number(station.source_count || 0) * 2) + (Number(station.has_carta) ? 6 : 0) + Math.min(3, String(station.services_json || "").length / 500);
}
function mergeServices(left, right) {
  const parse = (value) => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
  const a = parse(left); const b = parse(right); const media = { ...(a.media || {}), ...(b.media || {}) };
  const images = [...(a.media?.imageUrls || []), ...(b.media?.imageUrls || []), a.media?.imageUrl, b.media?.imageUrl].filter(Boolean);
  if (images.length) media.imageUrls = [...new Set(images)].slice(0, 12);
  return JSON.stringify({ ...a, ...b, ...(Object.keys(media).length ? { media } : {}) });
}

export async function deduplicateFuelCatalog(request, env, authorized, json) {
  if (!authorized()) return json({ error: "unauthorized" }, 401, request, env);
  const body = await request.json().catch(() => ({})); const apply = body.apply === true; const limit = Math.max(1, Math.min(300, Number(body.limit) || 200));
  const stations = rows(await env.DB.prepare("SELECT s.*, (SELECT COUNT(*) FROM fuel_station_source_records r WHERE r.station_id=s.station_id) source_count, EXISTS(SELECT 1 FROM fuel_station_source_records r WHERE r.station_id=s.station_id AND r.source_id='carta-ua') has_carta FROM fuel_stations s WHERE s.lifecycle_status='active'").all());
  const cell = 0.0005; const buckets = new Map();
  for (const station of stations) { const x = Math.floor(station.latitude / cell); const y = Math.floor(station.longitude / cell); const key = `${x}:${y}`; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(station); station.__cell = [x, y]; }
  const pairs = [];
  for (const left of stations) for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (const right of buckets.get(`${left.__cell[0] + dx}:${left.__cell[1] + dy}`) || []) {
    if (left.station_id >= right.station_id) continue; const decision = catalogDuplicateDecision(left, right); if (decision.duplicate) pairs.push({ left, right, ...decision });
  }
  pairs.sort((a, b) => a.distanceKm - b.distanceKm);
  const parent = new Map(stations.map((station) => [station.station_id, station.station_id])); const brandSets = new Map(stations.map((station) => [station.station_id, new Set([canonicalFuelBrand(station)].filter(Boolean))]));
  const find = (id) => { let root = id; while (parent.get(root) !== root) root = parent.get(root); while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; } return root; };
  for (const pair of pairs) { const a = find(pair.left.station_id); const b = find(pair.right.station_id); if (a === b) continue; const brands = new Set([...brandSets.get(a), ...brandSets.get(b)]); if (brands.size > 1) continue; parent.set(b, a); brandSets.set(a, brands); }
  const groups = new Map(); for (const station of stations) { const root = find(station.station_id); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(station); }
  const merges = [];
  for (const group of groups.values()) { if (group.length < 2) continue; const ordered = group.slice().sort((a, b) => quality(b) - quality(a) || a.station_id.localeCompare(b.station_id)); const target = ordered[0]; for (const source of ordered.slice(1)) merges.push({ source, target, decision: catalogDuplicateDecision(source, target) }); }
  const selected = merges.filter((item) => item.decision.duplicate).slice(0, limit);
  if (!apply) return json({ apply: false, stations: stations.length, candidatePairs: pairs.length, mergeCount: selected.length, merges: selected.map((item) => ({ sourceId: item.source.station_id, targetId: item.target.station_id, sourceName: item.source.canonical_name, targetName: item.target.canonical_name, distanceMeters: Math.round(item.decision.distanceKm * 1000), reason: item.decision.reason })) }, 200, request, env);
  const now = new Date().toISOString(); const statements = [];
  for (const item of selected) {
    const { source, target, decision } = item; const services = mergeServices(target.services_json, source.services_json);
    statements.push(
      env.DB.prepare("UPDATE fuel_stations SET canonical_name=CASE WHEN canonical_name IS NULL OR canonical_name IN ('АЗС','АГЗС','азс','агзс') THEN COALESCE(?1,canonical_name) ELSE canonical_name END,brand=COALESCE(brand,?2),operator_name=COALESCE(operator_name,?3),address=COALESCE(address,?4),phone=COALESCE(phone,?5),website=COALESCE(website,?6),services_json=?7,catalog_confidence=MAX(catalog_confidence,?8),updated_at=?9 WHERE station_id=?10").bind(source.canonical_name, source.brand, source.operator_name, source.address, source.phone, source.website, services, source.catalog_confidence || 0, now, target.station_id),
      env.DB.prepare("UPDATE fuel_station_source_records SET station_id=?1,updated_at=?2 WHERE station_id=?3").bind(target.station_id, now, source.station_id),
      env.DB.prepare("UPDATE fuel_status_observations SET station_id=?1 WHERE station_id=?2").bind(target.station_id, source.station_id),
      env.DB.prepare("UPDATE fuel_availability_observations SET station_id=?1 WHERE station_id=?2").bind(target.station_id, source.station_id),
      env.DB.prepare("UPDATE fuel_price_observations SET station_id=?1 WHERE station_id=?2").bind(target.station_id, source.station_id),
      env.DB.prepare("UPDATE fuel_reports SET station_id=?1 WHERE station_id=?2").bind(target.station_id, source.station_id),
      env.DB.prepare("UPDATE fuel_incident_signals SET matched_station_id=?1 WHERE matched_station_id=?2").bind(target.station_id, source.station_id),
      env.DB.prepare("UPDATE fuel_moderation_queue SET station_id=?1 WHERE station_id=?2").bind(target.station_id, source.station_id),
      env.DB.prepare("INSERT OR IGNORE INTO fuel_station_merge_history(merge_id,source_station_id,target_station_id,action,reason,actor_id,reversible_snapshot_json,occurred_at) VALUES(?1,?2,?3,'merge',?4,'catalog-deduper-v1',?5,?6)").bind(`catalog-v1:${source.station_id}:${target.station_id}`, source.station_id, target.station_id, decision.reason, JSON.stringify({ source, target, distanceKm: decision.distanceKm }), now),
      env.DB.prepare("UPDATE fuel_stations SET lifecycle_status='merged',updated_at=?1 WHERE station_id=?2").bind(now, source.station_id),
    );
  }
  for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
  return json({ apply: true, stations: stations.length, candidatePairs: pairs.length, merged: selected.length, remainingCandidateMerges: Math.max(0, merges.length - selected.length) }, 200, request, env);
}
