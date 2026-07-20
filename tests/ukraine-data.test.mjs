import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDelayTable } from "../scripts/update-ukraine-data.mjs";
import { buildRunIdentity, calculateQuality } from "../js/data-store-ukraine.js";

const readJson = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));

test("Ukraine boundary dataset contains all requested regions", async () => {
  const regions = await readJson("regions.geojson");
  assert.equal(new Set(regions.features.map((feature) => feature.properties.id)).size, 22);
});

test("delay table adapter normalizes public updates and forecasts", () => {
  const html = `<table><tr><td>№ 91/92</td><td>Київ — Львів</td><td>+ 01:12</td><td>В дорозі</td><td>—</td><td>18:42</td><td>Висока</td><td>Операційна причина</td></tr></table>`;
  assert.deepEqual(parseDelayTable(html).map(({ updatedAt, source, ...item }) => item), [{
    trainNumber:"91/92", route:"Київ — Львів", origin:"Київ", destination:"Львів",
    delayMinutes:72, delayLabel:"+ 01:12", publicStatus:"В дорозі", operationalStatus:"moving",
    forecastDeparture:null, forecastArrival:"18:42", reliability:"Висока", reason:"Операційна причина",
    sourceId:"uz-delay-dashboard", sourceEvidence:"official-public-dashboard", positionEvidence:"none",
  }]);
});

test("run identity separates date and direction", () => {
  const forward = buildRunIdentity({ trainNumber: "79/80", origin: "Львів", destination: "Дніпро-Головний" }, new Date("2026-07-17T12:00:00Z"));
  const reverse = buildRunIdentity({ trainNumber: "79/80", origin: "Дніпро-Головний", destination: "Львів" }, new Date("2026-07-17T12:00:00Z"));
  assert.notEqual(forward.runId, reverse.runId);
  assert.match(forward.runId, /^uz:2026-07-17:79\/80:/);
});

test("data quality penalizes missing route and stale source", () => {
  const healthy = calculateQuality({ hasRoute: true, hasForecast: true, sourceAgeMinutes: 5, reliability: "Висока", anchorErrorKm: 2 });
  const weak = calculateQuality({ hasRoute: false, hasForecast: false, sourceAgeMinutes: 180, reliability: "Низька" });
  assert.ok(healthy > weak);
  assert.ok(healthy >= 0.8);
  assert.ok(weak < 0.3);
});