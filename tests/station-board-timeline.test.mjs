import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deriveStationLifecycle, deriveStationPresence } from "../js/data-store-ukraine.js";

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
  assert.match(html,/id="map-timeline-range"[^>]+min="-1440"[^>]+step="15"/);
  assert.match(app,/loadMapTimeline/);
  assert.match(app,/buildTimelineObjects/);
  assert.match(client,/\/api\/v1\/timeline/);
});