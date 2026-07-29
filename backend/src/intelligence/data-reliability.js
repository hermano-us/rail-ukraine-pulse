const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

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
