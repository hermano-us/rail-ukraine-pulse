import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDelayTable } from "../scripts/update-ukraine-data.mjs";

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
  }]);
});
