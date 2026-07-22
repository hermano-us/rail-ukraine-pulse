import test from "node:test";
import assert from "node:assert/strict";
import { confidenceFor, expiryFor, haversineKm, parseBbox, publicStatus, resolveCurrentState } from "../backend/src/fuel/domain.js";

test("fuel facts expire and confidence decays with freshness", () => {
  const observedAt = "2026-07-22T08:00:00.000Z";
  assert.equal(expiryFor("availability", observedAt), "2026-07-22T11:00:00.000Z");
  const fresh = confidenceFor({ sourceType: "official", sourceReliability: 0.9, observedAt, expiresAt: "2026-07-22T14:00:00.000Z", moderated: true }, Date.parse("2026-07-22T09:00:00.000Z"));
  const old = confidenceFor({ sourceType: "official", sourceReliability: 0.9, observedAt, expiresAt: "2026-07-22T14:00:00.000Z", moderated: true }, Date.parse("2026-07-22T13:55:00.000Z"));
  assert.ok(fresh > old); assert.ok(fresh <= 1 && old >= 0);
});

test("conflicting strong evidence produces unknown, never false precision", () => {
  const base = { moderationStatus: "approved", sourceType: "official", sourceReliability: 0.95, observedAt: "2026-07-22T09:00:00.000Z", expiresAt: "2026-07-22T15:00:00.000Z" };
  const state = resolveCurrentState({ statuses: [{ ...base, status: "operating" }, { ...base, status: "temporarily_closed" }] }, Date.parse("2026-07-22T10:00:00.000Z"));
  assert.equal(state.publicStatus, "unknown"); assert.equal(state.conflictState, "conflicting"); assert.ok(state.statusConfidence <= 0.4);
});

test("sensitive damage reports are neutralized in public status", () => assert.equal(publicStatus("damaged_reported"), "unknown"));

test("Ukraine bbox validation and nearby distance are bounded", () => {
  assert.deepEqual(parseBbox("30,48,31,49"), [30,48,31,49]);
  assert.deepEqual(parseBbox("0,0,180,90"), [21.8,44,40.5,52.5]);
  assert.ok(haversineKm(50.45,30.52,49.84,24.03) > 450);
});
