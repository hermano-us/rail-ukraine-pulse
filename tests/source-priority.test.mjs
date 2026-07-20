import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile(new URL("../data/sources.json", import.meta.url), "utf8"));
const source = (id) => catalog.sources.find((item) => item.id === id);

test("official station board outranks schedule aggregators", () => {
  assert.equal(source("uz-public-board").authority, "official");
  assert.equal(source("uz-public-board").state, "candidate");
  assert.ok(source("uz-public-board").priority < source("poezdato-station-schedule").priority);
  assert.ok(source("uz-public-board").priority < source("kiyavia-station-schedule").priority);
  assert.equal(source("poezdato-station-schedule").state, "reference-only");
  assert.equal(source("kiyavia-station-schedule").state, "reference-only");
});

test("official suburban channel is registered as service alerts, not telemetry", () => {
  const channel = source("uz-suburban-telegram");
  assert.equal(channel.authority, "official");
  assert.equal(channel.kind, "service-alerts");
  assert.ok(!channel.capabilities.includes("position"));
  assert.ok(!channel.capabilities.includes("station-passage"));
});
