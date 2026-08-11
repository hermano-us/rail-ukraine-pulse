import test from "node:test";
import assert from "node:assert/strict";
import { scheduleForRequest, verifiedItinerary } from "../backend/src/intelligence/public-rail-routes.js";
import { publicRailRouteKey } from "../js/live-data-client.js";

const schedules = [
  { run_id:"run-east",service_date:"2026-08-11",train_number:"127/128",origin:"Dnipro",destination:"Lviv",scheduled_departure:"2026-08-11T20:00:00Z",updated_at:"2026-08-11T08:00:00Z",metadata_json:JSON.stringify({stations:["Dnipro","Kryvyi Rih","Kropyvnytskyi","Ternopil","Lviv"]}) },
  { run_id:"run-west",service_date:"2026-08-12",train_number:"127/128",origin:"Lviv",destination:"Dnipro",scheduled_departure:"2026-08-12T20:00:00Z",updated_at:"2026-08-12T08:00:00Z",metadata_json:JSON.stringify({stations:["Lviv","Ternopil","Kropyvnytskyi","Kryvyi Rih","Dnipro"]}) },
];

test("route schedule selection is isolated by service date and direction",()=>{
  const request={trainNumber:"127/128",origin:"Dnipro",destination:"Lviv",serviceDate:"2026-08-11",runId:"run-east"};
  const selected=scheduleForRequest(request,schedules);assert.equal(selected.run_id,"run-east");
  const itinerary=verifiedItinerary(request,selected);assert.equal(itinerary.status,"verified");assert.deepEqual(itinerary.intermediateStations,["Kryvyi Rih","Kropyvnytskyi","Ternopil"]);
  assert.equal(scheduleForRequest({...request,serviceDate:"2026-08-12"},schedules),null);
});

test("a composite public number reuses the directional station plan of its active leg",()=>{
  const request={trainNumber:"127/128",origin:"Dnipro",destination:"Lviv",serviceDate:"2026-08-11"};
  assert.equal(scheduleForRequest(request,schedules).run_id,"run-east");
  assert.equal(scheduleForRequest({...request,origin:"Lviv",destination:"Dnipro"},schedules),null);
});

test("leading zero train legs remain equivalent after source normalization",()=>{
  const padded={...schedules[0],run_id:"run-003",train_number:"003"};
  assert.equal(scheduleForRequest({trainNumber:"3/4",origin:"Dnipro",destination:"Lviv",serviceDate:"2026-08-11"},[padded]).run_id,"run-003");
});

test("endpoint-only schedule cannot create a supposedly exact rail corridor",()=>{
  const request={trainNumber:"91",origin:"Kyiv",destination:"Lviv",serviceDate:"2026-08-11"},schedule={run_id:"run-91",service_date:"2026-08-11",train_number:"91",origin:"Kyiv",destination:"Lviv",metadata_json:JSON.stringify({stations:["Kyiv","Lviv"]})};
  const itinerary=verifiedItinerary(request,schedule);assert.equal(itinerary.status,"unverified");assert.equal(itinerary.reason,"insufficient_ordered_waypoints");
});

test("persisted canonical itinerary outranks unordered metadata",()=>{
  const request={trainNumber:"91",origin:"Kyiv",destination:"Lviv",serviceDate:"2026-08-11"},schedule={run_id:"run-91",service_date:"2026-08-11",train_number:"91",origin:"Kyiv",destination:"Lviv",metadata_json:JSON.stringify({stations:["Kyiv","Lviv","Wrong Branch"]}),canonicalItinerary:{hash:"it-v1-known",stops:[{station_name:"Kyiv"},{station_name:"Korosten"},{station_name:"Shepetivka"},{station_name:"Lviv"}]}};
  const itinerary=verifiedItinerary(request,schedule);assert.equal(itinerary.status,"verified");assert.equal(itinerary.source,"canonical_itinerary_v1");assert.equal(itinerary.itineraryHash,"it-v1-known");assert.deepEqual(itinerary.intermediateStations,["Korosten","Shepetivka"]);
});

test("public route cache identity includes the service date",()=>{
  const first=publicRailRouteKey({trainNumber:"127/128",origin:"Dnipro",destination:"Lviv",serviceDate:"2026-08-11"}),second=publicRailRouteKey({trainNumber:"127/128",origin:"Dnipro",destination:"Lviv",serviceDate:"2026-08-12"});assert.notEqual(first,second);assert.match(first,/^v2\|/);
});
