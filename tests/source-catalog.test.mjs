import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));

test("source catalog has unique ids and never claims protected candidates are connected", async () => {
  const catalog = await readJson("sources.json");
  const ids = catalog.sources.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(catalog.sources.find((source) => source.id === "uz-public-board").state, "candidate");
  assert.equal(catalog.sources.find((source) => source.id === "ais-provider").state, "requires-key");
});

test("station reference contains coordinates but no passage claims", async () => {
  const catalog = await readJson("stations.json");
  assert.ok(catalog.stations.length >= 25);
  assert.ok(catalog.stations.every((station) => station.coordinates.length === 2));
  assert.ok(catalog.stations.every((station) => station.passedAt == null));
});
