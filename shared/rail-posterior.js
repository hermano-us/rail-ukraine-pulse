const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function gaussian(x, mean, sigma) {
  const z = (x - mean) / Math.max(0.01, sigma);
  return Math.exp(-0.5 * z * z);
}

function quantile(bins, probability) {
  let cumulative = 0;
  for (const bin of bins) {
    cumulative += bin.probability;
    if (cumulative >= probability) return bin.distanceKm;
  }
  return bins.at(-1)?.distanceKm ?? null;
}

function latestPastAnchor(anchors, nowMs) {
  return [...anchors]
    .filter((anchor) => Number.isFinite(anchor.routeDistanceKm) && Date.parse(anchor.occurredAt) <= nowMs)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0] || null;
}

function nextScheduleEvent(schedule, nowMs, fromKm) {
  return [...schedule]
    .filter((event) => Number.isFinite(event.routeDistanceKm) && Date.parse(event.expectedAt) > nowMs && event.routeDistanceKm >= fromKm)
    .sort((a, b) => Date.parse(a.expectedAt) - Date.parse(b.expectedAt))[0] || null;
}

/**
 * Produces a calibrated-looking probability corridor without claiming GPS.
 * The distribution is deliberately conservative until enough confirmed
 * station passages exist for per-segment calibration.
 */
export function estimatePosterior(input) {
  const now = new Date(input.now || Date.now());
  const nowMs = now.getTime();
  const routeLengthKm = Number(input.routeLengthKm);
  if (!Number.isFinite(nowMs) || !(routeLengthKm > 0)) return { status: "unknown", method: "posterior-route-unavailable" };

  const anchors = Array.isArray(input.anchors) ? input.anchors : [];
  const schedule = Array.isArray(input.schedule) ? input.schedule : [];
  const anchor = latestPastAnchor(anchors, nowMs);
  if (!anchor) return { status: "unknown", method: "posterior-anchor-unavailable" };

  const ageMinutes = Math.max(0, (nowMs - Date.parse(anchor.occurredAt)) / 60_000);
  if (ageMinutes > 180) {
    return {
      status: "unknown", method: "posterior-anchor-expired", lastConfirmedAt: anchor.occurredAt,
      sourceAgeMinutes: Number(ageMinutes.toFixed(1)),
    };
  }

  const fromKm = clamp(Number(anchor.routeDistanceKm), 0, routeLengthKm);
  const next = nextScheduleEvent(schedule, nowMs, fromKm);
  const defaultSpeed = clamp(Number(input.nominalSpeedKph) || 62, 20, 130);
  let meanKm;
  let sigmaKm;

  if (next) {
    const totalMs = Math.max(60_000, Date.parse(next.expectedAt) - Date.parse(anchor.occurredAt));
    const progress = clamp((nowMs - Date.parse(anchor.occurredAt)) / totalMs, 0, 1);
    const toKm = clamp(Number(next.routeDistanceKm), fromKm, routeLengthKm);
    meanKm = fromKm + (toKm - fromKm) * progress;
    const segmentKm = Math.max(1, toKm - fromKm);
    const scheduleSpread = Number(next.p90Minutes) > Number(next.p10Minutes)
      ? (Number(next.p90Minutes) - Number(next.p10Minutes)) * defaultSpeed / 120
      : segmentKm * 0.12;
    const historicalSpread = Math.max(0, Number(input.historicalSpreadMinutes) || 0) * defaultSpeed / 120;
    sigmaKm = Math.max(Number(anchor.errorKm) || 1.5, scheduleSpread, historicalSpread, 1.2 + ageMinutes * 0.055);
  } else {
    meanKm = clamp(fromKm + defaultSpeed * ageMinutes / 60, fromKm, routeLengthKm);
    sigmaKm = Math.max(Number(anchor.errorKm) || 2, 2 + ageMinutes * 0.16);
  }

  const binCount = clamp(Math.ceil(routeLengthKm / 2), 40, 240);
  const stepKm = routeLengthKm / binCount;
  const raw = [];
  let totalWeight = 0;
  for (let index = 0; index <= binCount; index += 1) {
    const distanceKm = index * stepKm;
    const weight = gaussian(distanceKm, meanKm, sigmaKm);
    raw.push({ distanceKm, weight });
    totalWeight += weight;
  }
  const bins = raw.map((bin) => ({
    distanceKm: Number(bin.distanceKm.toFixed(2)),
    probability: bin.weight / Math.max(totalWeight, Number.EPSILON),
  }));
  const p05 = quantile(bins, 0.05);
  const p25 = quantile(bins, 0.25);
  const p50 = quantile(bins, 0.5);
  const p75 = quantile(bins, 0.75);
  const p95 = quantile(bins, 0.95);
  const errorKm = Math.max(p50 - p05, p95 - p50);
  const reliability = clamp(Number(anchor.reliability) || 0.6, 0, 1);
  const freshness = clamp(1 - ageMinutes / 180, 0, 1);
  const concentration = clamp(1 - (p95 - p05) / Math.max(routeLengthKm, 1), 0, 1);
  const confidence = clamp(reliability * 0.48 + freshness * 0.3 + concentration * 0.22, 0.05, 0.96);
  const frozen = ageMinutes > 90;

  return {
    status: frozen ? "stale" : ageMinutes <= 3 && errorKm <= 5 ? "reported" : "estimated",
    method: "rail-posterior-v2",
    distanceKm: Number(p50.toFixed(2)),
    confidence: Number((frozen ? Math.min(confidence, 0.32) : confidence).toFixed(2)),
    errorKm: Number(errorKm.toFixed(1)),
    lastConfirmedAt: anchor.occurredAt,
    calculatedAt: now.toISOString(),
    sourceAgeMinutes: Number(ageMinutes.toFixed(1)),
    corridor: {
      p50: [Number(p25.toFixed(2)), Number(p75.toFixed(2))],
      p90: [Number(p05.toFixed(2)), Number(p95.toFixed(2))],
    },
    distribution: bins.filter((_, index) => index % Math.max(1, Math.floor(bins.length / 40)) === 0),
    calibration: { historicalSamples: Number(input.historicalSamples) || 0, historicalSpreadMinutes: Number(input.historicalSpreadMinutes) || 0 },
  };
}

