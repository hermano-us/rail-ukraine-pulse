const MAX_DELAY_MINUTES = 24 * 60;
const MAX_FUTURE_MINUTES = 20;

export function assessUpdate(update, now = Date.now()) {
  const errors = [];
  const warnings = [];
  const trainNumber = String(update?.trainNumber || "").trim();
  if (!/^\d{1,4}(?:\/\d{1,4})?$/.test(trainNumber)) errors.push("invalid_train_number");
  const timestamp = Date.parse(update?.updatedAt || "");
  if (!Number.isFinite(timestamp)) errors.push("invalid_timestamp");
  else if (timestamp - now > MAX_FUTURE_MINUTES * 60_000) errors.push("future_timestamp");
  const delay = update?.delayMinutes;
  if (delay != null && (!Number.isFinite(Number(delay)) || Number(delay) < 0 || Number(delay) > MAX_DELAY_MINUTES)) errors.push("impossible_delay");
  if (!String(update?.route || "").trim()) warnings.push("missing_route");
  if (!update?.forecastArrival && !update?.forecastDeparture) warnings.push("missing_forecast");
  if (Number.isFinite(timestamp) && now - timestamp > 6 * 60 * 60_000) warnings.push("old_event");
  return { accepted: errors.length === 0, errors, warnings };
}

export function screenUpdates(updates, now = Date.now()) {
  const accepted = [];
  const quarantined = [];
  const warningCounts = {};
  for (const update of Array.isArray(updates) ? updates : []) {
    const assessment = assessUpdate(update, now);
    for (const warning of assessment.warnings) warningCounts[warning] = (warningCounts[warning] || 0) + 1;
    if (!assessment.accepted) quarantined.push({ trainNumber: update?.trainNumber || null, sourceId: update?.sourceId || null, errors: assessment.errors });
    else accepted.push(assessment.warnings.length ? { ...update, qualityFlags: assessment.warnings } : update);
  }
  return { accepted, quarantined, warningCounts, checkedAt: new Date(now).toISOString() };
}
