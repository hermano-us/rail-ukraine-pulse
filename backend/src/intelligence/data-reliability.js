const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

const parsedAgeMinutes = (value, now) => {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? Math.max(0, (Date.parse(now) - timestamp) / 60_000) : null;
};

export function classifySourceState(source = {}, now = new Date().toISOString()) {
  const rawStatus = String(source.status?.status || source.status || "unknown").toLowerCase();
  const configured = source.configured !== false && rawStatus !== "requires_configuration";
  const cadence = Math.max(1, Number(source.expectedCadenceMinutes || source.expected_cadence_minutes) || 15);
  const ageMinutes = parsedAgeMinutes(source.sourceUpdatedAt || source.last_success_at || source.checkedAt || source.checked_at, now);
  const records = Math.max(0, Number(source.recordsCount ?? source.records_count) || 0);
  const transportFailure = /(?:http\s*(?:401|403|429|5\d\d)|timeout|fetch failed|transport unavailable|tls|525)/i.test(String(source.error || ""));
  let operationalState = "healthy";
  if (!configured) operationalState = "unconfigured";
  else if (["unavailable", "failed", "error"].includes(rawStatus) || (transportFailure && records === 0)) operationalState = "failing";
  else if (ageMinutes != null && ageMinutes > cadence * 4) operationalState = "stale";
  else if (records === 0 && ["online", "snapshot"].includes(rawStatus)) operationalState = "empty";
  else if (transportFailure) operationalState = "degraded";
  else if (!["online", "snapshot", "healthy"].includes(rawStatus)) operationalState = rawStatus === "stale" ? "stale" : "degraded";
  const usable = ["healthy", "empty"].includes(operationalState) || (operationalState === "degraded" && records > 0 && (ageMinutes == null || ageMinutes <= cadence * 4)) || (operationalState === "stale" && ageMinutes != null && ageMinutes <= cadence * 12);
  return { operationalState, rawStatus, configured, usable, records, ageMinutes:ageMinutes == null ? null : Number(ageMinutes.toFixed(1)), expectedCadenceMinutes:cadence, transportFailure };
}

export function selectSourceFailover(sources = [], capability, now = new Date().toISOString()) {
  const ranked = sources.map((source) => {
    const state = classifySourceState(source, now);
    const capabilities = source.capabilities || source.status?.capabilities || [];
    const supports = !capability || (Array.isArray(capabilities) ? capabilities.includes(capability) : Boolean(capabilities?.[capability]));
    const freshness = state.ageMinutes == null ? .25 : Math.exp(-state.ageMinutes / Math.max(5, state.expectedCadenceMinutes * 3));
    const reliability = clamp(source.reliability ?? source.priorityReliability ?? .6, 0, 1);
    const score = supports && state.usable ? reliability * .55 + freshness * .35 + Math.min(1, state.records / 50) * .1 : 0;
    return { source, state, score:Number(score.toFixed(4)) };
  }).sort((left, right) => right.score - left.score);
  return { selected:ranked[0]?.score > 0 ? ranked[0] : null, candidates:ranked };
}

export function priorityTier(priority = {}) {
  const score = Number(priority.priorityScore ?? priority.priority_score) || 0;
  if (Number(priority.overdueTwins ?? priority.overdue_twins) > 0 || Number(priority.silentRuns ?? priority.silent_runs) > 1 || score >= 70) return "critical";
  if (Number(priority.expectedRuns ?? priority.expected_runs) > 0 || Number(priority.ambiguousTwins ?? priority.ambiguous_twins) > 0 || score >= 35) return "corridor";
  return "background";
}

export function collectorCircuit({ consecutiveFailures = 0, lastSuccessAt = null, now = new Date().toISOString() } = {}) {
  const failures = Math.max(0, Number(consecutiveFailures) || 0);
  const successAge = lastSuccessAt && Number.isFinite(Date.parse(lastSuccessAt))
    ? Math.max(0, (Date.parse(now) - Date.parse(lastSuccessAt)) / 60_000) : Infinity;
  if (failures >= 5) return { state: "open", retryAfterMinutes: Math.min(60, 5 * 2 ** Math.min(3, failures - 5)) };
  if (failures >= 2 || successAge > 30) return { state: "half-open", retryAfterMinutes: 5 };
  return { state: "closed", retryAfterMinutes: 0 };
}

export function dynamicRequestBudget({ urgentStations = 0, activeCollectors = 1, degradedCollectors = 0, upstreamHealthy = true } = {}) {
  if (!upstreamHealthy) return 1;
  const fleet = Math.max(1, Number(activeCollectors) || 1);
  const pressure = Math.ceil(Math.max(0, Number(urgentStations) || 0) / fleet / 4);
  const penalty = Math.max(0, Number(degradedCollectors) || 0);
  return clamp(1 + pressure - penalty, 1, 6);
}

export function enrichPriorities(priorities = [], pollHealth = [], now = new Date().toISOString()) {
  const healthByStation = new Map();
  for (const item of pollHealth) {
    const current = healthByStation.get(item.station_id);
    if (!current || Date.parse(item.updated_at || 0) > Date.parse(current.updated_at || 0)) healthByStation.set(item.station_id, item);
  }
  return priorities.map((item) => {
    const health = healthByStation.get(item.stationId || item.station_id);
    const circuit = collectorCircuit({ consecutiveFailures: health?.consecutive_failures, lastSuccessAt: health?.last_success_at, now });
    const cooldownUntil = circuit.state === "open"
      ? new Date(Date.parse(now) + circuit.retryAfterMinutes * 60_000).toISOString() : health?.cooldown_until || null;
    return { ...item, priorityTier: priorityTier(item), collectorFailures: Number(health?.consecutive_failures) || 0, circuitState: circuit.state, nextEligibleAt: cooldownUntil };
  });
}
