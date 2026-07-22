import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyFuelIncidentText } from "../backend/src/fuel/incidents.js";

test("fuel incident classifier requires a station context", () => {
  assert.equal(classifyFuelIncidentText("Після атаки пошкоджено АЗС у Харкові").type, "possible_damage");
  assert.equal(classifyFuelIncidentText("АЗС відновила роботу після ремонту").type, "possible_reopening");
  assert.equal(classifyFuelIncidentText("Після атаки пошкоджено склад").type, "unknown");
});

test("fuel incident integration is moderation-first", async () => {
  const source = await readFile(new URL("../backend/src/fuel/incidents.js", import.meta.url), "utf8");
  assert.match(source, /publicChanges: 0/);
  assert.match(source, /moderationRequired: true/);
  assert.match(source, /damaged_reported/);
});

test("fuel incident collector has a Ukrainian RSS fallback", async () => {
  const source = await readFile(new URL("../scripts/collect-fuel-incidents.mjs", import.meta.url), "utf8");
  assert.match(source, /news\.google\.com\/rss\/search/);
  assert.match(source, /google-news-rss/);
  assert.match(source, /fetchWithRetry/);
});