import { normalizeToken, updatesToEvents, validateEvent } from "./domain/events.js";
import { detectSourceVolumeDrop, screenUpdates } from "./domain/quality.js";
import { DASHBOARD_URL, parseEdgeDelayDashboard, parseRelayDelayMarkdown } from "./adapters/delay-dashboard.js";
import { collectTelegram } from "../../scripts/source-adapters/telegram.mjs";

const SNAPSHOT_KEY = "public:v1:snapshot";
const WORKER_VERSION = "intelligence-v3";
const FRESH_MINUTES = 20;
const DEGRADED_MINUTES = 60;
const STREAM_RETRY_MS = 10_000;

function snapshotFreshness(snapshot, now = Date.now()) {
  const generatedAt = Date.parse(snapshot?.generatedAt || "");
  if (!Number.isFinite(generatedAt)) {
    return { status: "unavailable", ageMinutes: null, label: "Снимок отсутствует", message: "Нет корректного времени последнего снимка" };
  }
  const ageMinutes = Math.max(0, (now - generatedAt) / 60_000);
  if (ageMinutes <= FRESH_MINUTES) {
    return { status: "ok", ageMinutes, label: "Свежие данные", message: "Автоматический контур обновляется штатно" };
  }
  if (ageMinutes <= DEGRADED_MINUTES) {
    return { status: "degraded", ageMinutes, label: "Задержка обновления", message: "Новый снимок не поступил в ожидаемое окно" };
  }
  return { status: "unavailable", ageMinutes, label: "Данные устарели", message: "Расчётные позиции должны считаться замороженными" };
}

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

function authorizedAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || "");
  return token.length >= 24 && request.headers.get("Authorization") === "Bearer " + token;
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
  const quality = screenUpdates(Array.isArray(payload?.updates) ? payload.updates : [], Date.parse(observedAt));
  const updates = quality.accepted;
  const generated = updatesToEvents(updates, { observedAt });
  const provided = Array.isArray(payload?.events) ? payload.events : [];
  const events = [...new Map([...generated, ...provided].map((event) => [event.eventId, event])).values()];
  const validEvents = events.filter((event) => validateEvent(event).valid);
  const updateByRun = new Map();
  for (const event of validEvents) {
    if (event.rawUpdate) updateByRun.set(event.runId, event);
  }

  const statements = [];
  for (const item of quality.quarantined) {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO quarantine(quarantine_id,observed_at,source_id,train_number,reasons_json,raw_update_json)
      VALUES(?1,?2,?3,?4,?5,?6)
    `).bind(crypto.randomUUID(), observedAt, item.sourceId, item.trainNumber, safeJson(item.errors), safeJson(item.update)));
  }
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
  for (const event of validEvents.filter((item) => item.type === "station_report" && item.station)) {
    const previous = await env.DB.prepare(`SELECT station, occurred_at, raw_update_json FROM events WHERE run_id=?1 AND event_type='station_report' AND occurred_at<?2 ORDER BY occurred_at DESC LIMIT 1`).bind(event.runId,event.occurredAt).first();
    const minutes=previous?.occurred_at?(Date.parse(event.occurredAt)-Date.parse(previous.occurred_at))/60000:null;
    if(previous?.station&&previous.station!==event.station&&minutes>1&&minutes<720){
      const fromId=normalizeToken(previous.station),toId=normalizeToken(event.station);const history=await env.DB.prepare("SELECT travel_minutes FROM segment_observations WHERE train_number=?1 AND from_station_id=?2 AND to_station_id=?3 ORDER BY observed_at DESC LIMIT 199").bind(event.trainNumber,fromId,toId).all();
      const values=[...(history.results||[]).map(row=>Number(row.travel_minutes)).filter(Number.isFinite),minutes].sort((a,b)=>a-b);const percentile=p=>values[Math.min(values.length-1,Math.max(0,Math.round((values.length-1)*p)))];const mean=values.reduce((a,b)=>a+b,0)/values.length;const variance=values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length;
      let previousRaw={};try{previousRaw=JSON.parse(previous.raw_update_json||"{}");}catch{}const currentRaw=event.rawUpdate||{};const entryDelay=Number(previousRaw.delayMinutes),exitDelay=Number(currentRaw.delayMinutes);const date=new Date(event.occurredAt),month=date.getUTCMonth()+1,season=[12,1,2].includes(month)?"winter":[3,4,5].includes(month)?"spring":[6,7,8].includes(month)?"summer":"autumn";const category=String(currentRaw.sourceId||"").includes("suburban")?"suburban":currentRaw.trainCategory||"passenger";
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO segment_observations(observation_id,run_id,train_number,train_category,from_station_id,to_station_id,departed_at,arrived_at,travel_minutes,weekday,season,entry_delay_minutes,exit_delay_minutes,recovered_minutes,dwell_minutes,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL,?15)").bind(crypto.randomUUID(),event.runId,event.trainNumber,category,fromId,toId,previous.occurred_at,event.occurredAt,Number(minutes.toFixed(2)),date.getUTCDay(),season,Number.isFinite(entryDelay)?entryDelay:null,Number.isFinite(exitDelay)?exitDelay:null,Number.isFinite(entryDelay)&&Number.isFinite(exitDelay)?Number((entryDelay-exitDelay).toFixed(2)):null,observedAt));
      statements.push(env.DB.prepare(`INSERT INTO segment_stats(from_station_id,to_station_id,train_family,sample_count,mean_minutes,variance_minutes,p10_minutes,p50_minutes,p90_minutes,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(from_station_id,to_station_id,train_family) DO UPDATE SET sample_count=excluded.sample_count,mean_minutes=excluded.mean_minutes,variance_minutes=excluded.variance_minutes,p10_minutes=excluded.p10_minutes,p50_minutes=excluded.p50_minutes,p90_minutes=excluded.p90_minutes,updated_at=excluded.updated_at`).bind(fromId,toId,event.trainNumber,values.length,Number(mean.toFixed(2)),Number(variance.toFixed(2)),Number(percentile(.1).toFixed(2)),Number(percentile(.5).toFixed(2)),Number(percentile(.9).toFixed(2)),observedAt));
    }
  }  for (const event of validEvents) {
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
    quality: { accepted: updates.length, quarantined: quality.quarantined.length, warningCounts: quality.warningCounts, checkedAt: quality.checkedAt },
  };
  if (env.SNAPSHOT) await env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(snapshot), { expirationTtl: 900 });
  return { accepted: validEvents.length, rejected: events.length - validEvents.length, quarantined: quality.quarantined.length, runs: updateByRun.size, snapshot };
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

async function readSnapshot(env) {
  const cached = env.SNAPSHOT ? await env.SNAPSHOT.get(SNAPSHOT_KEY, "json") : null;
  return cached || snapshotFromDb(env);
}

async function readSegmentStats(env, limit = 300) {
  const result = await env.DB.prepare(`
    SELECT from_station_id, to_station_id, train_family, sample_count, mean_minutes, p10_minutes, p50_minutes, p90_minutes, updated_at
    FROM segment_stats ORDER BY sample_count DESC, updated_at DESC LIMIT ?1
  `).bind(limit).all();
  return result.results || [];
}

async function getSnapshot(request, env) {
  const [baseSnapshot, segmentStats] = await Promise.all([readSnapshot(env), readSegmentStats(env)]);
  const snapshot = { ...baseSnapshot, segmentStats };
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
  const [database, sources, snapshot, segmentStats] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS runs FROM runs").first(),
    env.DB.prepare("SELECT * FROM source_health ORDER BY checked_at DESC").all(),
    readSnapshot(env),
    readSegmentStats(env),
  ]);
  const freshness = snapshotFreshness(snapshot);
  return json({
    status: freshness.status,
    checkedAt: new Date().toISOString(),
    version: WORKER_VERSION,
    runs: Number(database?.runs || 0),
    snapshot: { generatedAt: snapshot?.generatedAt || null, ageMinutes: freshness.ageMinutes, updates: snapshot?.updates?.length || 0 },
    sources: sources.results || [],
    positioning: { learnedSegments: segmentStats.length, model: "rail-posterior-v3" },
  }, { headers: { "Cache-Control": "no-store" } }, request, env);
}
async function getAdminOverview(request, env) {
  const [runs, events, sources, recentEvents, snapshot, segmentStats] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total, MAX(last_observed_at) AS latest FROM runs").first(),
    env.DB.prepare("SELECT COUNT(*) AS total, MAX(observed_at) AS latest FROM events").first(),
    env.DB.prepare("SELECT * FROM source_health ORDER BY checked_at DESC").all(),
    env.DB.prepare(`
      SELECT e.run_id, e.event_type, e.station, e.observed_at, e.source_id, r.train_number
      FROM events e LEFT JOIN runs r ON r.run_id=e.run_id
      ORDER BY e.observed_at DESC LIMIT 30
    `).all(),
    readSnapshot(env),
    readSegmentStats(env),
  ]);
  const freshness = snapshotFreshness(snapshot);
  return json({
    status: freshness.status,
    checkedAt: new Date().toISOString(),
    version: WORKER_VERSION,
    pipeline: {
      status: freshness.status,
      snapshotAgeMinutes: freshness.ageMinutes,
      freshnessLabel: freshness.label,
      message: freshness.message,
      expectedRefreshMinutes: 5,
      streamRetryMs: STREAM_RETRY_MS,
    },
    runs: { total: Number(runs?.total || 0), latest: runs?.latest || null },
    events: { total: Number(events?.total || 0), latest: events?.latest || null },
    snapshot: snapshot ? {
      generatedAt: snapshot.generatedAt,
      observedAt: snapshot.observedAt || null,
      updates: Array.isArray(snapshot.updates) ? snapshot.updates.length : 0,
      sourceStatus: snapshot.sourceStatus || null,
    } : null,
    coverage: {
      discovered: snapshot?.updates?.length || 0,
      routed: (snapshot?.updates || []).filter((item) => item.origin && item.destination).length,
      forecasted: (snapshot?.updates || []).filter((item) => item.forecastArrival || item.forecastDeparture).length,
      stationAnchored: (snapshot?.updates || []).filter((item) => item.reportedStation).length,
      quarantined: snapshot?.quality?.quarantined || 0,
      qualityWarnings: snapshot?.quality?.warningCounts || {},
      learnedSegments: segmentStats.length,
    },
    sources: sources.results || [],
    recentEvents: (recentEvents.results || []).map((event) => ({
      runId: event.run_id,
      trainNumber: event.train_number || null,
      type: event.event_type,
      station: event.station || null,
      observedAt: event.observed_at,
      sourceId: event.source_id,
    })),
  }, { headers: { "Cache-Control": "no-store" } }, request, env);
}

async function getAdminIntelligence(request, env) {
  const [quarantine, cycles, audit, sources, incomplete] = await Promise.all([
    env.DB.prepare("SELECT * FROM quarantine ORDER BY observed_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT * FROM collection_cycles ORDER BY started_at DESC LIMIT 288").all(),
    env.DB.prepare("SELECT * FROM admin_audit ORDER BY occurred_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT * FROM source_config ORDER BY priority DESC").all(),
    env.DB.prepare("SELECT run_id,train_number,route,origin,destination,last_observed_at FROM runs WHERE route IS NULL OR origin IS NULL OR destination IS NULL ORDER BY last_observed_at DESC LIMIT 100").all(),
  ]);
  return json({ quarantine: quarantine.results||[], cycles: cycles.results||[], audit: audit.results||[], sourceConfig: sources.results||[], incompleteRuns: incomplete.results||[] }, {headers:{"Cache-Control":"no-store"}}, request, env);
}

async function auditAdmin(env, action, target, details={}) {
  await env.DB.prepare("INSERT INTO admin_audit(audit_id,occurred_at,actor,role,action,target,details_json) VALUES(?1,?2,'token-admin','admin',?3,?4,?5)")
    .bind(crypto.randomUUID(),new Date().toISOString(),action,target||null,safeJson(details)).run();
}

async function handleAdminAction(request, env) {
  const body=await request.json();
  if(body.action==="retry-collector") { await auditAdmin(env,body.action,"pipeline"); return json(await scheduledRefresh(env),{status:202},request,env); }
  if(body.action==="resolve-quarantine") {
    await env.DB.prepare("UPDATE quarantine SET status='resolved',resolution=?1,resolved_at=?2,resolved_by='token-admin' WHERE quarantine_id=?3").bind(body.resolution||"dismissed",new Date().toISOString(),body.id).run();
    await auditAdmin(env,body.action,body.id,{resolution:body.resolution}); return json({ok:true}, {}, request, env);
  }
  if(body.action==="configure-source") {
    await env.DB.prepare("INSERT INTO source_config(source_id,enabled,priority,reliability,updated_at,updated_by) VALUES(?1,?2,?3,?4,?5,'token-admin') ON CONFLICT(source_id) DO UPDATE SET enabled=excluded.enabled,priority=excluded.priority,reliability=excluded.reliability,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(body.sourceId,body.enabled===false?0:1,Number(body.priority)||50,Math.max(0,Math.min(1,Number(body.reliability)||.5)),new Date().toISOString()).run();
    await auditAdmin(env,body.action,body.sourceId,body); return json({ok:true}, {}, request, env);
  }
  return json({error:"unknown_action"},{status:400},request,env);
}
async function getSnapshotStream(request, env) {
  const snapshot = await readSnapshot(env);
  const freshness = snapshotFreshness(snapshot);
  const event = {
    generatedAt: snapshot?.generatedAt || null,
    updates: Array.isArray(snapshot?.updates) ? snapshot.updates.length : 0,
    status: freshness.status,
  };
  const headers = new Headers(corsHeaders(request, env));
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  return new Response(`retry: ${STREAM_RETRY_MS}\nevent: snapshot\ndata: ${JSON.stringify(event)}\n\n`, { headers });
}
export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && ["/admin.html", "/rail-ops-center.html"].includes(url.pathname)) {
      return json({ error: "not_found" }, { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } }, request, env);
    }
    if (request.method === "GET" && ["/rail-ops", "/rail-ops/"].includes(url.pathname) && env.ASSETS) {
      const assetUrl = new URL("/rail-ops-center.html", request.url);
      const response = await env.ASSETS.fetch(new Request(assetUrl, request));
      const headers = new Headers(response.headers);
      headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (request.method === "GET" && url.pathname === "/api/health") return getHealth(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/stream") return getSnapshotStream(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/segment-stats") return json({ segments: await readSegmentStats(env), aggregateOnly: true }, { headers: { "Cache-Control": "public, max-age=300" } }, request, env);
    if (["GET","POST"].includes(request.method) && url.pathname === "/api/admin/intelligence") {
      if (!authorizedAdmin(request, env)) return json({ error: "unauthorized" }, { status: 401 }, request, env);
      return request.method === "GET" ? getAdminIntelligence(request, env) : handleAdminAction(request, env);
    }    if (request.method === "GET" && url.pathname === "/api/admin/overview") {
      if (!authorizedAdmin(request, env)) return json({ error: "unauthorized" }, { status: 401 }, request, env);
      return getAdminOverview(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/snapshot") return getSnapshot(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/events") return getEvents(request, env);
    if (request.method === "POST" && url.pathname === "/api/v1/ingest") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, { status: 401 }, request, env);
      const result = await ingestPayload(env, await request.json());
      return json(result, { status: 202, headers: { "Cache-Control": "no-store" } }, request, env);
    }
    if (request.method === "GET" && env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "not_found" }, { status: 404 }, request, env);
  } catch (error) {
    console.error("request failed", error);
    return json({ error: "internal_error", message: String(error?.message || error) }, { status: 500 }, request, env);
  }
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`upstream snapshot HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

async function finishCycle(env, cycleId, startedMs, result, status="success", error=null) {
  await env.DB.prepare("UPDATE collection_cycles SET finished_at=?1,status=?2,duration_ms=?3,new_events=?4,accepted_updates=?5,quarantined_updates=?6,sources_online=?7,sources_total=2,error=?8 WHERE cycle_id=?9")
    .bind(new Date().toISOString(),status,Date.now()-startedMs,Number(result?.accepted||0),Number(result?.snapshot?.updates?.length||0),Number(result?.quarantined||0),Number(result?.freshSources||0),error,cycleId).run();
  return result;
}
export async function scheduledRefresh(env) {
  const checkedAt = new Date().toISOString();
  const cycleId=crypto.randomUUID(), cycleStarted=Date.now();
  await env.DB.prepare("INSERT INTO collection_cycles(cycle_id,started_at,status) VALUES(?1,?2,?3)").bind(cycleId,checkedAt,"running").run();
  const previous = await readSnapshot(env);
  let merged = [...(previous?.updates || [])];
  const errors = [];
  let freshSources = 0;

  try {
    const response=await fetchWithRetry(DASHBOARD_URL);const edgeUpdates=parseEdgeDelayDashboard(await response.text(),checkedAt);if(!edgeUpdates.length)throw new Error("edge delay dashboard returned no trains");const previousDashboard=merged.filter(update=>update.sourceId==="uz-delay-dashboard").length;const directDrop=detectSourceVolumeDrop(previousDashboard,edgeUpdates.length);if(directDrop.anomaly)throw new Error(`dashboard volume anomaly ${directDrop.next}/${directDrop.previous}`);
    merged=[...merged.filter(update=>update.sourceId!=="uz-delay-dashboard"),...edgeUpdates];freshSources+=1;
    await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-direct",status:"online",checkedAt},edgeUpdates.length);await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-edge",status:"online",checkedAt},edgeUpdates.length);
  } catch(error) {
    const directError=String(error?.message||error);errors.push(`dashboard-direct: ${directError}`);await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-direct",status:"unavailable",checkedAt,error:directError},0);
    try {
      const relayResponse=await fetchWithRetry("https://r.jina.ai/http://uz-vezemo.uz.gov.ua/delayform/");const relayUpdates=parseRelayDelayMarkdown(await relayResponse.text(),checkedAt);if(!relayUpdates.length)throw new Error("relay returned no dashboard rows");const previousDashboard=merged.filter(update=>update.sourceId==="uz-delay-dashboard").length;const relayDrop=detectSourceVolumeDrop(previousDashboard,relayUpdates.length);if(relayDrop.anomaly)throw new Error(`relay volume anomaly ${relayDrop.next}/${relayDrop.previous}`);
      merged=[...merged.filter(update=>update.sourceId!=="uz-delay-dashboard"),...relayUpdates];freshSources+=1;await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-relay",status:"online",checkedAt},relayUpdates.length);await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-edge",status:"online",checkedAt,error:`direct channel: ${directError}; read-only relay active`},relayUpdates.length);
    } catch(relayError) {
      errors.push(`dashboard-relay: ${String(relayError?.message||relayError)}`);
      try {
        const mirrorResponse=await fetchWithRetry("https://raw.githubusercontent.com/hermano-us/rail-ukraine-pulse/main/data/live.json");const mirror=await mirrorResponse.json();const mirrorUpdates=(mirror.updates||[]).filter(update=>update.sourceId==="uz-delay-dashboard");const mirrorAge=Math.max(0,(Date.parse(checkedAt)-Date.parse(mirror.generatedAt||""))/60000);if(!mirrorUpdates.length||!Number.isFinite(mirrorAge)||mirrorAge>180)throw new Error(`official mirror is too old (${Math.round(mirrorAge)} min)`);
        merged=[...merged.filter(update=>update.sourceId!=="uz-delay-dashboard"),...mirrorUpdates];const mirrorStatus=mirrorAge<=30?"online":"stale";if(mirrorStatus==="online")freshSources+=1;await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-edge",status:mirrorStatus,checkedAt,error:`direct: ${directError}; relay: ${String(relayError?.message||relayError)}; mirror age ${Math.round(mirrorAge)} min`},mirrorUpdates.length);
      } catch(mirrorError) { await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-edge",status:"unavailable",checkedAt,error:`${directError}; relay: ${String(relayError?.message||relayError)}; mirror: ${String(mirrorError?.message||mirrorError)}`},0); }
    }
  }
  try {
    const telegram = await collectTelegram();
    merged = [...merged.filter((update) => update.sourceId !== "uz-suburban-telegram"), ...(telegram.updates || [])];
    freshSources += 1;
    await storeSourceHealth(env, { sourceId: "uz-telegram-edge", status: "online", checkedAt }, telegram.updates?.length || 0);
  } catch (error) {
    errors.push(`telegram: ${String(error?.message || error)}`);
    await storeSourceHealth(env, { sourceId: "uz-telegram-edge", status: "unavailable", checkedAt, error: String(error?.message || error) }, 0);
  }

  if (freshSources > 0) {
    const result = await ingestPayload(env, {
      generatedAt: checkedAt,
      sourceStatus: {
        sourceId: "uz-public-fusion", status: "online", checkedAt,
        label: `UZ edge fusion: ${merged.length} событий · ${freshSources}/2 edge-источников`,
        capabilities: { officialStatus: true, forecast: true, stationPassage: true, gps: false, scope: "public-passenger-and-commuter-events" },
      },
      updates: merged,
    }, checkedAt);
    await storeSourceHealth(env, { sourceId: "pipeline-monitor", status: "online", checkedAt }, merged.length);
    return finishCycle(env,cycleId,cycleStarted,{ edge: true, freshSources, errors, ...result });
  }

  if (env.UPSTREAM_SNAPSHOT_URL) {
    try {
      const response = await fetchWithRetry(env.UPSTREAM_SNAPSHOT_URL);
      const payload = await response.json();
      const result = await ingestPayload(env, payload);
      await storeSourceHealth(env, { sourceId: "pipeline-monitor", status: "online", checkedAt }, payload?.updates?.length || 0);
      return finishCycle(env,cycleId,cycleStarted,result);
    } catch (error) {
      errors.push(`upstream: ${String(error?.message || error)}`);
    }
  }

  const freshness = snapshotFreshness(previous);
  await storeSourceHealth(env, {
    sourceId: "pipeline-monitor",
    status: freshness.status === "ok" ? "online" : freshness.status === "degraded" ? "stale" : "unavailable",
    checkedAt, error: errors.join("; ").slice(0, 500),
  }, Array.isArray(previous?.updates) ? previous.updates.length : 0);
  return finishCycle(env,cycleId,cycleStarted,{ monitored: true, errors, freshness },"failed",errors.join("; ").slice(0,500));
}
export default {
  fetch: handleRequest,
  scheduled(_controller, env, context) {
    context.waitUntil(scheduledRefresh(env));
  },
};

