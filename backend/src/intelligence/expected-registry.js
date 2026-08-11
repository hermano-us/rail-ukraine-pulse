const rows = (result) => result?.results || [];
const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const parseTime = (value) => Number.isFinite(Date.parse(value || "")) ? Date.parse(value) : null;
const minutes = (left, right) => (Date.parse(right) - Date.parse(left)) / 60_000;
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value || "") ?? fallback; } catch { return fallback; } };
const callKey = (call = {}) => String(call.key || `${normalize(call.station)}:${call.boardType || "unknown"}:${call.scheduledAt || "unknown"}`);
function mergeRouteMetadata(previous = {}, current = {}) {
  const stationMap = new Map();
  for (const station of [...(Array.isArray(previous.stations) ? previous.stations : []), ...(Array.isArray(current.stations) ? current.stations : [])]) {
    const name = typeof station === "string" ? station : station?.station;
    if (name && !stationMap.has(normalize(name))) stationMap.set(normalize(name), station);
  }
  const calls = new Map();
  for (const call of [...(Array.isArray(previous.stationCalls) ? previous.stationCalls : []), ...(Array.isArray(current.stationCalls) ? current.stationCalls : [])]) {
    if (call?.station) calls.set(callKey(call), call);
  }
  return { ...previous, ...current, stations: [...stationMap.values()], stationCalls: [...calls.values()].sort((left, right) => Date.parse(left.scheduledAt || 0) - Date.parse(right.scheduledAt || 0)), boardObservationCount: Math.max(Number(previous.boardObservationCount) || 0, calls.size, Number(current.boardObservationCount) || 0) };
}
async function existingExpectedMetadata(env, expectedIds = []) {
  const result = new Map(), unique = [...new Set(expectedIds)].filter(Boolean);
  for (let index = 0; index < unique.length; index += 75) {
    const ids = unique.slice(index, index + 75), slots = ids.map((_, offset) => `?${offset + 1}`).join(",");
    const found = rows(await env.DB.prepare(`SELECT expected_id,metadata_json FROM expected_train_runs WHERE expected_id IN (${slots})`).bind(...ids).all());
    for (const item of found) result.set(item.expected_id, parseJson(item.metadata_json, {}));
  }
  return result;
}

export function expectedRunId(run = {}) {
  if (run.expectedId) return String(run.expectedId).slice(0, 220);
  const date = String(run.serviceDate || run.service_date || "unknown").slice(0, 10);
  const number = normalize(run.trainNumber || run.train_number).replace(/-/g, "") || "unknown";
  const direction = normalize(run.route || `${run.origin || ""}-${run.destination || ""}`) || "unknown";
  return `expected:${date}:${number}:${direction}`.slice(0, 220);
}

export function normalizeExpectedRun(run = {}, now = new Date().toISOString()) {
  const trainNumber = String(run.trainNumber || run.train_number || "").trim();
  const serviceDate = String(run.serviceDate || run.service_date || now).slice(0, 10);
  if (!trainNumber || !/^\d{1,5}(?:\/\d{1,5})?$/.test(trainNumber.replace(/^№\s*/, "")) || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return null;
  const expectedId = expectedRunId({ ...run, trainNumber, serviceDate });
  return {
    expectedId,
    runId: String(run.runId || run.run_id || expectedId.replace(/^expected:/, "uz:")).slice(0, 220),
    serviceDate,
    trainNumber: trainNumber.replace(/^№\s*/, ""),
    origin: run.origin ? String(run.origin).slice(0, 180) : null,
    destination: run.destination ? String(run.destination).slice(0, 180) : null,
    route: run.route ? String(run.route).slice(0, 400) : null,
    scheduledDeparture: parseTime(run.scheduledDeparture || run.scheduled_departure) == null ? null : new Date(parseTime(run.scheduledDeparture || run.scheduled_departure)).toISOString(),
    scheduledArrival: parseTime(run.scheduledArrival || run.scheduled_arrival) == null ? null : new Date(parseTime(run.scheduledArrival || run.scheduled_arrival)).toISOString(),
    sourceIds: [...new Set(Array.isArray(run.sourceIds) ? run.sourceIds.map(String) : [run.sourceId].filter(Boolean))].slice(0, 20),
    discoveryCount: Math.max(1, Number(run.discoveryCount) || 1),
    metadata: run.metadata && typeof run.metadata === "object" ? run.metadata : {},
  };
}

export function classifyExpectedRun(run, now = new Date().toISOString()) {
  const departure = parseTime(run.scheduled_departure), arrival = parseTime(run.scheduled_arrival), last = parseTime(run.last_observation_at);
  const current = Date.parse(now), serviceEnd = Date.parse(`${run.service_date}T23:59:59Z`);
  if (last && current - last <= 90 * 60_000) {
    const operational = normalize(run.last_operational_status);
    const boardType = normalize(run.last_board_type);
    const explicitCompletion = ["completed","terminated","finished"].includes(operational);
    if (explicitCompletion) return { status: "completed", operationalStatus:"arrived", reason: "explicit-terminal-fact", missingSince: null };
    const stationPresence = ["station","at-station","depot","waiting","dwelling"].includes(operational);
    if (stationPresence) return { status: "at_station", operationalStatus:departure && current < departure ? "awaiting_departure" : "dwelling", reason: "fresh-station-presence", missingSince: null };
    return { status: "active", operationalStatus:"moving", reason: boardType ? `fresh-${boardType}-observation` : "fresh-observation", missingSince: null };
  }
  if (last && current - last <= 360 * 60_000) return { status: "unobserved", operationalStatus:"unobserved", reason: "observation-gap", missingSince: new Date(last + 90 * 60_000).toISOString() };
  if (departure && current < departure + 20 * 60_000) return { status: "planned", operationalStatus:"awaiting_departure", reason: "departure-window-not-open", missingSince: null };
  if (!departure && current < Date.parse(`${run.service_date}T06:00:00Z`)) return { status: "planned", operationalStatus:"planned", reason: "service-day-not-open", missingSince: null };
  if (arrival && current > arrival + 180 * 60_000) return { status: "unknown_completion", operationalStatus:"unobserved", reason: "arrival-window-passed-without-fact", missingSince: new Date(arrival + 60 * 60_000).toISOString() };
  if (Number.isFinite(serviceEnd) && current > serviceEnd + 6 * 3600_000) return { status: "unknown_completion", operationalStatus:"unobserved", reason: "service-day-ended-without-fact", missingSince: new Date(serviceEnd).toISOString() };
  return { status: "unobserved", operationalStatus:"unobserved", reason: "expected-run-without-current-fact", missingSince: departure ? new Date(departure + 20 * 60_000).toISOString() : `${run.service_date}T06:00:00.000Z` };
}

export async function ingestExpectedRuns(env, input = [], now = new Date().toISOString()) {
  const runs = [...new Map(input.map((item) => normalizeExpectedRun(item, now)).filter(Boolean).map((item) => [item.expectedId, item])).values()];
  const existingMetadata = await existingExpectedMetadata(env, runs.map((run) => run.expectedId));
  for (const run of runs) run.metadata = mergeRouteMetadata(existingMetadata.get(run.expectedId), run.metadata);
  const statements = runs.map((run) => env.DB.prepare(`INSERT INTO expected_train_runs(expected_id,run_id,service_date,train_number,origin,destination,route,scheduled_departure,scheduled_arrival,status,status_reason,source_ids_json,discovery_count,first_seen_at,updated_at,metadata_json)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'planned','newly-discovered',?10,?11,?12,?12,?13)
    ON CONFLICT(expected_id) DO UPDATE SET origin=COALESCE(excluded.origin,expected_train_runs.origin),destination=COALESCE(excluded.destination,expected_train_runs.destination),route=COALESCE(excluded.route,expected_train_runs.route),scheduled_departure=COALESCE(excluded.scheduled_departure,expected_train_runs.scheduled_departure),scheduled_arrival=COALESCE(excluded.scheduled_arrival,expected_train_runs.scheduled_arrival),source_ids_json=excluded.source_ids_json,discovery_count=MAX(expected_train_runs.discovery_count,excluded.discovery_count),updated_at=excluded.updated_at,metadata_json=excluded.metadata_json`)
    .bind(run.expectedId,run.runId,run.serviceDate,run.trainNumber,run.origin,run.destination,run.route,run.scheduledDeparture,run.scheduledArrival,JSON.stringify(run.sourceIds),run.discoveryCount,now,JSON.stringify(run.metadata)));
  for (let index = 0; index < statements.length; index += 75) await env.DB.batch(statements.slice(index,index+75));
  return { accepted:runs.length, rejected:input.length-runs.length };
}

export async function refreshExpectedRunCoverage(env, now = new Date().toISOString()) {
  const expected = rows(await env.DB.prepare(`SELECT x.*,
    (SELECT COUNT(*) FROM events e LEFT JOIN observation_run_links l ON l.event_id=e.event_id AND l.status='linked' WHERE COALESCE(l.canonical_run_id,e.run_id)=x.run_id) live_event_count,
    (SELECT MAX(e.occurred_at) FROM events e LEFT JOIN observation_run_links l ON l.event_id=e.event_id AND l.status='linked' WHERE COALESCE(l.canonical_run_id,e.run_id)=x.run_id) live_last_observation,
    (SELECT e.station FROM events e LEFT JOIN observation_run_links l ON l.event_id=e.event_id AND l.status='linked' WHERE COALESCE(l.canonical_run_id,e.run_id)=x.run_id AND e.station IS NOT NULL ORDER BY e.occurred_at DESC LIMIT 1) live_last_station,
    (SELECT e.raw_update_json FROM events e LEFT JOIN observation_run_links l ON l.event_id=e.event_id AND l.status='linked' WHERE COALESCE(l.canonical_run_id,e.run_id)=x.run_id ORDER BY e.occurred_at DESC,CASE WHEN e.event_type='station_report' THEN 0 ELSE 1 END LIMIT 1) live_last_raw_update
    FROM expected_train_runs x WHERE service_date>=date(?1,'-1 day') AND service_date<=date(?1,'+1 day') ORDER BY service_date,train_number`).bind(now).all());
  const statements=[];let silent=0,active=0,planned=0,atStation=0,completed=0;
  for(const run of expected){run.observation_count=Number(run.live_event_count)||0;run.last_observation_at=run.live_last_observation||run.last_observation_at;run.last_station=run.live_last_station||run.last_station;
    const latestRaw=parseJson(run.live_last_raw_update,{});run.last_operational_status=latestRaw.operationalStatus||latestRaw.status||null;run.last_board_type=latestRaw.boardType||null;
    const state=classifyExpectedRun(run,now);if(state.status==="active")active+=1;else if(state.status==="planned")planned+=1;else if(state.status==="at_station")atStation+=1;else if(state.status==="completed")completed+=1;else silent+=1;
    statements.push(env.DB.prepare("UPDATE expected_train_runs SET status=?1,status_reason=?2,observation_count=?3,last_observation_at=?4,last_station=?5,missing_since=?6,updated_at=?7 WHERE expected_id=?8").bind(state.status,state.reason,run.observation_count,run.last_observation_at,run.last_station,state.missingSince,now,run.expected_id));
    statements.push(env.DB.prepare("UPDATE expected_train_runs SET operational_status=?1,operational_reason=?2,state_changed_at=CASE WHEN operational_status=?1 THEN state_changed_at ELSE ?3 END WHERE expected_id=?4").bind(state.operationalStatus,state.reason,now,run.expected_id));
    statements.push(env.DB.prepare(`INSERT INTO ops_movements(movement_id,run_id,train_number,movement_type,origin,destination,route,status,last_station,last_observed_at,confidence,position_status,metadata_json) VALUES(?1,?2,?3,'passenger',?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,last_station=excluded.last_station,last_observed_at=excluded.last_observed_at,confidence=excluded.confidence,position_status=excluded.position_status,metadata_json=excluded.metadata_json WHERE ops_movements.status IN ('planned','unobserved','unknown_completion','at_station','completed') OR excluded.status IN ('at_station','completed')`).bind(run.run_id,run.run_id,run.train_number,run.origin,run.destination,run.route,state.status,run.last_station,run.last_observation_at||run.scheduled_departure||now,state.status==="completed"?.9:state.status==="at_station"?.8:state.status==="active"?.7:state.status==="planned"?.35:.2,["active","at_station","completed"].includes(state.status)?"reported":state.status,JSON.stringify({expectedOnly:run.observation_count===0,expectedId:run.expected_id,statusReason:state.reason,scheduledDeparture:run.scheduled_departure,scheduledArrival:run.scheduled_arrival,stationPresence:state.status==="at_station",completed:state.status==="completed"})));
    if(["unobserved","unknown_completion"].includes(state.status)){const severity=state.status==="unknown_completion"||minutes(state.missingSince,now)>=120?"high":"medium";statements.push(env.DB.prepare(`INSERT INTO rail_coverage_gaps(gap_id,expected_id,gap_type,severity,opened_at,last_checked_at,details_json) VALUES(?1,?2,'silent_run',?3,?4,?5,?6) ON CONFLICT(expected_id,gap_type) WHERE resolved_at IS NULL DO UPDATE SET severity=excluded.severity,last_checked_at=excluded.last_checked_at,details_json=excluded.details_json`).bind(`silent:${run.expected_id}`,run.expected_id,severity,state.missingSince||now,now,JSON.stringify({trainNumber:run.train_number,route:run.route,reason:state.reason,lastObservationAt:run.last_observation_at})));statements.push(env.DB.prepare(`INSERT OR IGNORE INTO ops_workflows(workflow_id,movement_id,workflow_type,state,priority,title,description,created_by,created_at,updated_at) VALUES(?1,?2,'silent_run','open',?3,?4,?5,'observation-fusion-v2',?6,?6)`).bind(`coverage:${run.expected_id}`,run.run_id,severity,`Silent train ${run.train_number}`,`No current station fact: ${state.reason}`,now));}
    else {statements.push(env.DB.prepare("UPDATE rail_coverage_gaps SET resolved_at=?1,resolution='observation-or-schedule-state-restored',last_checked_at=?1 WHERE expected_id=?2 AND gap_type='silent_run' AND resolved_at IS NULL").bind(now,run.expected_id));statements.push(env.DB.prepare("UPDATE ops_workflows SET state='resolved',resolved_at=?1,resolution='observation-or-schedule-state-restored',updated_at=?1 WHERE workflow_id=?2 AND state!='resolved'").bind(now,`coverage:${run.expected_id}`));}
  }
  for(let index=0;index<statements.length;index+=75)await env.DB.batch(statements.slice(index,index+75));return {total:expected.length,silent,active,planned,atStation,completed};
}
