import { hasPermission, writeSecureAudit } from "../security/access.js";

const json = (value, status = 200) => new Response(`${JSON.stringify(value)}\n`, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const rows = (result) => result?.results || [];
const STATUSES = new Set(["pending", "in_review", "corroborated", "rejected", "needs_context", "expired"]);

export async function handleEvidenceRequest(request, env, principal) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/restricted/evidence")) return null;
  if (!hasPermission(principal, "evidence.read")) return json({ error: "forbidden" }, principal ? 403 : 401);
  if (request.method === "GET" && url.pathname === "/api/restricted/evidence") {
    const status = url.searchParams.get("status") || "pending"; const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));
    const result = status === "all"
      ? await env.DB.prepare(`SELECT * FROM restricted_evidence ORDER BY occurred_at DESC LIMIT ${limit}`).all()
      : await env.DB.prepare(`SELECT * FROM restricted_evidence WHERE review_status=?1 ORDER BY occurred_at DESC LIMIT ${limit}`).bind(status).all();
    return json({ evidence: rows(result), visibility: "restricted", exactPositionPolicy: "source-and-confidence-labelled" });
  }
  if (request.method === "POST" && url.pathname === "/api/restricted/evidence/review") {
    if (!hasPermission(principal, "evidence.review")) return json({ error: "forbidden" }, 403);
    const body = await request.json(); const evidenceId = String(body.evidenceId || ""); const status = String(body.status || "");
    if (!evidenceId || !STATUSES.has(status)) return json({ error: "invalid_review" }, 400);
    const evidence = await env.DB.prepare("SELECT domain,sensitivity_level FROM restricted_evidence WHERE evidence_id=?1").bind(evidenceId).first();
    if (!evidence) return json({ error: "evidence_not_found" }, 404);
    const safetyQuarantine = evidence.domain === "rail_freight_safety" || evidence.sensitivity_level === "highly_restricted";
    if (safetyQuarantine && (status === "corroborated" || body.linkedRunId)) return json({ error: "safety_quarantine_cannot_be_promoted" }, 409);
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE restricted_evidence SET review_status=?1,reviewed_by=?2,reviewed_at=?3,resolution_note=?4,linked_run_id=COALESCE(?5,linked_run_id),updated_at=?3 WHERE evidence_id=?6")
      .bind(status, principal.id, now, String(body.note || "").slice(0, 1000), body.linkedRunId || null, evidenceId).run();
    const freightStatus = status === "corroborated" || status === "rejected" || status === "expired" ? status : "pending";
    await env.DB.prepare("UPDATE freight_observations SET moderation_status=?1 WHERE observation_id=?2").bind(freightStatus, evidenceId).run();
    await writeSecureAudit(env, principal, "evidence.reviewed", "restricted_evidence", evidenceId, { status, linkedRunId: body.linkedRunId || null });
    return json({ ok: true, evidenceId, status });
  }
  return json({ error: "not_found" }, 404);
}
