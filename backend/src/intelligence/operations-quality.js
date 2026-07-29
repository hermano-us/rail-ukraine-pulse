const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const minutesBetween = (left, right) => {
  const value = Math.abs(Date.parse(left) - Date.parse(right)) / 60000;
  return Number.isFinite(value) ? value : null;
};
const hash = (value) => {
  let result = 2166136261;
  for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0).toString(36);
};

export function detectMovementChanges(previous, current, detectedAt = new Date().toISOString()) {
  if (!previous || !current?.movementId) return [];
  const changes = [];
  const add = (type, severity, previousValue, currentValue, title, message) => {
    const fingerprint = hash([current.movementId, type, current.lastObservedAt, currentValue].join("|"));
    changes.push({ changeId: "change:" + current.movementId + ":" + type + ":" + fingerprint, notificationId: "prediction:" + current.movementId + ":" + type + ":" + fingerprint, movementId: current.movementId, runId: current.runId, type, severity, previousValue, currentValue, title, message, detectedAt });
  };
  if (current.lastStation && previous.last_station && current.lastStation !== previous.last_station) {
    add("station_fact", "low", previous.last_station, current.lastStation, "Новый станционный факт · " + (current.trainNumber || current.runId), previous.last_station + " → " + current.lastStation);
  }
  if (current.route && previous.route && current.route !== previous.route) {
    add("route_changed", "high", previous.route, current.route, "Изменение маршрута · " + (current.trainNumber || current.runId), previous.route + " → " + current.route);
  }
  const etaDelta = current.eta && previous.eta ? minutesBetween(current.eta, previous.eta) : null;
  if (etaDelta != null && etaDelta >= 10) {
    add("eta_changed", etaDelta >= 30 ? "high" : "medium", previous.eta, current.eta, "Изменение ETA · " + (current.trainNumber || current.runId), "Прогноз изменился на " + Math.round(etaDelta) + " мин.");
  }
  const beforeConfidence = numberOrNull(previous.confidence), afterConfidence = numberOrNull(current.confidence);
  if (beforeConfidence != null && afterConfidence != null && beforeConfidence - afterConfidence >= .15) {
    add("confidence_drop", afterConfidence < .35 ? "high" : "medium", beforeConfidence, afterConfidence, "Снижение уверенности · " + (current.trainNumber || current.runId), Math.round(beforeConfidence * 100) + "% → " + Math.round(afterConfidence * 100) + "%");
  }
  const beforeMeta = previous.metadata || {}, afterUncertainty = numberOrNull(current.metadata?.uncertaintyKm), beforeUncertainty = numberOrNull(beforeMeta.uncertaintyKm);
  if (beforeUncertainty != null && afterUncertainty != null && afterUncertainty >= Math.max(beforeUncertainty * 1.25, beforeUncertainty + 15)) {
    add("uncertainty_expanded", afterUncertainty >= 100 ? "high" : "medium", beforeUncertainty, afterUncertainty, "Расширение коридора · " + (current.trainNumber || current.runId), Math.round(beforeUncertainty) + " → " + Math.round(afterUncertainty) + " км");
  }
  return changes;
}

export function evaluateQualityGate(evaluations = [], minimumSamples = 20) {
  const usable = evaluations.filter((item) => Number.isFinite(Number(item.absolute_error_minutes)));
  if (usable.length < minimumSamples) return { status: "insufficient-evidence", samples: usable.length, minimumSamples, maeMinutes: null, p80Coverage: null, maeRegressionPercent: null };
  const current = usable.slice(0, minimumSamples), baseline = usable.slice(minimumSamples, minimumSamples * 2);
  const summarize = (items) => ({ mae: items.reduce((sum, item) => sum + Number(item.absolute_error_minutes), 0) / items.length, coverage: items.reduce((sum, item) => sum + (Number(item.within_p80) ? 1 : 0), 0) / items.length * 100 });
  const now = summarize(current), before = baseline.length >= minimumSamples ? summarize(baseline) : null;
  const regression = before?.mae > 0 ? (now.mae - before.mae) / before.mae * 100 : null;
  const status = now.coverage < 65 && regression != null && regression >= 35 ? "degraded" : now.coverage < 72 || (regression != null && regression >= 20) ? "watch" : "healthy";
  return { status, samples: current.length, minimumSamples, maeMinutes: Number(now.mae.toFixed(1)), p80Coverage: Number(now.coverage.toFixed(1)), maeRegressionPercent: regression == null ? null : Number(regression.toFixed(1)) };
}
