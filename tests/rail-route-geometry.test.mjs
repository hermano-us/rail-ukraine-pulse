import test from "node:test";
import assert from "node:assert/strict";
import { buildRailGraph, preferPhysicalRailRoute, railPath, railPathViaAnchor } from "../js/data-store-ukraine.js";

const feature = (coordinates) => ({ geometry: { type: "LineString", coordinates } });

test("reported station becomes a route anchor when the detour is credible", () => {
  const graph = buildRailGraph([
    feature([[30, 50], [32, 50]]),
    feature([[30, 50], [31, 50.1], [32, 50]]),
  ]);
  const direct = railPath(graph, [30, 50], [32, 50]);
  const anchored = railPathViaAnchor(graph, [30, 50], [32, 50], [31, 50.1]);
  assert.ok(direct.totalKm < anchored.totalKm);
  assert.equal(anchored.viaAnchor, true);
  assert.ok(anchored.coordinates.some(([lng, lat]) => lng === 31 && lat === 50.1));
});

test("implausible reported station cannot distort the route", () => {
  const graph = buildRailGraph([feature([[30, 50], [31, 50], [32, 50]])]);
  const direct = railPath(graph, [30, 50], [32, 50]);
  const result = railPathViaAnchor(graph, [30, 50], [32, 50], [35, 52]);
  assert.deepEqual(result.coordinates, direct.coordinates);
  assert.equal(result.viaAnchor, undefined);
});

test("route is hidden when endpoints are too far from the rail graph", () => {
  const graph = buildRailGraph([feature([[30, 50], [31, 50]])]);
  assert.equal(railPath(graph, [30.4, 49.7], [31, 50]), null);
});

test("route is hidden when a sparse graph produces an implausible detour", () => {
  const graph = buildRailGraph([feature([[30, 50], [31, 51], [32, 50]])]);
  assert.equal(railPath(graph, [30, 50], [32, 50]), null);
});

test("public OSM geometry replaces the schematic corridor used by train 779",()=>{
  const schematic={coordinates:[[34.7982,50.9102],[33.9,50.75],[32.65,50.6],[31.8914,51.0478],[30.484,50.4406]],totalKm:348};
  const physical={status:"ready",versionId:"osm-test",method:"osm-route-aware-v7",quality:.98,confidence:.91,totalKm:361,geometry:{type:"LineString",coordinates:[[34.7982,50.9102],[34.62,50.78],[33.38,51.24],[31.8914,51.0478],[31.3,50.82],[30.484,50.4406]]}};
  const result=preferPhysicalRailRoute(physical,schematic);
  assert.equal(result.method,"osm-route-aware-v7");
  assert.equal(result.coordinates.length,6);
  assert.notDeepEqual(result.coordinates,schematic.coordinates);
});

test("schematic route remains a safe fallback when public routing is unavailable",()=>{
  const schematic={coordinates:[[30,50],[31,51]],totalKm:120};
  assert.equal(preferPhysicalRailRoute({status:"unavailable"},schematic),schematic);
});
