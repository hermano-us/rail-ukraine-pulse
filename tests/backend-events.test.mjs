import test from "node:test";
import assert from "node:assert/strict";
import { runIdFor, updateToEvents, updatesToEvents, validateEvent } from "../backend/src/domain/events.js";

const update = {
  trainNumber: "91/92",
  route: "Київ — Львів",
  origin: "Київ-Пас.",
  destination: "Львів",
  updatedAt: "2026-07-20T10:00:00Z",
  sourceId: "uz-public-board",
  publicStatus: "Прямує",
  delayMinutes: 12,
  forecastArrival: "14:35",
  reportedStation: "Козятин-1",
  positionEvidence: "station-board-window",
};

test("source update becomes immutable, traceable events", () => {
  const events = updateToEvents(update, { observedAt: "2026-07-20T10:01:00Z" });
  assert.deepEqual(events.map((event) => event.type), [
    "movement_status", "delay_update", "forecast_arrival", "station_report",
  ]);
  assert.ok(events.every((event) => validateEvent(event).valid));
  assert.ok(events.every((event) => event.runId === events[0].runId));
  assert.equal(events.find((event) => event.type === "station_report").reliability, 0.78);
  assert.equal(events[0].occurredAt, "2026-07-20T10:00:00.000Z");
  assert.equal(events[0].observedAt, "2026-07-20T10:01:00.000Z");
});

test("event ids and run ids are deterministic", () => {
  const observedAt = "2026-07-20T10:01:00Z";
  assert.equal(runIdFor(update, observedAt), runIdFor({ ...update }, observedAt));
  assert.deepEqual(updateToEvents(update, { observedAt }), updateToEvents(update, { observedAt }));
  assert.equal(updatesToEvents([update, update], { observedAt }).length, 4);
});

test("operational events require a train number", () => {
  assert.deepEqual(updateToEvents({ ...update, trainNumber: null }), []);
});

