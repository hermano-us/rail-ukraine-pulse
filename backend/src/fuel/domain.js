export const FUEL_TYPES = new Set(["a92", "a95", "a95_premium", "a98", "a100", "diesel", "diesel_premium", "lpg", "adblue", "electric_charging", "other"]);
export const PUBLIC_STATUSES = new Set(["operating", "partially_operating", "temporarily_closed", "closed", "fuel_unavailable", "unknown"]);

const SOURCE_WEIGHT = { official: 1, partner: 0.88, operator: 0.92, moderator: 0.84, community: 0.58, catalog: 0.35 };
const TTL_MINUTES = { status: 360, availability: 180, price: 1440, queue: 60 };

export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));

export function expiryFor(kind, observedAt, explicitExpiresAt) {
  if (explicitExpiresAt && Number.isFinite(Date.parse(explicitExpiresAt))) return new Date(explicitExpiresAt).toISOString();
  const start = Date.parse(observedAt);
  if (!Number.isFinite(start)) return null;
  return new Date(start + (TTL_MINUTES[kind] || TTL_MINUTES.status) * 60_000).toISOString();
}

export function freshnessFactor(expiresAt, now = Date.now(), observedAt = null) {
  const end = Date.parse(expiresAt || "");
  if (!Number.isFinite(end) || end <= now) return 0;
  const start = Date.parse(observedAt || "");
  if (!Number.isFinite(start) || start >= end) return 1;
  return clamp((end - now) / (end - start));
}

export function confidenceFor({ sourceType, sourceReliability = 0.5, observedAt, expiresAt, independentConfirmations = 0, conflicts = 0, moderated = false, photo = false }, now = Date.now()) {
  const base = (SOURCE_WEIGHT[sourceType] ?? SOURCE_WEIGHT.community) * clamp(sourceReliability);
  const freshness = freshnessFactor(expiresAt, now, observedAt);
  const bonus = Math.min(0.18, Number(independentConfirmations) * 0.06) + (moderated ? 0.07 : 0) + (photo ? 0.04 : 0);
  return clamp((base + bonus - Math.min(0.4, Number(conflicts) * 0.15)) * (0.35 + freshness * 0.65));
}

export function publicStatus(status) {
  if (status === "damaged_reported") return "unknown";
  return PUBLIC_STATUSES.has(status) ? status : "unknown";
}

function usable(items, now) {
  return (items || []).filter((item) => item.moderationStatus === "approved" && freshnessFactor(item.expiresAt, now, item.observedAt) > 0);
}

function score(item, now) {
  return confidenceFor({ sourceType: item.sourceType, sourceReliability: item.sourceReliability, observedAt: item.observedAt, expiresAt: item.expiresAt, independentConfirmations: item.independentConfirmations, conflicts: item.conflicts, moderated: true, photo: item.photo }, now);
}

export function resolveCurrentState({ statuses = [], availability = [], prices = [] }, now = Date.now()) {
  const statusCandidates = usable(statuses, now).map((item) => ({ ...item, publicStatus: publicStatus(item.status), resolvedConfidence: score(item, now) })).sort((a, b) => b.resolvedConfidence - a.resolvedConfidence);
  const first = statusCandidates[0];
  const second = statusCandidates.find((item) => item.publicStatus !== first?.publicStatus);
  const conflicting = Boolean(first && second && first.resolvedConfidence >= 0.45 && second.resolvedConfidence >= first.resolvedConfidence - 0.12);
  const fuel = {};
  for (const item of usable(availability, now).sort((a, b) => score(b, now) - score(a, now))) {
    if (FUEL_TYPES.has(item.fuelType) && !fuel[item.fuelType]) fuel[item.fuelType] = { availability: item.availability, confidence: score(item, now), observedAt: item.observedAt, expiresAt: item.expiresAt };
  }
  const priceMap = {};
  for (const item of usable(prices, now).sort((a, b) => score(b, now) - score(a, now))) {
    if (FUEL_TYPES.has(item.fuelType) && !priceMap[item.fuelType]) priceMap[item.fuelType] = { priceMinor: item.priceMinor, currency: item.currency || "UAH", confidence: score(item, now), observedAt: item.observedAt, expiresAt: item.expiresAt };
  }
  return {
    publicStatus: conflicting ? "unknown" : first?.publicStatus || "unknown",
    statusConfidence: conflicting ? Math.min(first?.resolvedConfidence || 0, 0.4) : first?.resolvedConfidence || 0,
    statusVerifiedAt: conflicting ? null : first?.observedAt || null,
    statusExpiresAt: conflicting ? null : first?.expiresAt || null,
    conflictState: conflicting ? "conflicting" : "none",
    fuel, prices: priceMap,
    resolvedAt: new Date(now).toISOString(), resolverVersion: "fuel-resolver-v1",
    evidenceSummary: { activeStatusEvidence: statusCandidates.length, conflicting: conflicting ? 2 : 0 },
  };
}

export function parseBbox(value, fallback = [21.8, 44, 40.5, 52.5]) {
  const values = String(value || "").split(",").map(Number);
  if (values.length !== 4 || values.some((item) => !Number.isFinite(item))) return fallback;
  const [minLng, minLat, maxLng, maxLat] = values;
  if (minLng >= maxLng || minLat >= maxLat || minLng < 20 || maxLng > 42 || minLat < 43 || maxLat > 54) return fallback;
  return values;
}

export function haversineKm(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180; const dLat = (bLat - aLat) * rad; const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
