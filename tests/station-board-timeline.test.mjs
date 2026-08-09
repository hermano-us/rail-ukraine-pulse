import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deriveOperationalDisruption, deriveStationLifecycle, deriveStationPresence, freezeDisruptedPosition } from "../js/data-store-ukraine.js";

test("station presence distinguishes a passage from a retained terminal arrival", () => {
  const now=new Date("2026-07-29T12:00:00Z");
  const passage=deriveStationPresence({reportedStation:"Фастів",destination:"Київ",operationalStatus:"moving",publicStatus:"прослідував станцію",updatedAt:"2026-07-29T11:50:00Z"},now);
  assert.equal(passage.kind,"passage");
  assert.equal(passage.holdsPosition,false);
  const arrival=deriveStationPresence({reportedStation:"Київ",destination:"Київ",operationalStatus:"moving",publicStatus:"прибув",updatedAt:"2026-07-29T11:50:00Z"},now);
  assert.equal(arrival.kind,"destination-arrival");
  assert.equal(arrival.holdsPosition,true);
  assert.equal(arrival.fresh,true);
});

test("station lifecycle separates passage, dwell, departure and completion", () => {
  const now=new Date("2026-07-29T12:00:00Z");
  assert.equal(deriveStationLifecycle({reportedStation:"Фастів",destination:"Київ",operationalStatus:"moving",publicStatus:"прослідував станцію",updatedAt:"2026-07-29T11:55:00Z"},now).phase,"passed");
  assert.equal(deriveStationLifecycle({reportedStation:"Фастів",destination:"Київ",operationalStatus:"station",publicStatus:"на станції",updatedAt:"2026-07-29T11:55:00Z"},now).phase,"dwelling");
  assert.equal(deriveStationLifecycle({reportedStation:"Фастів",destination:"Київ",operationalStatus:"moving",publicStatus:"відправився зі станції",updatedAt:"2026-07-29T11:55:00Z"},now).phase,"departed");
  assert.equal(deriveStationLifecycle({reportedStation:"Київ",destination:"Київ",operationalStatus:"station",publicStatus:"прибув на кінцеву",updatedAt:"2026-07-29T11:55:00Z"},now).phase,"completed");
});
test("old station arrivals are labelled as last facts, not current telemetry", () => {
  const presence=deriveStationPresence({reportedStation:"Львів",destination:"Львів",operationalStatus:"station",updatedAt:"2026-07-29T06:00:00Z"},new Date("2026-07-29T12:00:00Z"));
  assert.equal(presence.holdsPosition,true);
  assert.equal(presence.fresh,false);
  assert.match(presence.label,/Последний факт/);
});

test("public map contains a collapsible station board and a 24-hour timeline", async () => {
  const [html,app,client]=await Promise.all([
    readFile(new URL("../index.html",import.meta.url),"utf8"),
    readFile(new URL("../js/app-ukraine.js",import.meta.url),"utf8"),
    readFile(new URL("../js/live-data-client.js",import.meta.url),"utf8"),
  ]);
  assert.match(html,/id="station-board"/);
  assert.match(html,/data-board-mode="arrivals"/);
  assert.match(html,/id="map-timeline-meta"/);
  assert.match(html,/id="map-timeline-toggle"[^>]+aria-expanded="true"/);
  assert.match(html,/id="map-timeline-range"[^>]+min="-1440"[^>]+step="15"/);
  assert.match(app,/TIMELINE_COLLAPSE_KEY/);
  assert.match(app,/setMapTimelineCollapsed/);
  assert.match(app,/loadMapTimeline/);
  assert.match(app,/buildTimelineObjects/);
  assert.match(client,/\/api\/v1\/timeline/);
});
test("a stop without a station retains a frozen probabilistic marker",()=>{
  const update={operationalStatus:"moving",publicStatus:"рух зупинено",updatedAt:"2026-08-09T03:55:00Z",delayMinutes:90};
  assert.equal(deriveOperationalDisruption(update).held,true);
  const position=freezeDisruptedPosition({
    update,routeResult:{coordinates:[[30,50],[31,50]],anchorErrorKm:2},
    estimate:{coordinates:[30.25,50],confidence:.6,errorKm:18,calculation:{progress:.25}},
    now:new Date("2026-08-09T04:10:00Z"),sourceAgeMinutes:15,
  });
  assert.deepEqual(position.coordinates,[30.25,50]);
  assert.equal(position.calculation.progress,.25);
  assert.equal(position.calculation.frozen,true);
  assert.equal(position.method,"operational-hold-frozen-estimate");
  assert.ok(position.errorKm>=25);
});

test("a stationless hold falls back to a broad route envelope instead of disappearing",()=>{
  const position=freezeDisruptedPosition({update:{publicStatus:"поезд остановлен",updatedAt:"2026-08-09T03:00:00Z"},routeResult:{coordinates:[[30,50],[31,50]]},now:new Date("2026-08-09T05:00:00Z"),sourceAgeMinutes:120});
  assert.ok(position.coordinates.every(Number.isFinite));
  assert.equal(position.status,"stale");
  assert.equal(position.method,"operational-hold-route-envelope");
  assert.ok(position.errorKm>50);
});
