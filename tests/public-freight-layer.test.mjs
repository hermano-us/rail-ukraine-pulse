import test from "node:test";
import assert from "node:assert/strict";
import { buildPublicFreightProjection } from "../backend/src/freight/public-projection.js";
import { FREIGHT_PUBLIC_POLICY } from "../shared/freight-public-policy.js";
import { materializePublicFreight } from "../js/freight-public-layer.js";

const NOW = "2026-08-08T12:00:00.000Z";

function evidence(overrides = {}) {
  return {
    evidence_id: "restricted-evidence-1",
    domain: "rail_freight",
    source_id: "freight-tg-irpin",
    occurred_at: "2026-08-07T11:30:00.000Z",
    received_at: "2026-08-07T11:31:00.000Z",
    updated_at: "2026-08-07T11:31:00.000Z",
    content_fingerprint: "fingerprint-1",
    classification_json: JSON.stringify({
      freightType: "bulk",
      locomotive: "ВЛ80Т-1445",
      trainNumber: "2417",
      direction: "київ",
      station: "Коростень",
      entityKey: "locomotive:ВЛ80Т-1445",
      entityConfidence: 0.92,
    }),
    corridor_code: "kyiv-korosten",
    confidence: 0.58,
    sensitivity_level: "restricted",
    review_status: "pending",
    ...overrides,
  };
}

function independentlyCorroborated(overrides = {}) {
  const first = evidence(overrides);
  return [
    first,
    evidence({
      ...overrides,
      evidence_id: "restricted-evidence-2",
      source_id: "freight-tg-korosten",
      content_fingerprint: "fingerprint-2",
      occurred_at: "2026-08-07T11:45:00.000Z",
    }),
  ];
}

function collectKeys(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  for (const [key, nested] of Object.entries(value)) {
    result.add(key);
    collectKeys(nested, result);
  }
  return result;
}

test("public freight projection enforces the 24-hour publication delay per evidence item", () => {
  const projection = buildPublicFreightProjection([
    ...independentlyCorroborated(),
    evidence({
      evidence_id: "too-fresh-1",
      source_id: "freight-tg-irpin",
      content_fingerprint: "too-fresh-1",
      occurred_at: "2026-08-07T12:15:00.000Z",
    }),
    evidence({
      evidence_id: "too-fresh-2",
      source_id: "freight-tg-korosten",
      content_fingerprint: "too-fresh-2",
      occurred_at: "2026-08-07T12:30:00.000Z",
    }),
  ], NOW);

  assert.equal(FREIGHT_PUBLIC_POLICY.minimumDelayMinutes, 24 * 60);
  assert.equal(projection.eligibleCutoff, "2026-08-07T12:00:00.000Z");
  assert.equal(projection.diagnostics.eligibleEvidence, 2);
  assert.equal(projection.objects.length, 1);
  assert.equal(projection.objects[0].observationCount, 2);
  assert.ok(Date.parse(projection.objects[0].lastObservedAt) <= Date.parse(projection.eligibleCutoff));
});

test("one source cannot publish a corridor and aliases from one source network do not inflate corroboration", () => {
  const oneSource = buildPublicFreightProjection([evidence()], NOW);
  assert.equal(oneSource.objects.length, 0);
  assert.equal(oneSource.corridors.length, 0);

  const aliasedNetwork = buildPublicFreightProjection([
    evidence({ source_id: "freight-tg-mr-boyanchik", content_fingerprint: "same-post" }),
    evidence({ evidence_id: "alias-copy", source_id: "freight-tg-mishan4ik", content_fingerprint: "same-post" }),
  ], NOW);
  assert.equal(aliasedNetwork.diagnostics.eligibleEvidence, 1);
  assert.equal(aliasedNetwork.objects.length, 0);

  const independent = buildPublicFreightProjection([
    evidence({ source_id: "freight-tg-mr-boyanchik", content_fingerprint: "same-post" }),
    evidence({ evidence_id: "independent", source_id: "freight-tg-korosten", content_fingerprint: "same-post" }),
  ], NOW);
  assert.equal(independent.objects.length, 0);

  const independentFacts = buildPublicFreightProjection([
    evidence({ source_id: "freight-tg-mr-boyanchik", content_fingerprint: "fact-a" }),
    evidence({ evidence_id: "independent", source_id: "freight-tg-korosten", content_fingerprint: "fact-b" }),
  ], NOW);
  assert.equal(independentFacts.objects.length, 1);
  assert.equal(independentFacts.objects[0].independentSources, 2);
});

test("review and sensitivity guards fail closed while operator corroboration can publish an aggregate", () => {
  const projection = buildPublicFreightProjection([
    evidence({ evidence_id: "unknown-corridor", corridor_code: "unresolved", review_status: "corroborated" }),
    evidence({ evidence_id: "sensitive", sensitivity_level: "highly_restricted", review_status: "corroborated" }),
    evidence({ evidence_id: "rejected", review_status: "rejected" }),
    evidence({ evidence_id: "needs-context", review_status: "needs_context" }),
    evidence({ evidence_id: "expired", review_status: "expired" }),
    evidence({ evidence_id: "operator-corroborated", review_status: "corroborated" }),
  ], NOW);

  assert.equal(projection.diagnostics.eligibleEvidence, 1);
  assert.equal(projection.objects.length, 1);
  assert.equal(projection.objects[0].kind, "corridor-activity");
  assert.equal(projection.objects[0].corroboration, "operator-reviewed");
});

test("an old post first received or changed now cannot bypass the 24-hour delay", () => {
  const lateArrival = independentlyCorroborated({
    occurred_at: "2026-08-05T09:00:00.000Z",
    received_at: "2026-08-08T11:50:00.000Z",
    updated_at: "2026-08-08T11:50:00.000Z",
  });
  const projection = buildPublicFreightProjection(lateArrival, NOW);
  assert.equal(projection.diagnostics.eligibleEvidence, 0);
  assert.deepEqual(projection.objects, []);
});

test("independent observations outside the corroboration window remain separate and unpublished", () => {
  const projection = buildPublicFreightProjection([
    evidence({ occurred_at: "2026-08-06T02:00:00.000Z", received_at: "2026-08-06T02:01:00.000Z", updated_at: "2026-08-06T02:01:00.000Z" }),
    evidence({
      evidence_id: "late-independent", source_id: "freight-tg-korosten", content_fingerprint: "late-fingerprint",
      occurred_at: "2026-08-06T09:00:01.000Z", received_at: "2026-08-06T09:01:00.000Z", updated_at: "2026-08-06T09:01:00.000Z",
    }),
  ], NOW);
  assert.equal(projection.diagnostics.eligibleEvidence, 2);
  assert.deepEqual(projection.objects, []);
});

test("public freight output is anonymous, corridor-only and deterministic", () => {
  const rows = independentlyCorroborated();
  const first = buildPublicFreightProjection(rows, NOW);
  const second = buildPublicFreightProjection(rows, NOW);
  assert.deepEqual(first, second);

  const object = first.objects[0];
  assert.equal(object.position, null);
  assert.ok(object.uncertaintyKm >= FREIGHT_PUBLIC_POLICY.minimumUncertaintyKm);
  assert.equal(first.policy.exactPositions, false);
  assert.equal(first.policy.exposeIdentifiers, false);
  assert.equal(first.policy.exposeRawEvidence, false);
  assert.match(object.id, /^freight-[a-z0-9]+$/);

  const forbiddenKeys = [
    "evidence_id", "evidenceId", "source_id", "sourceId", "source_url", "sourceUrl",
    "evidence_excerpt", "evidenceExcerpt", "classification_json", "entityKey",
    "locomotive", "trainNumber", "station", "latitude", "longitude",
  ];
  const keys = collectKeys(first);
  for (const key of forbiddenKeys) assert.equal(keys.has(key), false, `forbidden public key: ${key}`);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /restricted-evidence|t\.me|ВЛ80Т-1445|2417/);

  for (const value of [object.firstObservedAt, object.lastObservedAt, object.publishedAt]) {
    assert.equal(new Date(value).getUTCMinutes() % 15, 0);
    assert.equal(new Date(value).getUTCSeconds(), 0);
  }
});

test("frontend materializes freight as a dedicated non-positioned corridor object", () => {
  const snapshot = buildPublicFreightProjection(independentlyCorroborated(), NOW);
  const result = materializePublicFreight(snapshot, () => ["Київська"], new Date(NOW));
  assert.equal(result.objects.length, 1);
  assert.equal(result.features.length, 1);
  const object = result.objects[0];
  assert.equal(object.type, "freight");
  assert.equal(object.position.coordinates, null);
  assert.equal(object.positionAdmission.allowed, false);
  assert.equal(object.freight.exactPosition, false);
  assert.ok(object.position.errorKm >= FREIGHT_PUBLIC_POLICY.minimumUncertaintyKm);
  assert.match(object.description, /не точна позиція|не точная позиция/i);
  assert.equal(result.features[0].geometry.type, "LineString");
});
