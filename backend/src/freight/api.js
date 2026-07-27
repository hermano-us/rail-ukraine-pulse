import { classifyFreightText } from "../../../scripts/source-adapters/freight-telegram.mjs";

const rows = (result) => result?.results || [];
function json(value, status = 200) { return new Response(`${JSON.stringify(value)}\n`, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } }); }

export async function handleFreightRequest(request, env, auth) {
  const url = new URL(request.url); const path = url.pathname;
  if (request.method === "POST" && path === "/api/v1/freight/ingest") {
    if (!auth.authorized()) return json({ error: "unauthorized" }, 401);
    const body = await request.json(); const observations = Array.isArray(body.observations) ? body.observations : []; const sources = Array.isArray(body.sources) ? body.sources : [];
    if (observations.length > 500 || sources.length > 50) return json({ error: "payload_too_large" }, 400);
    const now = new Date().toISOString(); const statements = []; let accepted = 0;
    for (const item of observations) {
      if (!item.observationId || !String(item.sourceId || "").startsWith("freight-tg-") || !item.sourceUrl || item.publicEligible === true || "latitude" in item || "longitude" in item) continue;
      const classification = classifyFreightText(item.evidenceExcerpt); if (!classification.accepted || classification.restricted) continue;
      const occurredAt = Number.isFinite(Date.parse(item.occurredAt)) ? new Date(item.occurredAt).toISOString() : null; const confidence = Math.max(0.01, Math.min(0.65, Number(item.confidence) || 0.1));
      if (!occurredAt || !["tank_cars", "containers", "grain", "bulk", "general_freight", "unclassified_rail"].includes(item.freightType)) continue;
      statements.push(env.DB.prepare("INSERT INTO freight_observations(observation_id,source_id,source_url,occurred_at,received_at,corridor_code,freight_type,confidence,content_fingerprint,evidence_excerpt,moderation_status,public_eligible) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',0) ON CONFLICT(observation_id) DO UPDATE SET received_at=excluded.received_at,confidence=MAX(freight_observations.confidence,excluded.confidence)").bind(String(item.observationId).slice(0, 180), String(item.sourceId).slice(0, 100), String(item.sourceUrl).slice(0, 500), occurredAt, now, String(item.corridor || "unresolved").slice(0, 80), item.freightType, confidence, String(item.contentFingerprint || "").slice(0, 80), String(item.evidenceExcerpt || "").slice(0, 400))); accepted += 1;
      statements.push(env.DB.prepare("INSERT INTO restricted_evidence(evidence_id,domain,source_id,source_url,occurred_at,received_at,content_fingerprint,evidence_excerpt,classification_json,corridor_code,confidence,sensitivity_level,review_status,created_at,updated_at) VALUES(?1,'rail_freight',?2,?3,?4,?5,?6,?7,?8,?9,?10,'restricted','pending',?5,?5) ON CONFLICT(evidence_id) DO UPDATE SET received_at=excluded.received_at,confidence=MAX(restricted_evidence.confidence,excluded.confidence),classification_json=excluded.classification_json,updated_at=excluded.updated_at").bind(String(item.observationId).slice(0, 180), String(item.sourceId).slice(0, 100), String(item.sourceUrl).slice(0, 500), occurredAt, now, String(item.contentFingerprint || "").slice(0, 80), String(item.evidenceExcerpt || "").slice(0, 400), JSON.stringify({ freightType: item.freightType, locomotive: classification.entities?.locomotive||null, direction: classification.entities?.direction||null, station: classification.entities?.station||null, ingestion: "telegram-preview", inference: classification.entities?.direction?"directional-corridor":"corridor-only" }), String(item.corridor || "unresolved").slice(0, 80), confidence));
    }
    for (const source of sources) statements.push(env.DB.prepare("INSERT INTO freight_source_health(source_id,status,checked_at,preview_messages,accepted_observations,restricted_dropped,rejected_noise,error) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(source_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,preview_messages=excluded.preview_messages,accepted_observations=excluded.accepted_observations,restricted_dropped=excluded.restricted_dropped,rejected_noise=excluded.rejected_noise,error=excluded.error").bind(String(source.sourceId || "").slice(0, 100), String(source.status || "unknown").slice(0, 40), source.checkedAt || now, Number(source.previewMessages || 0), Number(source.acceptedObservations || 0), Number(source.restricted || 0), Number(source.rejected || 0), source.error ? String(source.error).slice(0, 500) : null));
    for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
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
