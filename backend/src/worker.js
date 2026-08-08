import { normalizeToken, updatesToEvents, validateEvent } from "./domain/events.js";
import { detectSourceVolumeDrop, screenUpdates } from "./domain/quality.js";
import { DASHBOARD_URL, parseEdgeDelayDashboard } from "./adapters/delay-dashboard.js";
import { collectTelegram } from "../../scripts/source-adapters/telegram.mjs";
import { handleFuelRequest } from "./fuel/api.js";
import { handleFreightRequest } from "./freight/api.js";
import { handleSecurityRequest } from "./security/api.js";
import { hasPermission, resolvePrincipal } from "./security/access.js";
import { handleEvidenceRequest } from "./evidence/api.js";
import { handleIntelligencePlatformRequest } from "./intelligence/api.js";
import { runIntelligenceCycle } from "./intelligence/service.js";
import { ingestExpectedRuns } from "./intelligence/expected-registry.js";
import { handlePublicObservationRequest } from "./intelligence/observation-submissions.js";
import { collectOfficialBoardEdge } from "./edge-board-collector.js";
import { dynamicRequestBudget } from "./intelligence/data-reliability.js";
import { pruneOperationalStorage, STORAGE_RETENTION } from "./storage-retention.js";

const SNAPSHOT_KEY = "public:v1:snapshot";
const WORKER_VERSION = "intelligence-v9-reliability-fusion";
const FRESH_MINUTES = 20;
const DEGRADED_MINUTES = 60;
const STREAM_RETRY_MS = 10_000;
const HISTORY_RETENTION_DAYS = STORAGE_RETENTION.snapshotDays;
const HISTORY_SAMPLE_MINUTES = 15;

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
  const checkedAt = sourceStatus.checkedAt || new Date().toISOString();
  const count = Number(recordsCount) || 0;
  await env.DB.batch([env.DB.prepare(`
    INSERT INTO source_health(source_id, status, checked_at, records_count, error)
    VALUES(?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(source_id) DO UPDATE SET
      status=excluded.status, checked_at=excluded.checked_at,
      records_count=excluded.records_count, error=excluded.error
  `).bind(
    sourceStatus.sourceId,
    sourceStatus.status || "unknown",
    checkedAt,
    count,
    sourceStatus.error || null,
  ), env.DB.prepare(`
    INSERT OR IGNORE INTO source_health_checks(check_id,source_id,status,checked_at,records_count,error)
    VALUES(?1,?2,?3,?4,?5,?6)
  `).bind(
    `${sourceStatus.sourceId}:${checkedAt}`,
    sourceStatus.sourceId,
    sourceStatus.status || "unknown",
    checkedAt,
    count,
    sourceStatus.error || null,
  )]);
}
async function handleCollectorBoardPriorities(request,env){
  if(!authorized(request,env))return json({error:"unauthorized"},{status:401},request,env);
  const [result,collectorsResult]=await Promise.all([
    env.DB.prepare("SELECT station_id,station_name,priority_score,expected_runs,silent_runs,ambiguous_twins,overdue_twins,minutes_since_fact,reason_json,calculated_at,priority_tier,collector_failures,next_eligible_at FROM station_coverage_priorities ORDER BY CASE priority_tier WHEN 'critical' THEN 0 WHEN 'corridor' THEN 1 ELSE 2 END,priority_score DESC LIMIT 100").all(),
    env.DB.prepare("SELECT status,COUNT(*) total FROM trusted_collector_registry WHERE last_heartbeat_at>=datetime('now','-20 minutes') GROUP BY status").all(),
  ]);
  const stations=(result?.results||[]).map((item)=>{let reasons=[];try{reasons=JSON.parse(item.reason_json||"[]");}catch{}return {stationId:item.station_id,stationName:item.station_name,priorityScore:Number(item.priority_score)||0,priorityTier:item.priority_tier||"background",expectedRuns:Number(item.expected_runs)||0,silentRuns:Number(item.silent_runs)||0,ambiguousTwins:Number(item.ambiguous_twins)||0,overdueTwins:Number(item.overdue_twins)||0,minutesSinceFact:item.minutes_since_fact==null?null:Number(item.minutes_since_fact),collectorFailures:Number(item.collector_failures)||0,nextEligibleAt:item.next_eligible_at||null,reasons,calculatedAt:item.calculated_at};});
  const collectorCounts=Object.fromEntries((collectorsResult?.results||[]).map((item)=>[item.status,Number(item.total)||0]));
  const activeCollectors=(collectorCounts.healthy||0)+(collectorCounts.starting||0),degradedCollectors=collectorCounts.degraded||0,urgentStations=stations.filter((item)=>item.priorityTier==="critical").length;
  const recommendedRequestBudget=dynamicRequestBudget({urgentStations,activeCollectors,degradedCollectors,upstreamHealthy:degradedCollectors===0||activeCollectors>0});
  return json({generatedAt:new Date().toISOString(),strategy:"information-gain-v3",recommendedRequestBudget,fleet:{activeCollectors,degradedCollectors},stations},{headers:{"Cache-Control":"no-store"}},request,env);
}
async function handleCollectorHeartbeat(request, env) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, { status: 401 }, request, env);
  const body = await request.json();
  const checkedAt = new Date().toISOString();
  const collectorId = String(body?.collectorId || "trusted-collector").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80) || "trusted-collector";
  const status = ["starting", "healthy", "degraded", "stopped"].includes(body?.status) ? body.status : "degraded";
  const heartbeat = {
    collectorId, status, checkedAt,
    version: String(body?.version || "collector-v1").slice(0, 60),
    lastStartedAt: body?.lastStartedAt || null,
    lastSucceededAt: body?.lastSucceededAt || null,
    consecutiveFailures: Math.max(0, Number(body?.consecutiveFailures) || 0),
    runs: Math.max(0, Number(body?.runs) || 0),
    board: body?.board && typeof body.board === "object" ? {
      selectedStation: String(body.board.selectedStation || "").slice(0, 120) || null,
      selectedStationId: String(body.board.selectedStationId || "").slice(0, 120) || null,
      strategy: String(body.board.strategy || "").slice(0, 80) || null,
      requestBudget: Math.max(0, Number(body.board.requestBudget) || 0),
    } : null,
  };
  if (env.SNAPSHOT) await env.SNAPSHOT.put("collector:heartbeat", JSON.stringify(heartbeat), { expirationTtl: 900 });
  const stationName=heartbeat.board?.selectedStation,stationKey=heartbeat.board?.selectedStationId||String(stationName||"").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-|-$/g,"").slice(0,120);
  const registryStatements=[env.DB.prepare(`INSERT INTO trusted_collector_registry(collector_id,version,status,request_budget,consecutive_failures,last_station_id,last_station_name,last_heartbeat_at,last_success_at,metadata_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(collector_id) DO UPDATE SET version=excluded.version,status=excluded.status,request_budget=excluded.request_budget,consecutive_failures=excluded.consecutive_failures,last_station_id=excluded.last_station_id,last_station_name=excluded.last_station_name,last_heartbeat_at=excluded.last_heartbeat_at,last_success_at=excluded.last_success_at,metadata_json=excluded.metadata_json`).bind(collectorId,heartbeat.version,status,heartbeat.board?.requestBudget||1,heartbeat.consecutiveFailures,stationKey||null,stationName,checkedAt,heartbeat.lastSucceededAt,JSON.stringify({runs:heartbeat.runs,strategy:heartbeat.board?.strategy||null}))];
  if(stationKey)registryStatements.push(env.DB.prepare(`INSERT INTO station_poll_health(collector_id,station_id,station_name,attempts,successes,consecutive_failures,records_total,last_attempt_at,last_success_at,cooldown_until,last_error,updated_at) VALUES(?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?7) ON CONFLICT(collector_id,station_id) DO UPDATE SET station_name=excluded.station_name,attempts=station_poll_health.attempts+1,successes=station_poll_health.successes+excluded.successes,consecutive_failures=excluded.consecutive_failures,records_total=station_poll_health.records_total+excluded.records_total,last_attempt_at=excluded.last_attempt_at,last_success_at=COALESCE(excluded.last_success_at,station_poll_health.last_success_at),cooldown_until=excluded.cooldown_until,last_error=excluded.last_error,updated_at=excluded.updated_at`).bind(collectorId,stationKey,stationName,status==="healthy"?1:0,heartbeat.consecutiveFailures,Math.max(0,Number(body?.recordsCount)||0),checkedAt,status==="healthy"?checkedAt:null,status==="healthy"?null:new Date(Date.parse(checkedAt)+Math.min(60,5*Math.max(1,heartbeat.consecutiveFailures))*60000).toISOString(),status==="healthy"?null:`collector ${status}`));
  await env.DB.batch(registryStatements);
  await storeSourceHealth(env, {
    sourceId: `trusted-collector:${collectorId}`, status: status === "healthy" ? "online" : status,
    checkedAt, error: status === "healthy" ? null : `collector ${status}`,
  }, Number(body?.recordsCount || 0));
  return json({ accepted: true, checkedAt }, { status: 202, headers: { "Cache-Control": "no-store" } }, request, env);
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

  // Publish the validated current view before durable history writes. If D1 is
  // temporarily full, the live map remains current while retention recovers it.
  const continuitySnapshot = {
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
    collectorDiagnostics: payload?.collectorDiagnostics || null,
    persistence: "cache-first",
  };
  if (env.SNAPSHOT) await env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(continuitySnapshot), { expirationTtl: 900 });

  await pruneOperationalStorage(env, { snapshotPasses: 2 });
  const expectedRegistry = await ingestExpectedRuns(env, payload?.expectedRuns || [], observedAt);

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
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO run_snapshots(snapshot_id,run_id,captured_at,source_updated_at,update_json)
      SELECT ?1,?2,?3,?4,?5
      WHERE NOT EXISTS (
        SELECT 1 FROM run_snapshots
        WHERE run_id=?2 AND unixepoch(captured_at)>=unixepoch(?3)-?6
      )
    `).bind(`${event.runId}:${event.observedAt}`,event.runId,event.observedAt,update.updatedAt||null,safeJson(update),HISTORY_SAMPLE_MINUTES*60));
  }
  for (const event of validEvents.filter((item) => item.type === "station_report" && item.station)) {
    const alreadyStored=await env.DB.prepare("SELECT event_id FROM events WHERE event_id=?1").bind(event.eventId).first();
    if(alreadyStored?.event_id)continue;
    const previous = await env.DB.prepare(`SELECT station, occurred_at, raw_update_json FROM events WHERE run_id=?1 AND event_type='station_report' AND occurred_at<?2 ORDER BY occurred_at DESC LIMIT 1`).bind(event.runId,event.occurredAt).first();
    const minutes=previous?.occurred_at?(Date.parse(event.occurredAt)-Date.parse(previous.occurred_at))/60000:null;
    if(previous?.station&&previous.station!==event.station&&minutes>1&&minutes<720){
      const fromId=normalizeToken(previous.station),toId=normalizeToken(event.station);const history=await env.DB.prepare("SELECT travel_minutes FROM segment_observations WHERE train_number=?1 AND from_station_id=?2 AND to_station_id=?3 ORDER BY observed_at DESC LIMIT 199").bind(event.trainNumber,fromId,toId).all();
      const baseline=await env.DB.prepare("SELECT sample_count,p10_minutes,p50_minutes,p90_minutes FROM segment_stats WHERE from_station_id=?1 AND to_station_id=?2 AND train_family=?3").bind(fromId,toId,event.trainNumber).first();
      const values=[...(history.results||[]).map(row=>Number(row.travel_minutes)).filter(Number.isFinite),minutes].sort((a,b)=>a-b);const percentile=p=>values[Math.min(values.length-1,Math.max(0,Math.round((values.length-1)*p)))];const mean=values.reduce((a,b)=>a+b,0)/values.length;const variance=values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length;
      let previousRaw={};try{previousRaw=JSON.parse(previous.raw_update_json||"{}");}catch{}const currentRaw=event.rawUpdate||{};const entryDelay=Number(previousRaw.delayMinutes),exitDelay=Number(currentRaw.delayMinutes);const date=new Date(event.occurredAt),month=date.getUTCMonth()+1,season=[12,1,2].includes(month)?"winter":[3,4,5].includes(month)?"spring":[6,7,8].includes(month)?"summer":"autumn";const category=String(currentRaw.sourceId||"").includes("suburban")?"suburban":currentRaw.trainCategory||"passenger";
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO segment_observations(observation_id,run_id,train_number,train_category,from_station_id,to_station_id,departed_at,arrived_at,travel_minutes,weekday,season,entry_delay_minutes,exit_delay_minutes,recovered_minutes,dwell_minutes,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL,?15)").bind(crypto.randomUUID(),event.runId,event.trainNumber,category,fromId,toId,previous.occurred_at,event.occurredAt,Number(minutes.toFixed(2)),date.getUTCDay(),season,Number.isFinite(entryDelay)?entryDelay:null,Number.isFinite(exitDelay)?exitDelay:null,Number.isFinite(entryDelay)&&Number.isFinite(exitDelay)?Number((entryDelay-exitDelay).toFixed(2)):null,observedAt));
      if(Number(baseline?.sample_count)>=3&&Number.isFinite(Number(baseline?.p50_minutes))){const predicted=Number(baseline.p50_minutes),low=Number(baseline.p10_minutes),high=Number(baseline.p90_minutes);statements.push(env.DB.prepare("INSERT OR IGNORE INTO model_evaluations(evaluation_id,run_id,train_number,from_station_id,to_station_id,predicted_minutes,actual_minutes,absolute_error_minutes,within_p80,baseline_samples,evaluated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)").bind(`${event.runId}:${fromId}:${toId}:${event.occurredAt}`,event.runId,event.trainNumber,fromId,toId,predicted,Number(minutes.toFixed(2)),Number(Math.abs(minutes-predicted).toFixed(2)),minutes>=low&&minutes<=high?1:0,Number(baseline.sample_count),event.occurredAt));}
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
  for (const sourceStatus of Array.isArray(payload?.sourceStatuses) ? payload.sourceStatuses : []) {
    if (!sourceStatus?.sourceId || sourceStatus.sourceId === payload?.sourceStatus?.sourceId) continue;
    await storeSourceHealth(env, sourceStatus, sourceStatus.recordsCount);
  }
  for (const [sourceId, source] of Object.entries(payload?.externalSources || {})) {
    await env.DB.prepare(`UPDATE external_rail_sources SET status=?1,last_checked_at=?2,last_success_at=CASE WHEN ?1='online' THEN ?2 ELSE last_success_at END,last_error=?3,records_count=?4,updated_at=?2 WHERE source_id=?5`)
      .bind(source?.status?.status || source?.status || "unknown", source?.status?.checkedAt || observedAt, source?.status?.error || null, Number(source?.recordsCount || 0), sourceId).run();
  }

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
    collectorDiagnostics: payload?.collectorDiagnostics || null,
  };
  if (env.SNAPSHOT) await env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(snapshot), { expirationTtl: 900 });
  return { accepted: validEvents.length, rejected: events.length - validEvents.length, quarantined: quality.quarantined.length, runs: updateByRun.size, expectedRuns: expectedRegistry.accepted, snapshot };
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

async function readModelQuality(env) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS evaluations,
      AVG(absolute_error_minutes) AS mae_minutes,
      AVG(within_p80) * 100 AS p80_coverage,
      SUM(CASE WHEN evaluation_id LIKE 'replay:%' THEN 1 ELSE 0 END) AS replay_evaluations,
      SUM(CASE WHEN evaluation_id NOT LIKE 'replay:%' THEN 1 ELSE 0 END) AS prospective_evaluations,
      MAX(evaluated_at) AS latest
    FROM model_evaluations
    WHERE evaluated_at >= datetime('now', '-30 days')
  `).first();
  return {
    evaluations: Number(row?.evaluations || 0),
    maeMinutes: row?.mae_minutes == null ? null : Number(Number(row.mae_minutes).toFixed(1)),
    p80Coverage: row?.p80_coverage == null ? null : Number(Number(row.p80_coverage).toFixed(1)),
    replayEvaluations: Number(row?.replay_evaluations || 0),
    prospectiveEvaluations: Number(row?.prospective_evaluations || 0),
    readiness: Number(row?.prospective_evaluations || 0) >= 20 ? "operational" : Number(row?.evaluations || 0) >= 10 ? "warming" : "insufficient-evidence",
    latest: row?.latest || null,
  };
}

async function getSnapshot(request, env) {
  const [baseSnapshot, segmentStats, modelQuality] = await Promise.all([readSnapshot(env), readSegmentStats(env), readModelQuality(env)]);
  const snapshot = { ...baseSnapshot, segmentStats, modelQuality };
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

async function getRunHistory(request,env){const url=new URL(request.url),runId=String(url.searchParams.get("runId")||"").trim();if(!runId)return json({error:"run_id_required"},{status:400},request,env);const limit=Math.min(6720,Math.max(2,Number(url.searchParams.get("limit"))||672)),since=url.searchParams.get("since")||new Date(Date.now()-7*24*60*60*1000).toISOString();const result=await env.DB.prepare("SELECT snapshot_id,captured_at,source_updated_at,update_json FROM run_snapshots WHERE run_id=?1 AND captured_at>=?2 ORDER BY captured_at ASC LIMIT ?3").bind(runId,since,limit).all();const snapshots=(result.results||[]).map(row=>({id:row.snapshot_id,capturedAt:row.captured_at,sourceUpdatedAt:row.source_updated_at,update:JSON.parse(row.update_json)}));return json({runId,snapshots,count:snapshots.length,retentionDays:HISTORY_RETENTION_DAYS,sampleMinutes:HISTORY_SAMPLE_MINUTES,geometryPolicy:"client-rail-network-only"},{headers:{"Cache-Control":"private, max-age=30"}},request,env);}
async function getMapTimeline(request,env){
  const url=new URL(request.url),now=new Date(),requested=new Date(url.searchParams.get("at")||now);
  if(!Number.isFinite(requested.getTime()))return json({error:"invalid_at"},{status:400},request,env);
  const rangeStart=new Date(now.getTime()-24*60*60*1000),at=new Date(Math.min(now.getTime(),Math.max(rangeStart.getTime(),requested.getTime())));
  const queryStart=new Date(at.getTime()-6*60*60*1000).toISOString();
  const cacheKey=`public:v1:timeline:${Math.floor(at.getTime()/300000)}`;
  const cached=env.SNAPSHOT?await env.SNAPSHOT.get(cacheKey,"json"):null;
  if(cached)return json({...cached,cache:"hit"},{headers:{"Cache-Control":"public, max-age=30"}},request,env);
  const result=await env.DB.prepare(`
    SELECT history.run_id,history.snapshot_id,history.captured_at,history.source_updated_at,history.update_json
    FROM run_snapshots history
    INNER JOIN (
      SELECT run_id,MAX(captured_at) AS captured_at FROM run_snapshots
      WHERE captured_at<=?1 AND captured_at>=?2 GROUP BY run_id
    ) latest ON latest.run_id=history.run_id AND latest.captured_at=history.captured_at
    ORDER BY history.captured_at DESC LIMIT 2500
  `).bind(at.toISOString(),queryStart).all();
  const snapshots=[];
  for(const row of result.results||[]){
    try{snapshots.push({runId:row.run_id,id:row.snapshot_id,capturedAt:row.captured_at,sourceUpdatedAt:row.source_updated_at,update:JSON.parse(row.update_json)});}catch{}
  }
  const payload={
    at:at.toISOString(),snapshots,count:snapshots.length,
    range:{from:rangeStart.toISOString(),to:now.toISOString(),hours:24,sampleMinutes:HISTORY_SAMPLE_MINUTES},
    geometryPolicy:"client-rail-network-only",positionSemantics:"latest-observation-at-or-before-requested-time",cache:"miss",
  };
  if(env.SNAPSHOT)await env.SNAPSHOT.put(cacheKey,JSON.stringify(payload),{expirationTtl:120});
  return json(payload,{headers:{"Cache-Control":"public, max-age=30"}},request,env);
}
async function getHealth(request, env) {
  const [database, sources, snapshot, segmentStats, modelQuality, archiveStatus] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS runs FROM runs").first(),
    env.DB.prepare("SELECT * FROM source_health ORDER BY checked_at DESC").all(),
    readSnapshot(env),
    readSegmentStats(env),
    readModelQuality(env),
    env.SNAPSHOT?.get("storage:archive:last", "json").catch(() => null) || Promise.resolve(null),
  ]);
  const freshness = snapshotFreshness(snapshot);
  return json({
    status: freshness.status,
    checkedAt: new Date().toISOString(),
    version: WORKER_VERSION,
    runs: Number(database?.runs || 0),
    snapshot: { generatedAt: snapshot?.generatedAt || null, ageMinutes: freshness.ageMinutes, updates: snapshot?.updates?.length || 0 },
    sources: visibleSourceHealth(sources.results, env),
    positioning: { learnedSegments: segmentStats.length, model: "rail-posterior-v3", quality: modelQuality },
    storageArchive: archiveStatus || { status: env.ARCHIVE ? "waiting" : "archive_unavailable" },
  }, { headers: { "Cache-Control": "no-store" } }, request, env);
}
function visibleSourceHealth(rows, env) {
  const edgeDisabled = String(env.BOARD_EDGE_MODE || "disabled") === "disabled";
  return (rows || []).filter((row) => !edgeDisabled || row.source_id !== "uz-public-board-edge");
}
async function getAdminOverview(request, env) {
  const [runs, events, sources, recentEvents, snapshot, segmentStats, modelQuality, trustedCollector] = await Promise.all([
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
    readModelQuality(env),
    env.SNAPSHOT?.get("collector:heartbeat").then((raw) => raw ? JSON.parse(raw) : null).catch(() => null) || Promise.resolve(null),
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
      collectorDiagnostics: snapshot.collectorDiagnostics || null,
      trustedCollector: trustedCollector || null,
    } : null,
    coverage: {
      discovered: snapshot?.updates?.length || 0,
      routed: (snapshot?.updates || []).filter((item) => item.origin && item.destination).length,
      forecasted: (snapshot?.updates || []).filter((item) => item.forecastArrival || item.forecastDeparture).length,
      stationAnchored: (snapshot?.updates || []).filter((item) => item.reportedStation).length,
      quarantined: snapshot?.quality?.quarantined || 0,
      qualityWarnings: snapshot?.quality?.warningCounts || {},
      learnedSegments: segmentStats.length,
      modelQuality,
    },
    sources: visibleSourceHealth(sources.results, env),
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
  const [quarantine, cycles, audit, sources, incomplete, healthChecks, modelQuality] = await Promise.all([
    env.DB.prepare("SELECT * FROM quarantine ORDER BY observed_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT * FROM collection_cycles ORDER BY started_at DESC LIMIT 288").all(),
    env.DB.prepare("SELECT * FROM admin_audit ORDER BY occurred_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT * FROM source_config ORDER BY priority DESC").all(),
    env.DB.prepare("SELECT run_id,train_number,route,origin,destination,last_observed_at FROM runs WHERE route IS NULL OR origin IS NULL OR destination IS NULL ORDER BY last_observed_at DESC LIMIT 100").all(),
    env.DB.prepare(`
      SELECT source_id,COUNT(*) AS checks,SUM(status='online') AS online_checks,
        MIN(records_count) AS min_records,MAX(records_count) AS max_records,MAX(checked_at) AS latest
      FROM source_health_checks WHERE checked_at>=datetime('now','-24 hours') GROUP BY source_id
    `).all(),
    readModelQuality(env),
  ]);
  return json({ quarantine: quarantine.results||[], cycles: cycles.results||[], audit: audit.results||[], sourceConfig: sources.results||[], incompleteRuns: incomplete.results||[], sourceHealth24h:healthChecks.results||[], modelQuality }, {headers:{"Cache-Control":"no-store"}}, request, env);
}

async function auditAdmin(env, action, target, details={}, principal=null) {
  await env.DB.prepare("INSERT INTO admin_audit(audit_id,occurred_at,actor,role,action,target,details_json) VALUES(?1,?2,?3,?4,?5,?6,?7)")
    .bind(crypto.randomUUID(),new Date().toISOString(),principal?.id||"legacy-admin",principal?.role||"admin",action,target||null,safeJson(details)).run();
}

async function handleAdminAction(request, env, principal) {
  const body=await request.json();
  const requiredPermission={"retry-collector":"system.manage","resolve-quarantine":"evidence.review","correct-station":"rail.correct","configure-source":"sources.manage"}[body.action];
  if(requiredPermission&&!hasPermission(principal,requiredPermission))return json({error:"forbidden"},{status:403},request,env);
  if(body.action==="retry-collector") { await auditAdmin(env,body.action,"pipeline",{},principal); return json(await scheduledAutonomy(env),{status:202},request,env); }
  if(body.action==="resolve-quarantine") {
    await env.DB.prepare("UPDATE quarantine SET status='resolved',resolution=?1,resolved_at=?2,resolved_by=?3 WHERE quarantine_id=?4").bind(body.resolution||"dismissed",new Date().toISOString(),principal?.id||"legacy-admin",body.id).run();
    await auditAdmin(env,body.action,body.id,{resolution:body.resolution},principal); return json({ok:true}, {}, request, env);
  }
  if(body.action==="correct-station") {
    const run=body.runId?await env.DB.prepare("SELECT * FROM runs WHERE run_id=?1").bind(body.runId).first():await env.DB.prepare("SELECT * FROM runs WHERE train_number=?1 ORDER BY last_observed_at DESC LIMIT 1").bind(String(body.trainNumber||"")).first();
    if(!run)return json({error:"run_not_found"},{status:404},request,env);const update=JSON.parse(run.current_update_json);update.reportedStation=String(body.station||"").trim();update.positionEvidence="reported-manual-review";update.sourceId="admin-correction";update.sourceEvidence="operator-reviewed";update.reliability=Math.min(Number(update.reliability)||.5,.65);update.updatedAt=new Date().toISOString();
    await env.DB.prepare("UPDATE runs SET current_update_json=?1,last_observed_at=?2 WHERE run_id=?3").bind(safeJson(update),update.updatedAt,run.run_id).run();await auditAdmin(env,body.action,run.run_id,{station:update.reportedStation,reason:body.reason||null},principal);if(env.SNAPSHOT)await env.SNAPSHOT.delete(SNAPSHOT_KEY);return json({ok:true,runId:run.run_id,station:update.reportedStation},{},request,env);
  }  if(body.action==="configure-source") {
    await env.DB.prepare("INSERT INTO source_config(source_id,enabled,priority,reliability,updated_at,updated_by) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(source_id) DO UPDATE SET enabled=excluded.enabled,priority=excluded.priority,reliability=excluded.reliability,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(body.sourceId,body.enabled===false?0:1,Number(body.priority)||50,Math.max(0,Math.min(1,Number(body.reliability)||.5)),new Date().toISOString(),principal?.id||"legacy-admin").run();
    await auditAdmin(env,body.action,body.sourceId,body,principal); return json({ok:true}, {}, request, env);
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
    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/admin/access/") || url.pathname === "/api/admin/feature-flags") {
      const response = await handleSecurityRequest(request, env);
      if (response) return response;
    }
    if (url.pathname.startsWith("/api/restricted/evidence")) {
      const response = await handleEvidenceRequest(request, env, await resolvePrincipal(request, env));
      if (response) return response;
    }
    if (["/api/restricted/rail-intelligence","/api/restricted/operations-hub","/api/restricted/analytics-network"].includes(url.pathname)) {
      const principal = await resolvePrincipal(request, env);
      const response = await handleIntelligencePlatformRequest(request, env, principal, (value, status = 200) => json(value, { status, headers: { "Cache-Control": "no-store" } }, request, env));
      if (response) return response;
    }
    if (["/api/v1/freight/ingest", "/api/v1/freight/public", "/api/admin/freight"].includes(url.pathname)) {
      const principal = url.pathname === "/api/admin/freight" ? await resolvePrincipal(request, env) : null;
      const response = await handleFreightRequest(request, env, {
        authorized: () => authorized(request, env),
        authorizedAdmin: () => authorizedAdmin(request, env) || hasPermission(principal, "evidence.read"),
      });
      if (response) return response;
    }    if (url.pathname.startsWith("/api/fuel/")) {
      const principal = url.pathname.startsWith("/api/fuel/admin/") ? await resolvePrincipal(request, env) : null;
      const response = await handleFuelRequest(request, env, {
        authorized: () => authorized(request, env),
        authorizedAdmin: () => authorizedAdmin(request, env) || hasPermission(principal, url.pathname.includes("/incidents") ? "fuel.review" : "admin.overview"),
      });
      if (response) return response;
    }
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
    if (request.method === "GET" && url.pathname === "/api/v1/collector/board-priorities") return handleCollectorBoardPriorities(request,env);
    if (request.method === "POST" && url.pathname === "/api/v1/collector/heartbeat") return handleCollectorHeartbeat(request, env);
    if (["GET","POST"].includes(request.method) && url.pathname === "/api/v1/rail-observations") return handlePublicObservationRequest(request,env,(value,status=200)=>json(value,{status,headers:{"Cache-Control":"no-store"}},request,env));
    if (request.method === "GET" && url.pathname === "/api/health") return getHealth(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/stream") return getSnapshotStream(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/segment-stats") return json({ segments: await readSegmentStats(env), aggregateOnly: true }, { headers: { "Cache-Control": "public, max-age=300" } }, request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/model-quality") return json({ ...(await readModelQuality(env)), aggregateOnly: true }, { headers: { "Cache-Control": "public, max-age=300" } }, request, env);
    if (["GET","POST"].includes(request.method) && url.pathname === "/api/admin/intelligence") {
      const principal = await resolvePrincipal(request, env);
      if (!hasPermission(principal, "admin.overview")) return json({ error: "unauthorized" }, { status: 401 }, request, env);
      return request.method === "GET" ? getAdminIntelligence(request, env) : handleAdminAction(request, env, principal);
    }    if (request.method === "GET" && url.pathname === "/api/admin/overview") {
      const principal = await resolvePrincipal(request, env);
      if (!hasPermission(principal, "admin.overview")) return json({ error: "unauthorized" }, { status: 401 }, request, env);
      return getAdminOverview(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/snapshot") return getSnapshot(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/events") return getEvents(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/history") return getRunHistory(request, env);
    if (request.method === "GET" && url.pathname === "/api/v1/timeline") return getMapTimeline(request, env);
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
  await env.DB.prepare("UPDATE collection_cycles SET finished_at=?1,status=?2,duration_ms=?3,new_events=?4,accepted_updates=?5,quarantined_updates=?6,sources_online=?7,sources_total=?8,error=?9 WHERE cycle_id=?10")
    .bind(new Date().toISOString(),status,Date.now()-startedMs,Number(result?.accepted||0),Number(result?.snapshot?.updates?.length||0),Number(result?.quarantined||0),Number(result?.freshSources||0),Number(result?.sourcesTotal||2),error,cycleId).run();
  return result;
}
export async function scheduledRefresh(env) {
  const checkedAt = new Date().toISOString();
  // Recovery must happen before collection_cycles or source-health writes.
  await pruneOperationalStorage(env, { snapshotPasses: 4 });
  const cycleId=crypto.randomUUID(), cycleStarted=Date.now();
  await env.DB.prepare("INSERT INTO collection_cycles(cycle_id,started_at,status) VALUES(?1,?2,?3)").bind(cycleId,checkedAt,"running").run();
  await env.DB.prepare("UPDATE collection_cycles SET status='failed',finished_at=?1,error=COALESCE(error,'cycle watchdog timeout') WHERE status='running' AND julianday(started_at)<julianday('now','-20 minutes')").bind(checkedAt).run();
  const previous = await readSnapshot(env);
  const configured=(await env.DB.prepare("SELECT source_id,enabled FROM source_config").all()).results||[];const sourceEnabled=id=>configured.find(item=>item.source_id===id)?.enabled!==0;
  let merged = [...(previous?.updates || [])];
  const errors = [];
  let freshSources = 0;
  let usableSources = 0;

  try {
    if(!sourceEnabled("uz-delay-dashboard"))throw new Error("source disabled by operator");
    const response=await fetchWithRetry(DASHBOARD_URL);const edgeUpdates=parseEdgeDelayDashboard(await response.text(),checkedAt);if(!edgeUpdates.length)throw new Error("edge delay dashboard returned no trains");const previousDashboard=merged.filter(update=>update.sourceId==="uz-delay-dashboard").length;const directDrop=detectSourceVolumeDrop(previousDashboard,edgeUpdates.length);if(directDrop.anomaly)throw new Error(`dashboard volume anomaly ${directDrop.next}/${directDrop.previous}`);
    merged=[...merged.filter(update=>update.sourceId!=="uz-delay-dashboard"),...edgeUpdates];freshSources+=1;usableSources+=1;await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-direct",status:"online",checkedAt},edgeUpdates.length);await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-edge",status:"online",checkedAt},edgeUpdates.length);
  } catch(error) {
    const directError=String(error?.message||error);errors.push(`dashboard-direct: ${directError}`);await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-direct",status:"unavailable",checkedAt,error:directError},0);
    try {
      if(!sourceEnabled("uz-delay-dashboard"))throw new Error("source disabled by operator");const mirrorResponse=await fetchWithRetry("https://raw.githubusercontent.com/hermano-us/rail-ukraine-pulse/main/data/live.json");const mirror=await mirrorResponse.json();const mirrorUpdates=(mirror.updates||[]).filter(update=>update.sourceId==="uz-delay-dashboard");const mirrorAge=Math.max(0,(Date.parse(checkedAt)-Date.parse(mirror.generatedAt||""))/60000);if(!mirrorUpdates.length||!Number.isFinite(mirrorAge)||mirrorAge>180)throw new Error(`official mirror is too old (${Math.round(mirrorAge)} min)`);
      merged=[...merged.filter(update=>update.sourceId!=="uz-delay-dashboard"),...mirrorUpdates];usableSources+=1;const mirrorStatus=mirrorAge<=20?"online":"stale";if(mirrorStatus==="online")freshSources+=1;await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-edge",status:mirrorStatus,checkedAt,error:`direct: ${directError}; official GitHub mirror age ${Math.round(mirrorAge)} min`},mirrorUpdates.length);await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-direct",status:"degraded",checkedAt,error:`direct transport unavailable from Cloudflare (${directError}); GitHub mirror active, age ${Math.round(mirrorAge)} min`},0);
      if(mirrorAge>12&&env.GITHUB_DISPATCH_TOKEN){const last=Number(await env.SNAPSHOT?.get("github-dispatch:last")||0);if(Date.now()-last>10*60000){const dispatched=await fetch("https://api.github.com/repos/hermano-us/rail-ukraine-pulse/actions/workflows/update-data.yml/dispatches",{method:"POST",headers:{Authorization:`Bearer ${env.GITHUB_DISPATCH_TOKEN}`,Accept:"application/vnd.github+json","User-Agent":"RailUkrainePulse/1.0","X-GitHub-Api-Version":"2022-11-28"},body:JSON.stringify({ref:"main"})});if(!dispatched.ok)throw new Error(`GitHub dispatch HTTP ${dispatched.status}`);await env.SNAPSHOT?.put("github-dispatch:last",String(Date.now()),{expirationTtl:900});await storeSourceHealth(env,{sourceId:"github-enrichment-dispatch",status:"online",checkedAt},1);}}
    } catch(mirrorError) {await storeSourceHealth(env,{sourceId:"uz-delay-dashboard-edge",status:"unavailable",checkedAt,error:`${directError}; mirror: ${String(mirrorError?.message||mirrorError)}`},0);}
  }
  try {
    if(!sourceEnabled("uz-suburban-telegram"))throw new Error("source disabled by operator");
    const telegram = await collectTelegram();
    merged = [...merged.filter((update) => update.sourceId !== "uz-suburban-telegram"), ...(telegram.updates || [])];
    freshSources += 1;
    usableSources += 1;
    await storeSourceHealth(env, { sourceId: "uz-telegram-edge", status: "online", checkedAt }, telegram.updates?.length || 0);
  } catch (error) {
    errors.push(`telegram: ${String(error?.message || error)}`);
    await storeSourceHealth(env, { sourceId: "uz-telegram-edge", status: "unavailable", checkedAt, error: String(error?.message || error) }, 0);
  }

  let collectorDiagnostics = previous?.collectorDiagnostics || null;
  const boardEdgeConfigured = Boolean(env.BOARD_EDGE_MODE && env.BOARD_EDGE_MODE !== "disabled");
  if (boardEdgeConfigured) {
    const board = await collectOfficialBoardEdge(env, { updates: merged, now: checkedAt });
    collectorDiagnostics = {
      ...(collectorDiagnostics || {}),
      board: {
        status: board.status,
        checkedAt,
        scheduler: board.diagnostics?.scheduler || null,
        coverage: board.diagnostics?.coverage || null,
        cooldownUntil: board.diagnostics?.cooldownUntil || board.diagnostics?.state?.cooldownUntil || null,
      },
    };
    if (board.status === "online") {
      const edgeCutoff = Date.parse(checkedAt) - 20 * 60_000;
      merged = [
        ...merged.filter((update) => update.sourceId !== "uz-public-board-edge" || Date.parse(update.updatedAt || "") >= edgeCutoff),
        ...(board.updates || []),
      ];
      freshSources += 1;
      usableSources += 1;
      await storeSourceHealth(env, { sourceId: "uz-public-board-edge", status: "online", checkedAt }, board.updates?.length || 0);
    } else if (board.status === "degraded") {
      errors.push(`board-edge: ${board.error || "collector degraded"}`);
      await storeSourceHealth(env, { sourceId: "uz-public-board-edge", status: "degraded", checkedAt, error: board.error || "collector degraded" }, 0);
    } else if (board.status === "cooldown") {
      await storeSourceHealth(env, { sourceId: "uz-public-board-edge", status: "stale", checkedAt, error: `cooldown until ${board.diagnostics?.cooldownUntil}` }, 0);
    }
  }

  if (usableSources > 0) {
    const sourcesTotal = boardEdgeConfigured ? 3 : 2;
    const result = await ingestPayload(env, {
      generatedAt: checkedAt,
      collectorDiagnostics,
      sourceStatus: {
        sourceId: "uz-public-fusion", status: "online", checkedAt,
        label: `UZ edge fusion: ${merged.length} событий · ${freshSources}/${sourcesTotal} edge-источников`,
        capabilities: { officialStatus: true, forecast: true, stationPassage: true, gps: false, scope: "public-passenger-and-commuter-events" },
      },
      updates: merged,
    }, checkedAt);
    await storeSourceHealth(env, { sourceId: "pipeline-monitor", status: "online", checkedAt }, merged.length);
    return finishCycle(env,cycleId,cycleStarted,{ edge: true, freshSources, usableSources, sourcesTotal, errors, ...result },freshSources>0?"success":"degraded",freshSources>0?null:errors.join("; ").slice(0,500));
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
export async function scheduledAutonomy(env) {
  const collection = await scheduledRefresh(env);
  const intelligence = await runIntelligenceCycle(env);
  return { collection, intelligence };
}
export default {
  fetch: handleRequest,
  scheduled(_controller, env, context) {
    context.waitUntil(scheduledAutonomy(env));
  },
};

