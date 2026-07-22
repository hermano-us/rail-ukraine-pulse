import { expiryFor, haversineKm, resolveCurrentState } from "./domain.js";

const rows = (result) => result?.results || [];
const VALID_STATUSES = new Set(["operating", "partially_operating", "temporarily_closed", "closed", "fuel_unavailable", "damaged_reported", "unknown"]);

export function classifyFuelIncidentText(value) {
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase("uk-UA");
  const fuel = /(азс|агзс|заправ[\p{L}-]*|автозаправ[\p{L}-]*|fuel station|petrol station)/u.test(text);
  if (!fuel) return { type: "unknown", confidence: 0 };
  if (/(віднов[\p{L}-]* роботу|возобнов[\p{L}-]* работ|знову працю|reopen)/u.test(text)) return { type: "possible_reopening", confidence: 0.68 };
  if (/(удар|влучан|пошкод|зруйн|поражен|обстріл|атак|вибух|destroy|damage|strike)/u.test(text)) return { type: "possible_damage", confidence: 0.72 };
  if (/(не працю|закрит|припинил[\p{L}-]* роботу|closed|shutdown)/u.test(text)) return { type: "possible_closure", confidence: 0.62 };
  return { type: "status_report", confidence: 0.35 };
}

function validUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

async function nearestStation(env, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 44 || lat > 53 || lng < 21 || lng > 41) return null;
  const delta = 0.018;
  const candidates = rows(await env.DB.prepare("SELECT station_id,canonical_name,brand,latitude,longitude,address,city FROM fuel_stations WHERE lifecycle_status='active' AND latitude BETWEEN ?1 AND ?2 AND longitude BETWEEN ?3 AND ?4 LIMIT 100").bind(lat - delta, lat + delta, lng - delta, lng + delta).all());
  return candidates.map((station) => ({ ...station, distanceKm: haversineKm(lat, lng, station.latitude, station.longitude) })).filter((station) => station.distanceKm <= 1.5).sort((a, b) => a.distanceKm - b.distanceKm)[0] || null;
}

export async function ingestIncidentSignals(request, env, authorized, json) {
  if (!authorized()) return json({ error: "unauthorized" }, 401, request, env);
  const body = await request.json();
  const signals = Array.isArray(body.signals) ? body.signals : [];
  if (!signals.length || signals.length > 100) return json({ error: "invalid_signals", maxSignals: 100 }, 400, request, env);
  const now = new Date().toISOString(); let accepted = 0; let located = 0;
  for (const signal of signals) {
    const sourceUrl = validUrl(signal.sourceUrl); const title = String(signal.title || "").trim().slice(0, 500);
    const signalId = String(signal.signalId || "").slice(0, 180);
    if (!signalId || !sourceUrl || !title) continue;
    const classified = classifyFuelIncidentText(`${title} ${signal.snippet || ""}`);
    if (classified.type === "unknown") continue;
    const lat = Number(signal.lat); const lng = Number(signal.lng); const nearest = await nearestStation(env, lat, lng);
    const confidence = Math.min(0.85, Math.max(0.1, Number(signal.confidence) || classified.confidence) * (nearest ? Math.max(0.55, 1 - nearest.distanceKm / 2) : 0.55));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO fuel_incident_signals(signal_id,source_id,source_name,source_url,title,snippet,published_at,detected_at,incident_type,location_text,latitude,longitude,matched_station_id,match_distance_km,confidence,moderation_status,raw_payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'pending',?16) ON CONFLICT(signal_id) DO UPDATE SET detected_at=excluded.detected_at,matched_station_id=COALESCE(fuel_incident_signals.matched_station_id,excluded.matched_station_id),match_distance_km=COALESCE(fuel_incident_signals.match_distance_km,excluded.match_distance_km),confidence=MAX(fuel_incident_signals.confidence,excluded.confidence),raw_payload_json=excluded.raw_payload_json").bind(signalId, String(signal.sourceId || "news-monitor").slice(0, 100), String(signal.sourceName || "News monitor").slice(0, 160), sourceUrl, title, String(signal.snippet || "").slice(0, 1200) || null, signal.publishedAt || null, now, classified.type, String(signal.locationText || "").slice(0, 300) || null, Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, nearest?.station_id || null, nearest?.distanceKm || null, confidence, JSON.stringify(signal.raw || {})),
      env.DB.prepare("INSERT OR IGNORE INTO fuel_moderation_queue(queue_id,entity_type,entity_id,station_id,priority,reason,status,created_at) VALUES(?1,'incident_signal',?2,?3,?4,?5,'open',?6)").bind(`incident:${signalId}`, signalId, nearest?.station_id || null, classified.type === "possible_damage" ? 90 : 70, nearest ? `news_${classified.type}:nearest_${nearest.distanceKm.toFixed(2)}km` : `news_${classified.type}:location_required`, now),
    ]);
    accepted += 1; if (nearest) located += 1;
  }
  return json({ ok: true, received: signals.length, accepted, located, publicChanges: 0, moderationRequired: true }, 202, request, env);
}

export async function listIncidentSignals(request, env, authorizedAdmin, json, url) {
  if (!authorizedAdmin()) return json({ error: "unauthorized" }, 401, request, env);
  const status = ["pending", "approved", "rejected"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "pending";
  const result = await env.DB.prepare("SELECT i.*,s.canonical_name station_name,s.brand station_brand,s.address station_address FROM fuel_incident_signals i LEFT JOIN fuel_stations s ON s.station_id=i.matched_station_id WHERE i.moderation_status=?1 ORDER BY i.detected_at DESC LIMIT 200").bind(status).all();
  return json({ signals: rows(result), status }, 200, request, env);
}

async function recomputeStation(env, stationId, now) {
  const statusRows = rows(await env.DB.prepare("SELECT status,observed_at observedAt,expires_at expiresAt,source_type sourceType,confidence sourceReliability,moderation_status moderationStatus,evidence_json FROM fuel_status_observations WHERE station_id=?1 ORDER BY observed_at DESC LIMIT 30").bind(stationId).all());
  const state = resolveCurrentState({ statuses: statusRows }, Date.parse(now));
  await env.DB.prepare("INSERT INTO fuel_current_state(station_id,public_status,status_confidence,status_verified_at,status_expires_at,conflict_state,fuel_json,prices_json,resolved_at,resolver_version,evidence_summary_json) VALUES(?1,?2,?3,?4,?5,?6,'{}','{}',?7,?8,?9) ON CONFLICT(station_id) DO UPDATE SET public_status=excluded.public_status,status_confidence=excluded.status_confidence,status_verified_at=excluded.status_verified_at,status_expires_at=excluded.status_expires_at,conflict_state=excluded.conflict_state,resolved_at=excluded.resolved_at,resolver_version=excluded.resolver_version,evidence_summary_json=excluded.evidence_summary_json").bind(stationId, state.publicStatus, state.statusConfidence, state.statusVerifiedAt, state.statusExpiresAt, state.conflictState, state.resolvedAt, state.resolverVersion, JSON.stringify(state.evidenceSummary)).run();
  return state;
}

export async function reviewIncidentSignal(request, env, authorizedAdmin, json) {
  if (!authorizedAdmin()) return json({ error: "unauthorized" }, 401, request, env);
  const body = await request.json(); const signalId = String(body.signalId || ""); const decision = body.decision;
  if (!signalId || !["approve", "reject"].includes(decision)) return json({ error: "invalid_review" }, 400, request, env);
  const signal = await env.DB.prepare("SELECT * FROM fuel_incident_signals WHERE signal_id=?1").bind(signalId).first();
  if (!signal) return json({ error: "not_found" }, 404, request, env);
  const now = new Date().toISOString();
  if (decision === "reject") {
    await env.DB.batch([env.DB.prepare("UPDATE fuel_incident_signals SET moderation_status='rejected',reviewed_at=?1,reviewed_by='token-admin' WHERE signal_id=?2").bind(now, signalId), env.DB.prepare("UPDATE fuel_moderation_queue SET status='rejected',resolved_at=?1 WHERE queue_id=?2").bind(now, `incident:${signalId}`)]);
    return json({ ok: true, decision }, 200, request, env);
  }
  const stationId = String(body.stationId || signal.matched_station_id || ""); const status = String(body.status || (signal.incident_type === "possible_reopening" ? "operating" : "damaged_reported"));
  if (!stationId || !VALID_STATUSES.has(status) || !(await env.DB.prepare("SELECT 1 ok FROM fuel_stations WHERE station_id=?1 AND lifecycle_status='active'").bind(stationId).first())) return json({ error: "station_and_valid_status_required" }, 400, request, env);
  const observedAt = signal.published_at && Number.isFinite(Date.parse(signal.published_at)) ? new Date(signal.published_at).toISOString() : now; const expiresAt = expiryFor("status", observedAt);
  const observationId = `incident:${signalId}`;
  await env.DB.batch([
    env.DB.prepare("UPDATE fuel_incident_signals SET moderation_status='approved',matched_station_id=?1,reviewed_at=?2,reviewed_by='token-admin' WHERE signal_id=?3").bind(stationId, now, signalId),
    env.DB.prepare("INSERT INTO fuel_status_observations(observation_id,station_id,status,public_reason,private_reason,observed_at,submitted_at,expires_at,source_id,source_type,user_id,confidence,moderation_status,evidence_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'moderator','token-admin',?10,'approved',?11) ON CONFLICT(observation_id) DO UPDATE SET station_id=excluded.station_id,status=excluded.status,public_reason=excluded.public_reason,private_reason=excluded.private_reason,observed_at=excluded.observed_at,expires_at=excluded.expires_at,confidence=excluded.confidence,moderation_status='approved',evidence_json=excluded.evidence_json").bind(observationId, stationId, status, String(body.publicReason || "Статус проверен оператором").slice(0, 300), signal.title, observedAt, now, expiresAt, signal.source_id, Math.min(0.95, Number(signal.confidence) + 0.12), JSON.stringify({ sourceUrl: signal.source_url, signalId })),
    env.DB.prepare("UPDATE fuel_moderation_queue SET station_id=?1,status='resolved',resolved_at=?2 WHERE queue_id=?3").bind(stationId, now, `incident:${signalId}`),
    env.DB.prepare("INSERT INTO fuel_audit_log(audit_id,actor_id,actor_role,action,entity_type,entity_id,details_json,occurred_at) VALUES(?1,'token-admin','admin','review_incident','fuel_incident_signal',?2,?3,?4)").bind(crypto.randomUUID(), signalId, JSON.stringify({ decision, stationId, status }), now),
  ]);
  return json({ ok: true, decision, stationId, state: await recomputeStation(env, stationId, now) }, 200, request, env);
}
