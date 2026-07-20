import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlace } from "../js/data-store-ukraine.js";

test("nullable station fields from source adapters normalize safely", () => {
  assert.equal(normalizePlace(null), "");
  assert.equal(normalizePlace(undefined), "");
  assert.equal(normalizePlace(" Київ-Пас. "), "київ-пас");
});
