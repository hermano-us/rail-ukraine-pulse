const BASE = "https://app.uz.gov.ua/api/station-boards";
const BOARD_URL = "https://booking.uz.gov.ua/schedule";
const STATE_KEY = "collector:board-edge-state";
const HEARTBEAT_KEY = "collector:heartbeat";
const USER_AGENT = "UZ/2 Web/1 User/guest";

const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hubWeight = new Map(Object.entries({
  "\u043a\u0438\u0457\u0432 \u043f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439": 8,
  "\u043b\u044c\u0432\u0456\u0432": 7,
  "\u0434\u043d\u0456\u043f\u0440\u043e \u0433\u043e\u043b\u043e\u0432\u043d\u0438\u0439": 6.5,
  "\u0445\u0430\u0440\u043a\u0456\u0432 \u043f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439": 6.5,
  "\u043e\u0434\u0435\u0441\u0430 \u0433\u043e\u043b\u043e\u0432\u043d\u0430": 6,
}));

async function readJson(env, key) {
  try { return await env.SNAPSHOT?.get(key, "json") || null; } catch { return null; }
}

async function requestJson(url, headers, fetchImpl) {
  const started = Date.now();
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
  const diagnostics = {
    status: response.status,
    durationMs: Date.now() - started,
    retryAfter: response.headers.get("retry-after"),
    cfRay: response.headers.get("cf-ray"),
  };
  if (!response.ok) {
    const error = new Error(`official board edge HTTP ${response.status}`);
    error.status = response.status;
    error.diagnostics = diagnostics;
    throw error;
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error(`official board edge returned ${contentType || "non-JSON"}`);
  return { payload: await response.json(), diagnostics };
}

function rankStations(catalog, state, updates, nowMs, coveragePriorities = []) {
  const stationState = state?.stations || {},coverage=new Map();
  for(const priority of Array.isArray(coveragePriorities)?coveragePriorities:[])for(const value of [priority?.stationName,priority?.stationId]){const key=normalize(value);if(key)coverage.set(key,priority);}
  return (Array.isArray(catalog) ? catalog : []).filter((item) => item?.id != null && item?.name).map((station) => {
    const key = normalize(station.name),coverageDemand=coverage.get(key);
    const lastSuccess = Date.parse(stationState[String(station.id)]?.lastSuccessAt || "");
    const unseen = !Number.isFinite(lastSuccess);
    const silenceHours = unseen ? 24 : Math.max(0, (nowMs - lastSuccess) / 3_600_000);
    const matching = (Array.isArray(updates) ? updates : []).filter((update) => [update.reportedStation, update.origin, update.destination].some((value) => normalize(value) === key));
    const uncertain = matching.reduce((sum, update) => sum + Math.max(0, 1 - (Number(update.confidence) || .5)) + Math.min(2, (Number(update.errorKm) || 0) / 100), 0);
    const score = (unseen ? 30 : 0) + Math.min(18, silenceHours) + (hubWeight.get(key) || 1) * 2 + matching.length * 5 + uncertain * 3 + Math.min(90,Number(coverageDemand?.priorityScore)||0)*.75 + Math.min(18,Number(coverageDemand?.requestWeight||1)*3) + Math.max(0,12-Number(coverageDemand?.targetIntervalMinutes||20)*.5);
    const reasons = [];
    if (unseen) reasons.push("never-observed");
    if(coverageDemand)reasons.push(...(Array.isArray(coverageDemand.reasons)?coverageDemand.reasons:["rail-intelligence-priority"]));
    if (matching.length) reasons.push(`${matching.length}-active-runs`);
    if ((hubWeight.get(key) || 0) >= 6) reasons.push("major-hub");
    reasons.push(`silence-${Math.round(silenceHours * 60)}m`);
    return { id: String(station.id), name: String(station.name), score: Number(score.toFixed(2)), reasons };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "uk"));
}

function scheduledAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function routeParts(value) {
  const parts = String(value || "").replace(/\u00a0/g, " ").split(/\s*(?:\u2192|\u2014|\u2013)\s*/u).map((item) => item.trim()).filter(Boolean);
  return { route: parts.join(" \u2192 "), origin: parts[0] || "", destination: parts.length > 1 ? parts.slice(1).join(" \u2192 ") : "" };
}

function boardUpdates(payload, observedAt) {
  const station = String(payload?.station?.name || payload?.station || "").trim();
  const convert = (items, boardType) => (Array.isArray(items) ? items : []).map((item) => {
    const at = scheduledAt(item?.time);
    const trainNumber = String(item?.train || "").match(/\d{1,4}(?:\/\d{1,4})?/)?.[0] || "";
    const route = routeParts(item?.route);
    const offsetMinutes = at ? (Date.parse(observedAt) - Date.parse(at)) / 60_000 : null;
    const isStationFact = Number.isFinite(offsetMinutes) && offsetMinutes >= -45 && offsetMinutes <= 90;
    const delayMinutes = Number(item?.delay_minutes);
    return {
      trainNumber, ...route,
      delayMinutes: Number.isFinite(delayMinutes) && delayMinutes > 0 ? delayMinutes : null,
      delayLabel: Number.isFinite(delayMinutes) && delayMinutes > 0 ? `+${Math.floor(delayMinutes / 60)}:${String(delayMinutes % 60).padStart(2, "0")}` : "",
      publicStatus: `Official board ${station}: ${boardType}`,
      operationalStatus: "station",
      forecastDeparture: boardType === "departure" ? at : null,
      forecastArrival: boardType === "arrival" ? at : null,
      updatedAt: observedAt,
      source: BOARD_URL,
      sourceEventUrl: BOARD_URL,
      sourceId: "uz-public-board-edge",
      sourceEvidence: "official-station-board",
      positionEvidence: isStationFact ? "station-board-window" : "schedule-only",
      reportedStation: isStationFact ? station : null,
      platform: item?.platform == null ? null : String(item.platform),
      boardType,
      scheduledStationAt: at,
      stationWindowOffsetMinutes: Number.isFinite(offsetMinutes) ? Number(offsetMinutes.toFixed(1)) : null,
    };
  }).filter((update) => update.trainNumber && update.route && update.scheduledStationAt);
  return [...convert(payload?.departures, "departure"), ...convert(payload?.arrivals, "arrival")];
}

async function writeState(env, state) {
  if (env.SNAPSHOT) await env.SNAPSHOT.put(STATE_KEY, JSON.stringify(state), { expirationTtl: 7 * 24 * 60 * 60 });
}

async function heartbeat(env, state, station, status) {
  if (!env.SNAPSHOT) return;
  await env.SNAPSHOT.put(HEARTBEAT_KEY, JSON.stringify({
    collectorId: "cloudflare-board-edge", status, checkedAt: state.checkedAt,
    version: "board-edge-v2", lastSucceededAt: state.lastSuccessAt || null,
    consecutiveFailures: state.consecutiveFailures || 0, runs: state.runs || 0,
    board: { selectedStation: station?.name || null, strategy: "information-gain-edge-v2", requestBudget: 1 },
  }), { expirationTtl: 900 });
}

export async function collectOfficialBoardEdge(env, { updates = [], now = new Date().toISOString(), fetchImpl = fetch } = {}) {
  const mode = String(env.BOARD_EDGE_MODE || "disabled");
  const [storedState,priorityState]=await Promise.all([readJson(env,STATE_KEY),readJson(env,"intelligence:board-priorities:v1")]);
  const previous = storedState || { stations: {}, runs: 0, consecutiveFailures: 0 };
  if (mode === "disabled") return { status: "disabled", updates: [], diagnostics: { mode } };
  if (mode === "canary" && previous.canaryCompleted) return { status: "skipped", updates: [], diagnostics: { mode, reason: "canary-completed", state: previous } };
  const nowMs = Date.parse(now) || Date.now();
  if (Date.parse(previous.cooldownUntil || "") > nowMs) return { status: "cooldown", updates: [], diagnostics: { mode, cooldownUntil: previous.cooldownUntil } };
  const sessionId = crypto.randomUUID();
  const headers = { Accept: "application/json", "x-client-locale": "uk", "x-session-id": sessionId, "x-user-agent": USER_AGENT };
  const state = { ...previous, checkedAt: now, runs: Number(previous.runs || 0) + 1, mode };
  let selected = null;
  try {
    const catalogResult = await requestJson(BASE, headers, fetchImpl);
    const ranked = rankStations(catalogResult.payload, previous, updates, nowMs, priorityState?.stations || []);
    selected = ranked[0];
    if (!selected) throw new Error("official board edge catalog is empty");
    const boardResult = await requestJson(`${BASE}/${encodeURIComponent(selected.id)}`, headers, fetchImpl);
    const fresh = boardUpdates(boardResult.payload, now);
    state.lastSuccessAt = now;
    state.consecutiveFailures = 0;
    state.cooldownUntil = null;
    state.canaryCompleted = mode === "canary" ? true : Boolean(previous.canaryCompleted);
    state.stations = { ...(previous.stations || {}), [selected.id]: { name: selected.name, lastSuccessAt: now, records: fresh.length } };
    state.lastResult = { status: 200, station: selected.name, records: fresh.length, score: selected.score, reasons: selected.reasons, catalog: catalogResult.diagnostics, board: boardResult.diagnostics };
    await writeState(env, state);
    await heartbeat(env, state, selected, "healthy");
    return { status: "online", updates: fresh, station: selected, diagnostics: { mode, scheduler: { strategy: "information-gain-edge-v2", requestBudget: 1, selectedStation: selected.name, selectedReason: selected.reasons, selectedScore: selected.score }, coverage: { catalogStations: ranked.length, records: fresh.length, observedStations: Object.keys(state.stations).length }, state } };
  } catch (error) {
    const status = Number(error?.status) || 0;
    state.consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
    state.canaryCompleted = mode === "canary" ? true : Boolean(previous.canaryCompleted);
    state.lastResult = { status, station: selected?.name || null, error: String(error?.message || error).slice(0, 300), diagnostics: error?.diagnostics || null };
    state.cooldownUntil = new Date(nowMs + ([429, 441].includes(status) ? 10 : 15) * 60_000).toISOString();
    await writeState(env, state);
    await heartbeat(env, state, selected, "degraded");
    return { status: "degraded", updates: [], station: selected, error: state.lastResult.error, diagnostics: { mode, state } };
  }
}
