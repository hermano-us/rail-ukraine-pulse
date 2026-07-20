import { updatesToEvents, validateEvent } from "./domain/events.js";

const SNAPSHOT_KEY = "public:v1:snapshot";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGIN || "*").split(",").map((item) => item.trim());
  const accessOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": accessOrigin || "null",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(value, init = {}, request = new Request("https://local/"), env = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, headerValue] of Object.entries(corsHeaders(request, env))) headers.set(key, headerValue);
  return new Response(`${JSON.stringify(value)}\n`, { ...init, headers });
}

function authorized(request, env) {
  const token = String(env.INGEST_TOKEN || "");
  return token.length >= 24 && request.headers.get("Authorization") === `Bearer ${token}`;
}

function safeJson(value) {
  return JSON.stringify(value ?? null);
}

async function storeSourceHealth(env, sourceStatus, recordsCount) {
  if (!sourceStatus?.sourceId) return;
  await env.DB.prepare(`
    INSERT INTO source_health(source_id, status, checked_at, records_count, error)
    VALUES(?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(source_id) DO UPDATE SET
      status=excluded.status, checked_at=excluded.checked_at,
      records_count=excluded.records_count, error=excluded.error
  `).bind(
    sourceStatus.sourceId,
    sourceStatus.status || "unknown",
    sourceStatus.checkedAt || new Date().toISOString(),
    recordsCount,
    sourceStatus.error || null,
  ).run();
}

export async function ingestPayload(env, payload, observedAt = new Date().toISOString()) {
  const updates = Array.isArray(payload?.updates) ? payload.updates : [];
  const generated = updatesToEvents(updates, { observedAt });
  const provided = Array.isArray(payload?.events) ? payload.events : [];
  const events = [...new Map([...generated, ...provided].map((event) => [event.eventId, event])).values()];
  const validEvents = events.filter((event) => validateEvent(event).valid);
  const updateByRun = new Map();
  for (const event of validEvents) {
    if (event.rawUpdate) updateByRun.set(event.runId, event);
  }

  const statements = [];
  for (const event of updateByRun.values()) {
    const update = event.rawUpdate;
    statements.push(env.DB.prepare(`
      INSERT INTO runs(
        run_id, train_number, service_date, route, origin, destination,
        current_update_json, first_observed_at, last_observed_at
      ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      ON CONFLICT(run_id) DO UPDATE SET
        route=excluded.route, origin=excluded.origin, destination=excluded.destination,
        current_update_json=excluded.current_update_json,
        last_observed_at=excluded.last_observed_at
    `).bind(
      event.runId, event.trainNumber, event.serviceDate, update.route || null,
      update.origin || null, update.destination || null, safeJson(update), event.observedAt,
    ));
  }
  for (const event of validEvents) {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO events(
        event_id, run_id, event_type, event_value_json, station,
        occurred_at, observed_at, source_id, source_url, authority,
        reliability, position_evidence, raw_update_json
      ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `).bind(
      event.eventId, event.runId, event.type, safeJson(event.value), event.station,
      event.occurredAt, event.observedAt, event.sourceId, event.sourceUrl,
      event.authority, event.reliability, event.positionEvidence, safeJson(event.rawUpdate),
    ));
  }
  if (statements.length) await env.DB.batch(statements);
  await storeSourceHealth(env, payload?.sourceStatus, updates.length);

  const snapshot = {
    schemaVersion: 6,
    provider: "Rail Ukraine Pulse event backend",
    generatedAt: payload?.generatedAt || observedAt,
    observedAt,
    sourceStatus: payload?.sourceStatus || {
      sourceId: "event-backend", status: validEvents.length ? "online" : "stale",
      label: `Event backend: ${validEvents.length} events`, checkedAt: observedAt,
    },
    updates,
    eventCount: validEvents.length,
  };
  if (env.SNAPSHOT) await env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(snapshot), { expirationTtl: 900 });
  return { accepted: validEvents.length, rejected: events.length - validEvents.length, runs: updateByRun.size, snapshot };
}

async function snapshotFromDb(env) {
  const result = await env.DB.prepare(`
    SELECT current_update_json, last_observed_at FROM runs
    WHERE last_observed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 hours')
    ORDER BY last_observed_at DESC LIMIT 1000
  `).all();
  const rows = result.results || [];
  const updates = rows.map((row) => JSON.parse(row.current_update_json));
  const generatedAt = updates.reduce((latest, update) => {
    const candidate = Number.isFinite(Date.parse(update.updatedAt)) ? update.updatedAt : latest;
    return Date.parse(candidate) > Date.parse(latest) ? candidate : latest;
  }, rows[0]?.last_observed_at || "1970-01-01T00:00:00.000Z");
  return {
    schemaVersion: 6,
    provider: "Rail Ukraine Pulse event backend",
    generatedAt,
    sourceStatus: {
      sourceId: "event-backend", status: updates.length ? "online" : "stale",
      label: `Event backend: ${updates.length} active runs`, checkedAt: new Date().toISOString(),
    },
    updates,
  };
}

async function getSnapshot(request, env) {
  const cached = env.SNAPSHOT ? await env.SNAPSHOT.get(SNAPSHOT_KEY, "json") : null;
  const snapshot = cached || await snapshotFromDb(env);
  const body = `${JSON.stringify(snapshot)}\n`;
  const etag = `W/\"${body.length}-${snapshot.generatedAt}\"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ...corsHeaders(request, env), ETag: etag } });
  }
  return json(snapshot, { headers: { "Cache-Control": "no-store", ETag: etag } }, request, env);
}

async function getEvents(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const since = url.searchParams.get("since") || "1970-01-01T00:00:00.000Z";
  const runId = url.searchParams.get("runId");
  const query = runId
    ? `SELECT * FROM events WHERE run_id=?1 AND observed_at>?2 ORDER BY observed_at DESC LIMIT ?3`
    : `SELECT * FROM events WHERE observed_at>?1 ORDER BY observed_at DESC LIMIT ?2`;
  const statement = runId
    ? env.DB.prepare(query).bind(runId, since, limit)
    : env.DB.prepare(query).bind(since, limit);
  const result = await statement.all();
  const events = (result.results || []).map((row) => ({
    eventId: row.event_id, runId: row.run_id, type: row.event_type,
    value: JSON.parse(row.event_value_json), station: row.station,
    occurredAt: row.occurred_at, observedAt: row.observed_at,
    sourceId: row.source_id, sourceUrl: row.source_url,
    authority: row.authority, reliability: row.reliability,
    positionEvidence: row.position_evidence,
  }));
  return json({ events, count: events.length }, { headers: { "Cache-Control": "no-store" } }, request, env);
}

async function getHealth(request, env) {
  const database = await env.DB.prepare("SELECT COUNT(*) AS runs FROM runs").first();
  const sources = await env.DB.prepare("SELECT * FROM source_health ORDER BY checked_at DESC").all();
  return json({
    status: "ok", checkedAt: new Date().toISOString(), runs: Number(database?.runs || 0),
    sources: sources.results || [],
  }, { headers: { "Cache-Control": "no-store" } }, request, env);
}

export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") return getHealth(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/snapshot") return getSnapshot(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/events") return getEvents(request, env);
    if (request.method === "POST" && url.pathname === "/api/v1/ingest") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, { status: 401 }, request, env);
      const result = await ingestPayload(env, await request.json());
      return json(result, { status: 202, headers: { "Cache-Control": "no-store" } }, request, env);
    }
    return json({ error: "not_found" }, { status: 404 }, request, env);
  } catch (error) {
    console.error("request failed", error);
    return json({ error: "internal_error", message: String(error?.message || error) }, { status: 500 }, request, env);
  }
}

export async function scheduledRefresh(env) {
  if (!env.UPSTREAM_SNAPSHOT_URL) return { skipped: true };
  const response = await fetch(env.UPSTREAM_SNAPSHOT_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`upstream snapshot HTTP ${response.status}`);
  return ingestPayload(env, await response.json());
}

export default {
  fetch: handleRequest,
  scheduled(_controller, env, context) {
    context.waitUntil(scheduledRefresh(env));
  },
};

