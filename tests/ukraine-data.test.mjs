import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDelayTable } from "../scripts/update-ukraine-data.mjs";

const readJson = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));

test("Ukraine dataset covers all requested regions and contains depot objects", async () => {
  const trains = await readJson("trains.json");
  const regions = await readJson("regions.geojson");
  const requested = new Set(regions.features.map((feature) => feature.properties.id));
  const covered = new Set(trains.objects.flatMap((object) => object.regions));
  assert.equal(requested.size, 22);
  for (const region of requested) assert.ok(covered.has(region), `missing train coverage for ${region}`);
  assert.ok(trains.objects.some((object) => object.operationalStatus === "depot"));
});

test("public train cards have descriptions and attributed photos", async () => {
  const trains = await readJson("trains.json");
  for (const train of trains.objects) {
    assert.ok(train.name && train.description);
    assert.ok(train.photo?.sourceUrl && train.photo?.credit && train.photo?.license);
  }
});

test("delay table adapter normalizes public updates", () => {
  const html = `<table><tr><td>№ 91/92</td><td>Київ — Львів</td><td>+ 01:12</td><td>В дорозі</td><td></td><td></td><td>Висока</td><td>Операційна причина</td></tr></table>`;
  assert.deepEqual(parseDelayTable(html).map(({ updatedAt, source, ...item }) => item), [{
    trainNumber: "91/92",
    route: "Київ — Львів",
    origin: "Київ",
    destination: "Львів",
    delayMinutes: 72,
    delayLabel: "+ 01:12",
    publicStatus: "В дорозі",
    operationalStatus: "moving",
    reliability: "Висока",
    reason: "Операційна причина",
  }]);
});

