import test from "node:test";
import assert from "node:assert/strict";
import { canonicalFuelBrand, catalogDuplicateDecision } from "../backend/src/fuel/dedupe.js";

const station = (overrides = {}) => ({ latitude: 50.45, longitude: 30.52, canonical_name: "АЗС", brand: null, address: null, ...overrides });

test("catalog dedupe unifies network aliases and generic overlays", () => {
  assert.equal(canonicalFuelBrand(station({ brand: "БРСМ-Нафта" })), "brsm");
  assert.equal(canonicalFuelBrand(station({ brand: "БРСМ" })), "brsm");
  assert.equal(canonicalFuelBrand(station({ brand: "Батнафта" })), "batnafta");
  assert.equal(canonicalFuelBrand(station({ brand: "Батнанефть" })), "batnafta");
  assert.equal(canonicalFuelBrand(station({ canonical_name: "Татнефть" })), "tatnafta");
  assert.equal(catalogDuplicateDecision(station({ brand: "БРСМ" }), station({ longitude: 30.52005, brand: "БРСМ-Нафта" })).duplicate, true);
  assert.equal(catalogDuplicateDecision(station({ brand: "Укрнафта" }), station({ longitude: 30.52005 })).duplicate, true);
});

test("catalog dedupe preserves nearby competing networks", () => {
  const decision = catalogDuplicateDecision(station({ brand: "WOG" }), station({ longitude: 30.52002, brand: "OKKO" }));
  assert.equal(decision.duplicate, false);
  assert.equal(decision.reason, "brand_conflict");
});

test("production application requires explicit opt-in", async () => {
  const script = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../scripts/deduplicate-fuel.mjs", import.meta.url), "utf8"));
  assert.match(script, /FUEL_DEDUPE_APPLY/);
  assert.match(script, /JSON\.stringify\(\{ apply, limit: 200 \}\)/);
  assert.doesNotMatch(script, /JSON\.stringify\(\{ apply: true/);
});

test("catalog dedupe keeps gas-only facilities separate from generic fuel points", () => {
  const decision = catalogDuplicateDecision(station({ canonical_name: "Газ", brand: null }), station({ longitude: 30.52002, canonical_name: "АЗС", brand: null }));
  assert.equal(decision.duplicate, false);
  assert.equal(decision.reason, "facility_type_uncertain");
});