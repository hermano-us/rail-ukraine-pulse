import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("selected train enters isolated map focus mode with its route and stations", async () => {
  const app = await readFile(new URL("../js/app-ukraine.js", import.meta.url), "utf8");
  const map = await readFile(new URL("../js/map-view-ukraine.js", import.meta.url), "utf8");
  assert.match(app, /mapView\.render\(focused\?\[focused\]:visible/);
  assert.match(map, /if\(!focusedObject&&this\.routes\)this\.routeLayer\.addData/);
  assert.match(map, /for\(const waypoint of object\.waypoints/);
  assert.match(map, /focus-station-/);
});
