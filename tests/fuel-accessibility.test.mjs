import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAccessibilityFeature } from "../scripts/import-lun-accessibility.mjs";
import { accessibilityMatchScore } from "../backend/src/fuel/api.js";

test("official accessibility importer keeps only fuel stations and summarizes evidence", () => {
  const feature = {
    id: 121962,
    geometry: { type: "Point", coordinates: [24.4296744, 49.0333538] },
    properties: {
      id: 121962, kind: "\u0410\u0417\u0421", title: "\u0410\u0417\u0421 \u0423\u043a\u0440\u043d\u0430\u0444\u0442\u0430",
      url: "https://lun.ua/misto/barrier-free/121962", rating: 0.39,
      ratingAuthority: "barrier", updateDate: "2025-10-28",
      categories: [{ id: "65", criteria: [
        { id: "1", value: "\u0442\u0430\u043a", photos: ["one.webp"] },
        { id: "2", value: "\u043d\u0456" },
      ] }],
    },
  };
  const record = normalizeAccessibilityFeature(feature);
  assert.equal(record.externalId, "121962");
  assert.equal(record.summary.yes, 1);
  assert.equal(record.summary.no, 1);
  assert.equal(record.photoCount, 1);
  assert.equal(normalizeAccessibilityFeature({ ...feature, properties: { ...feature.properties, kind: "shop" } }), null);
});

test("accessibility matching favors a close station with the same brand", () => {
  const result = accessibilityMatchScore(
    { lat: 49.03335, lng: 24.42967, title: "\u0410\u0417\u0421 \u0423\u043a\u0440\u043d\u0430\u0444\u0442\u0430" },
    { latitude: 49.03336, longitude: 24.42968, canonical_name: "\u0423\u043a\u0440\u043d\u0430\u0444\u0442\u0430" },
  );
  assert.ok(result.distanceKm < 0.01);
  assert.ok(result.score >= 0.9);
});
