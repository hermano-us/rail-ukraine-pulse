const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, Number(value) || 0));
const minutesBetween = (left, right) => (Date.parse(right) - Date.parse(left)) / 60_000;

const HOLD_STATUSES = new Set(["held","hold","stopped","suspended","station","at-station","dwelling","waiting","depot"]);
const HOLD_PATTERN = /(?:рух\s+(?:призупинено|зупинено)|(?:поїзд|поезд|рейс)?\s*(?:зупинен(?:о|ий)?|остановлен(?:о|ный)?|призупинен(?:о|ий)?|стоїть|стоит)|затриман(?:о|ий)?\s+на\s+станц|очікує\s+(?:дозволу|відправлення)|ожидает\s+(?:разрешения|отправления)|\b(?:held|stopped|suspended|awaiting clearance)\b)/iu;

export function deriveOperationalDisruption(update = {}, now = new Date().toISOString()) {
  const operationalStatus=String(update.operationalStatus||update.operational_status||"").trim().toLowerCase();
  const text=[update.publicStatus,update.status,update.reason,update.delayLabel,update.message].filter(Boolean).join(" ");
  const delay=Number(update.delayMinutes??update.delay_minutes),delayMinutes=Number.isFinite(delay)&&delay>0?Math.min(1440,delay):0;
  const explicitHold=HOLD_STATUSES.has(operationalStatus)||HOLD_PATTERN.test(text);
  const updatedAt=update.updatedAt||update.updated_at||update.observedAt||update.observed_at||null;
  const ageMinutes=updatedAt&&Number.isFinite(Date.parse(updatedAt))?Math.max(0,minutesBetween(updatedAt,now)):null;
  const reasons=[];
  if(explicitHold)reasons.push("explicit-operational-hold");
  if(delayMinutes>=60)reasons.push("material-delay");
  return {
    state:explicitHold?"held":delayMinutes>0?"delayed":"normal",
    held:explicitHold,
    delayMinutes,
    observedAt:updatedAt,
    ageMinutes:ageMinutes==null?null:Number(ageMinutes.toFixed(1)),
    confidence:explicitHold?Math.max(.45,Math.exp(-Math.max(0,ageMinutes||0)/240)):(delayMinutes>0?.7:1),
    reasons,
  };
}

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
  disruption = null,
} = {}) {
  const ageMinutes = Math.max(0, minutesBetween(anchorAt, now));
  const overdueMinutes = etaP80End && Number.isFinite(Date.parse(etaP80End)) ? minutesBetween(etaP80End, now) : 0;
  const reasons = [];
  let state = "unresolved";
  if (disruption?.held && positionStatus !== "unknown") {
    state = "held"; reasons.push(...(disruption.reasons||["explicit-operational-hold"]));
  } else if (positionStatus === "unknown" || !Number.isFinite(ageMinutes)) {
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

  const evidenceFactor = state === "at_station" || state === "dwelling" || state === "held" ? Number(disruption?.confidence||1) : state === "stale" ? 0.55 : state === "unknown" ? 0 : 0.85;
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
