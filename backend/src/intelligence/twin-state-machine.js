const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const minutesBetween = (left, right) => (Date.parse(right) - Date.parse(left)) / 60_000;

export function summarizeStationEvidence(events = [], canonicalStation = (value) => String(value || "")) {
  const ordered = [...events]
    .filter((event) => event?.station && Number.isFinite(Date.parse(event.occurred_at)))
    .sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
  const latest = ordered.at(-1);
  if (!latest) return { repeatCount: 0, dwellMinutes: 0, previousNodeId: null };
  const latestNode = canonicalStation(latest.station);
  const consecutive = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (canonicalStation(ordered[index].station) !== latestNode) break;
    consecutive.unshift(ordered[index]);
  }
  const previous = ordered.slice(0, Math.max(0, ordered.length - consecutive.length)).at(-1);
  const dwellMinutes = consecutive.length > 1 ? Math.max(0, minutesBetween(consecutive[0].occurred_at, latest.occurred_at)) : 0;
  return {
    repeatCount: consecutive.length,
    dwellMinutes: Number(dwellMinutes.toFixed(1)),
    previousNodeId: previous ? canonicalStation(previous.station) : null,
  };
}

export function deriveTwinOperationalState({
  now = new Date().toISOString(),
  anchorAt,
  positionStatus = "unknown",
  progress = 0,
  etaP80End = null,
  confidence = 0,
  repeatCount = 1,
  dwellMinutes = 0,
} = {}) {
  const ageMinutes = Math.max(0, minutesBetween(anchorAt, now));
  const overdueMinutes = etaP80End && Number.isFinite(Date.parse(etaP80End)) ? minutesBetween(etaP80End, now) : 0;
  const reasons = [];
  let state = "unresolved";

  if (positionStatus === "unknown" || !Number.isFinite(ageMinutes)) {
    state = "unknown"; reasons.push("no-current-anchor");
  } else if (positionStatus === "stale") {
    state = "stale"; reasons.push("anchor-stale");
  } else if (repeatCount >= 2 && dwellMinutes >= 2 && ageMinutes <= 20) {
    state = "dwelling"; reasons.push("repeated-station-facts");
  } else if (ageMinutes <= 5) {
    state = "at_station"; reasons.push("fresh-station-fact");
  } else if (overdueMinutes > 0) {
    state = "overdue"; reasons.push("next-fact-after-p80");
  } else if (progress < 0.18) {
    state = "departing"; reasons.push("early-segment-progress");
  } else if (progress >= 0.78) {
    state = "approaching"; reasons.push("late-segment-progress");
  } else {
    state = "in_transit"; reasons.push("mid-segment-progress");
  }

  const evidenceFactor = state === "at_station" || state === "dwelling" ? 1 : state === "stale" ? 0.55 : state === "unknown" ? 0 : 0.85;
  const stateConfidence = clamp(confidence * evidenceFactor);
  return {
    state,
    stateConfidence: Number(stateConfidence.toFixed(4)),
    ageMinutes: Number(ageMinutes.toFixed(1)),
    dwellMinutes: Number(Math.max(0, dwellMinutes).toFixed(1)),
    overdueMinutes: Number(Math.max(0, overdueMinutes).toFixed(1)),
    reasons,
  };
}

export function stateTransition(previous = null, current = {}) {
  const changed = !previous
    || previous.operational_state !== current.state
    || previous.anchor_node_id !== current.anchorNodeId
    || previous.next_node_id !== current.nextNodeId;
  if (!changed) return null;
  return {
    fromState: previous?.operational_state || null,
    toState: current.state,
    stateSince: current.now,
    reason: {
      reasons: current.reasons || [],
      ageMinutes: current.ageMinutes,
      dwellMinutes: current.dwellMinutes,
      overdueMinutes: current.overdueMinutes,
      positionStatus: current.positionStatus,
    },
  };
}
