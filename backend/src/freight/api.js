import { classifyFreightText } from "../../../scripts/source-adapters/freight-telegram.mjs";
import { buildPublicFreightProjection } from "./public-projection.js";

const rows = (result) => result?.results || [];
function json(value, status = 200) { return new Response(`${JSON.stringify(value)}\n`, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } }); }
function publicJson(value) { return new Response(`${JSON.stringify(value)}\n`, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, stale-while-revalidate=300", "Access-Control-Allow-Origin": "*" } }); }

function inferredCorridor(entities = {}, fallback = "unresolved") {
  if (fallback && fallback !== "unresolved") return String(fallback).slice(0, 80);
  // A destination alone is ambiguous: only an explicit station/rail area may create geometry.
  const station=String(entities.station||"").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu," ");
  if (/(коростен|ірпін|ирпен|святошин)/u.test(station)) return "kyiv-korosten";
  if (/(кривий ріг|кривой рог|кривбас)/u.test(station)) return "kryvyi-rih";
  if (/(запоріж|запорож)/u.test(station)) return "zaporizhzhia";
  return "unresolved";
}

export async function handleFreightRequest(request, env, auth) {
  const url = new URL(request.url); const path = url.pathname;
  if (request.method === "GET" && path === "/api/v1/freight/public") {
    if (String(env.PUBLIC_FREIGHT_LAYER || "disabled") !== "enabled") return publicJson({ ...buildPublicFreightProjection([]), disabled: true });
    try {
      let cached = null; if (env.SNAPSHOT) { try { cached = await env.SNAPSHOT.get("freight:public-projection:v2", "json"); } catch {} }
      if (cached) return publicJson(cached);
      const result = await env.DB.prepare("SELECT evidence_id,domain,source_id,occurred_at,received_at,updated_at,content_fingerprint,classification_json,corridor_code,confidence,sensitivity_level,review_status FROM restricted_evidence WHERE domain='rail_freight' AND julianday(occurred_at)>=julianday('now','-7 days') AND MAX(julianday(occurred_at),COALESCE(julianday(received_at),julianday(occurred_at)),COALESCE(julianday(updated_at),julianday(occurred_at)))<=julianday('now','-24 hours') ORDER BY occurred_at DESC LIMIT 1000").all();
      const projection = buildPublicFreightProjection(rows(result));
      if (env.SNAPSHOT) { try { await env.SNAPSHOT.put("freight:public-projection:v2", JSON.stringify(projection), { expirationTtl: 300 }); } catch {} }
      return publicJson(projection);
    } catch (error) {
      console.error("public freight projection failed", error);
      return json({ error: "freight_projection_unavailable", objects: [], corridors: [] }, 503);
    }
  }
  if (request.method === "POST" && path === "/api/v1/freight/ingest") {
    if (!auth.authorized()) return json({ error: "unauthorized" }, 401);
    const body = await request.json(); const observations = Array.isArray(body.observations) ? body.observations : []; const sources = Array.isArray(body.sources) ? body.sources : [];
    if (observations.length > 500 || sources.length > 50) return json({ error: "payload_too_large" }, 400);
    const now = new Date().toISOString(); const statements = []; let accepted = 0;
    const candidateIds = [...new Set(observations.filter((item) => item?.observationId && String(item.sourceId || "").startsWith("freight-tg-")).map((item) => String(item.observationId).slice(0, 180)))];
    const existingIds = new Set();
    if (candidateIds.length) {
      const placeholders = candidateIds.map((_, index) => `?${index + 1}`).join(",");
      const existing = await env.DB.prepare(`SELECT evidence_id FROM restricted_evidence WHERE evidence_id IN (${placeholders})`).bind(...candidateIds).all();
      for (const row of rows(existing)) existingIds.add(String(row.evidence_id));
    }
    const seenIds = new Set(existingIds);
    for (const item of observations) {
      if (!item.observationId || !String(item.sourceId || "").startsWith("freight-tg-") || !item.sourceUrl || item.publicEligible === true || "latitude" in item || "longitude" in item) continue;
      const observationId = String(item.observationId).slice(0, 180); if (seenIds.has(observationId)) continue; seenIds.add(observationId);
      const classification = classifyFreightText(item.evidenceExcerpt); if (!classification.accepted || classification.restricted) continue;
      const occurredAt = Number.isFinite(Date.parse(item.occurredAt)) ? new Date(item.occurredAt).toISOString() : null; const confidence = Math.max(0.01, Math.min(0.65, Number(item.confidence) || 0.1)); const corridor=inferredCorridor(classification.entities,item.corridor);
      if (!occurredAt || !["tank_cars", "containers", "grain", "bulk", "general_freight", "unclassified_rail"].includes(item.freightType)) continue;
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO freight_observations(observation_id,source_id,source_url,occurred_at,received_at,corridor_code,freight_type,confidence,content_fingerprint,evidence_excerpt,moderation_status,public_eligible) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',0)").bind(observationId, String(item.sourceId).slice(0, 100), String(item.sourceUrl).slice(0, 500), occurredAt, now, corridor, item.freightType, confidence, String(item.contentFingerprint || "").slice(0, 80), String(item.evidenceExcerpt || "").slice(0, 400))); accepted += 1;
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO restricted_evidence(evidence_id,domain,source_id,source_url,occurred_at,received_at,content_fingerprint,evidence_excerpt,classification_json,corridor_code,confidence,sensitivity_level,review_status,created_at,updated_at) VALUES(?1,'rail_freight',?2,?3,?4,?5,?6,?7,?8,?9,?10,'restricted','pending',?5,?5)").bind(observationId, String(item.sourceId).slice(0, 100), String(item.sourceUrl).slice(0, 500), occurredAt, now, String(item.contentFingerprint || "").slice(0, 80), String(item.evidenceExcerpt || "").slice(0, 400), JSON.stringify({ freightType: item.freightType, locomotive: classification.entities?.locomotive||null, trainNumber: classification.entities?.trainNumber||null, direction: classification.entities?.direction||null, station: classification.entities?.station||null, stationEvidence: classification.entities?.stationEvidence||null, entityKey: classification.entities?.entityKey||null, entityConfidence: classification.entities?.entityConfidence||0, ingestion: "telegram-preview", inference: classification.entities?.station?"explicit-station-fact":classification.entities?.direction?"directional-corridor":classification.entities?.entityKey?"entity-linked-corridor":"corridor-only" }), corridor, confidence));
    }
    for (const source of sources) statements.push(env.DB.prepare("INSERT INTO freight_source_health(source_id,status,checked_at,preview_messages,accepted_observations,restricted_dropped,rejected_noise,error) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(source_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,preview_messages=excluded.preview_messages,accepted_observations=excluded.accepted_observations,restricted_dropped=excluded.restricted_dropped,rejected_noise=excluded.rejected_noise,error=excluded.error").bind(String(source.sourceId || "").slice(0, 100), String(source.status || "unknown").slice(0, 40), source.checkedAt || now, Number(source.previewMessages || 0), Number(source.acceptedObservations || 0), Number(source.restricted || 0), Number(source.rejected || 0), source.error ? String(source.error).slice(0, 500) : null));
    for (let index = 0; index < statements.length; index += 20) await env.DB.batch(statements.slice(index, index + 20));
    return json({ ok: true, received: observations.length, accepted, publicObjects: 0, policy: "private-moderation-only" }, 202);
  }
  if (request.method === "GET" && path === "/api/admin/freight") {
    if (!auth.authorizedAdmin()) return json({ error: "unauthorized" }, 401);
    const [health, counts, recent] = await Promise.all([
      env.DB.prepare("SELECT * FROM freight_source_health ORDER BY source_id").all(),
      env.DB.prepare("SELECT moderation_status,COUNT(*) count FROM freight_observations GROUP BY moderation_status").all(),
      env.DB.prepare("SELECT observation_id,source_id,source_url,occurred_at,received_at,corridor_code,freight_type,confidence,evidence_excerpt,moderation_status FROM freight_observations ORDER BY occurred_at DESC LIMIT 100").all(),
    ]);
    return json({ sources: rows(health), moderation: rows(counts), recent: rows(recent), publicObjects: 0, policy: { exactPositions: false, militaryContentStored: false, minimumIndependentConfirmations: 2 } });
  }
  return null;
}
