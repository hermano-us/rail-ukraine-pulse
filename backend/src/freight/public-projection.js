import {
  FREIGHT_PUBLIC_POLICY,
  freightCorridor,
  freightSourceGroup,
  roundedFreightTime,
} from "../../../shared/freight-public-policy.js";

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const parseJson = (value) => { try { return JSON.parse(value || "{}") || {}; } catch { return {}; } };
const evidenceAvailableAt = (item) => {
  const timestamps = [item.occurred_at, item.received_at, item.updated_at]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : NaN;
};

function anonymousId(value) {
  let hash = 2166136261;
  for (const character of String(value)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function uniqueEvidence(rows) {
  const result = new Map();
  for (const item of rows) {
    const fingerprint = String(item.content_fingerprint || item.evidence_id || "");
    const previous = result.get(fingerprint);
    const operatorConfirmed = item.review_status === "corroborated";
    const previousConfirmed = previous?.review_status === "corroborated";
    if (!previous || (operatorConfirmed && !previousConfirmed) || (operatorConfirmed === previousConfirmed && Date.parse(item.occurred_at) > Date.parse(previous.occurred_at))) result.set(fingerprint, item);
  }
  return [...result.values()];
}

function temporalClusters(rows, windowHours) {
  const windowMs = Math.max(1, Number(windowHours) || 6) * 3_600_000;
  const ordered = [...rows].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const clusters = [];
  for (const item of ordered) {
    const current = clusters.at(-1);
    if (!current || Date.parse(item.occurred_at) - Date.parse(current[0].occurred_at) > windowMs) clusters.push([item]);
    else current.push(item);
  }
  return clusters;
}

function publicObject(group, evidence, now) {
  const corridor = freightCorridor(group.corridorCode);
  const ordered = [...evidence].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const latest = ordered.at(-1);
  const sourceGroups = new Set(ordered.map((item) => freightSourceGroup(item.source_id)));
  const combined = 1 - ordered.reduce((remaining, item) => remaining * (1 - clamp(item.confidence) * 0.62), 1);
  const confidence = clamp(combined + (sourceGroups.size >= 2 ? 0.08 : 0), 0.2, 0.88);
  const uncertaintyKm = Math.max(FREIGHT_PUBLIC_POLICY.minimumUncertaintyKm, Math.round(25 + (1 - confidence) * 110));
  const identitySeed = `${group.corridorCode}:${roundedFreightTime(ordered[0].occurred_at, 60)}`;
  const id = `freight-${anonymousId(identitySeed)}`;
  const freightTypes = [...new Set(ordered.map((item) => parseJson(item.classification_json).freightType || "unclassified_rail"))];
  const corroboration = ordered.some((item) => item.review_status === "corroborated") ? "operator-reviewed" : "independent-sources";
  return {
    id,
    kind: "corridor-activity",
    corridorCode: group.corridorCode,
    corridorKind: corridor.kind,
    label: corridor.label,
    origin: corridor.origin,
    destination: corridor.destination,
    routeCoordinates: corridor.coordinates.map((point) => [...point]),
    freightTypes,
    observationCount: ordered.length,
    independentSources: sourceGroups.size,
    corroboration,
    confidence: Number(confidence.toFixed(3)),
    uncertaintyKm,
    firstObservedAt: roundedFreightTime(ordered[0].occurred_at),
    lastObservedAt: roundedFreightTime(latest.occurred_at),
    publishedAt: roundedFreightTime(now),
    position: null,
    method: "delayed-corroborated-corridor-v2",
  };
}

export function buildPublicFreightProjection(input = [], nowValue = new Date().toISOString(), policy = FREIGHT_PUBLIC_POLICY) {
  const now = new Date(nowValue).toISOString();
  const nowMs = Date.parse(now);
  const cutoffMs = nowMs - Math.max(FREIGHT_PUBLIC_POLICY.minimumDelayMinutes, Number(policy.minimumDelayMinutes) || 0) * 60_000;
  const oldestMs = nowMs - Math.min(7 * 24, Math.max(24, Number(policy.maximumAgeHours) || FREIGHT_PUBLIC_POLICY.maximumAgeHours)) * 3_600_000;
  const eligible = uniqueEvidence(input.filter((item) => {
    const occurredMs = Date.parse(item.occurred_at);
    const availableMs = evidenceAvailableAt(item);
    return item.domain === "rail_freight"
      && freightCorridor(item.corridor_code)
      && item.sensitivity_level !== "highly_restricted"
      && !["rejected", "expired", "needs_context"].includes(item.review_status)
      && Number.isFinite(occurredMs) && occurredMs >= oldestMs && Number.isFinite(availableMs) && availableMs <= cutoffMs;
  }));
  const corridorGroups = new Map();
  for (const item of eligible) {
    const corridorCode = String(item.corridor_code);
    const group = corridorGroups.get(corridorCode) || { corridorCode, evidence: [] };
    group.evidence.push(item); corridorGroups.set(corridorCode, group);
  }
  const objects = []; const corridors = [];
  for (const group of corridorGroups.values()) {
    const published = [];
    for (const evidence of temporalClusters(group.evidence, policy.corroborationWindowHours)) {
      const independent = new Set(evidence.map((item) => freightSourceGroup(item.source_id))).size;
      const operatorConfirmed = evidence.some((item) => item.review_status === "corroborated");
      if (independent < Math.max(2, Number(policy.minimumIndependentSources) || 2) && !operatorConfirmed) continue;
      const object = publicObject(group, evidence, now);
      objects.push(object); published.push(object);
    }
    if (!published.length) continue;
    const definition = freightCorridor(group.corridorCode);
    corridors.push({
      code: group.corridorCode,
      kind: definition.kind,
      label: definition.label,
      coordinates: definition.coordinates.map((point) => [...point]),
      observationCount: published.reduce((sum, object) => sum + object.observationCount, 0),
      independentSources: Math.max(...published.map((object) => object.independentSources)),
      objectCount: published.length,
      lastObservedAt: published.reduce((latest, object) => Date.parse(object.lastObservedAt) > Date.parse(latest) ? object.lastObservedAt : latest, published[0].lastObservedAt),
    });
  }
  objects.sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt));
  corridors.sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt));
  const latestPublishedAt = objects[0]?.lastObservedAt || null;
  const latestAgeHours = latestPublishedAt ? (nowMs - Date.parse(latestPublishedAt)) / 3_600_000 : Infinity;
  const status = objects.length ? (latestAgeHours <= 48 ? "online" : "stale") : eligible.length ? "degraded" : "waiting";
  return {
    schemaVersion: 2,
    dataMode: "delayed-probabilistic-freight",
    generatedAt: roundedFreightTime(now),
    eligibleCutoff: roundedFreightTime(new Date(cutoffMs).toISOString()),
    sourceStatus: {
      status,
      label: objects.length
        ? `Грузовой слой: ${objects.length} агрегатов коридоров · задержка ≥24 ч`
        : "Грузовой слой: ожидаются независимые подтверждения открытых наблюдений",
    },
    policy: { ...FREIGHT_PUBLIC_POLICY, visibility: "public-aggregate", individualPublicPositions: false },
    diagnostics: { eligibleEvidence: eligible.length, publishedObjects: objects.length, publishedCorridors: corridors.length },
    objects,
    corridors,
  };
}
