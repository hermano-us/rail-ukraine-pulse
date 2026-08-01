import test from "node:test";
import assert from "node:assert/strict";
import { parseAnyTrainDelayBoard, parseAnyTrainStationBoard, parseAnyTrainUpdatedAt } from "../scripts/source-adapters/anytrain.mjs";
import { parseSwRailwayStationSchedule } from "../scripts/source-adapters/swrailway.mjs";
import { collectPoizdatoStations, parsePoizdatoStations } from "../scripts/source-adapters/poizdato.mjs";
import { collectKoleoCatalog, parseKoleoStationCatalog } from "../scripts/source-adapters/koleo.mjs";
import { fuseObservationRowsV4 } from "../backend/src/intelligence/observation-fusion-v3.js";

const delayHtml = `<div class="board">
  <span class="live"><i class="pulse"></i>Дані УЗ · оновлено 11:29</span>
  <div class="brow bhead"></div>
  <div class="brow" data-sev="hard">
    <span class="bno">№39/40</span>
    <span class="brt"><b>Солотвино-1 → Запоріжжя-1</b><span>В дорозі</span></span>
    <span class="bdel bdel--hard"><span aria-hidden="true">▲</span> +4:15</span>
    <span class="bst"><i></i>В дорозі</span>
    <span class="beta">—</span>
    <span class="beta"><i class="rel" title="Надійність прогнозу: Середня"></i>14:56</span>
    <span class="bcause">вплив бойових дій</span>
  </div>
</div>`;

const stationHtml = `<h1>Табло вокзалу · ЛЬВІВ</h1><div class="board">
  <span class="live"><i></i>Дані УЗ · оновлено 11:30</span>
  <div class="brow sbrow" data-sev="hard">
    <span class="sbtime"><b class="sbtime--old">11:03</b><i class="sbtime--new">11:45</i></span>
    <span class="bno">№749Ш</span>
    <span class="brt"><b>КИЇВ-ПАСАЖИРСЬКИЙ</b><span>УЖГОРОД → КИЇВ-ПАСАЖИРСЬКИЙ</span></span>
    <span class="bdel bdel--soft"><span aria-hidden="true">△</span> +42 хв</span>
    <span class="bcause">—</span>
  </div>
</div>`;

test("AnyTrain delay board preserves source time and parses nested row markup", () => {
  const observedAt = "2026-08-01T08:35:00.000Z";
  assert.equal(parseAnyTrainUpdatedAt(delayHtml, observedAt), "2026-08-01T08:29:00.000Z");
  const [update] = parseAnyTrainDelayBoard(delayHtml, observedAt);
  assert.equal(update.trainNumber, "39/40");
  assert.equal(update.route, "Солотвино-1 → Запоріжжя-1");
  assert.equal(update.delayMinutes, 255);
  assert.equal(update.forecastArrival, "14:56");
  assert.equal(update.positionEvidence, "none");
  assert.equal(update.updatedAt, "2026-08-01T08:29:00.000Z");
});

test("AnyTrain station board creates only a bounded station-window observation", () => {
  const { records, updates } = parseAnyTrainStationBoard(stationHtml, "Львів", "2026-08-01T08:35:00.000Z");
  assert.equal(records.length, 1);
  assert.equal(records[0].scheduledTime, "11:03");
  assert.equal(records[0].forecastTime, "11:45");
  assert.equal(updates[0].reportedStation, "Львів");
  assert.equal(updates[0].positionEvidence, "station-board-window");
  assert.equal(updates[0].delayMinutes, 42);
});

test("South-Western Railway schedule remains planned evidence", () => {
  const html = `<table><tr class="on"><td><a href=".?tid=30020">6021 1</a></td><td></td><td>щоденно</td><td>Львів-Приміський – Сянки</td><td>–</td><td>09:32</td><td>2026-06-28</td><td>2026-12-12</td></tr></table>`;
  const result = parseSwRailwayStationSchedule(html, { observedAt: "2026-08-01T08:00:00Z" });
  assert.equal(result.plannedUpdates.length, 1);
  assert.equal(result.plannedUpdates[0].trainNumber, "6021");
  assert.equal(result.plannedUpdates[0].positionEvidence, "none");
  assert.equal(result.plannedUpdates[0].reportedStation, undefined);
  assert.equal(result.records[0].boardType, "departure");
});

test("Poizdato reference parser validates coordinates and cache prevents repeated calls", async () => {
  assert.deepEqual(parsePoizdatoStations({ response: [{ id: "5074", name: "Львів", country_id: "2", coordinates: "49.840969,23.994506" }] })[0].id, "5074");
  let calls = 0;
  const previous = { status: { checkedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString() }, stations: [{ id: "5074", name: "Львів", latitude: 49.84, longitude: 23.99 }], scheduler: { nextOffset: 2 } };
  const result = await collectPoizdatoStations({ previous, fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } });
  assert.equal(calls, 0);
  assert.equal(result.status.cacheHit, true);
});

test("KOLEO public catalog is volume-guarded and cached", async () => {
  const parsed = parseKoleoStationCatalog([{ id: 1, name: "Dorohusk", latitude: 51.1, longitude: 23.8 }, { id: 2, name: "Poznań" }]);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.relevant.length, 1);
  let calls = 0;
  const previous = { recordsCount: 10956, catalogCheckedAt: new Date().toISOString(), status: { checkedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString() }, stations: parsed.relevant };
  const result = await collectKoleoCatalog({ previous, fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } });
  assert.equal(calls, 0);
  assert.equal(result.status.cacheHit, true);
});

test("AnyTrain and direct UZ facts are one correlated source domain", () => {
  const raw = { origin: "Ужгород", destination: "Київ" };
  const groups = fuseObservationRowsV4([
    { event_id: "a", run_id: "r", train_number: "749", station: "Львів", occurred_at: "2026-08-01T08:00:00Z", source_id: "uz-public-board", authority: "official", reliability: .8, raw_update_json: JSON.stringify(raw) },
    { event_id: "b", run_id: "r", train_number: "749", station: "Львів", occurred_at: "2026-08-01T08:02:00Z", source_id: "anytrain-uz-station-board", authority: "reference", reliability: .6, raw_update_json: JSON.stringify(raw) },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].explanation.independentDomains, 1);
  assert.equal(groups[0].evidenceGrade, "official-single");
});
