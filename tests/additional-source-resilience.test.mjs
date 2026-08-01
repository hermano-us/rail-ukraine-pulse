import test from "node:test";
import assert from "node:assert/strict";
import { collectAnyTrain } from "../scripts/source-adapters/anytrain.mjs";
import { collectKoleoCatalog } from "../scripts/source-adapters/koleo.mjs";

test("AnyTrain transport failure preserves recent last-known-good evidence without refreshing it", async () => {
  const updatedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const previous = {
    status: { status: "online", checkedAt: updatedAt, lastSuccessfulAt: updatedAt },
    updates: [{ trainNumber: "91", route: "Київ → Львів", updatedAt, sourceId: "anytrain-uz-delay", delayMinutes: 20, delayLabel: "+20 хв" }],
    records: [], scheduler: { nextOffset: 2 },
  };
  const result = await collectAnyTrain({ previous, stationBudget: 0, fetchImpl: async () => new Response("offline", { status: 503 }) });
  assert.equal(result.status.status, "stale");
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].updatedAt, updatedAt);
  assert.equal(result.scheduler.nextOffset, 2);
});

test("KOLEO volume anomaly cannot replace a healthy cached catalog", async () => {
  const lastSuccessfulAt = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
  const previous = { recordsCount: 10_956, catalogCheckedAt: lastSuccessfulAt, status: { lastSuccessfulAt }, stations: [{ id: "1", name: "Dorohusk" }] };
  const result = await collectKoleoCatalog({
    previous,
    fetchImpl: async () => new Response(JSON.stringify([{ id: 1, name: "Dorohusk" }]), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.status.status, "stale");
  assert.match(result.status.error, /volume anomaly/);
  assert.equal(result.recordsCount, 10_956);
  assert.deepEqual(result.stations, previous.stations);
});
