import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { syncRailGraphReference } from "../backend/src/intelligence/rail-graph-sync.js";
import { resolvePublicRailRoutes } from "../backend/src/intelligence/public-rail-routes.js";

class Statement{constructor(database,sql){this.database=database;this.sql=sql;this.values=[];}bind(...values){this.values=values;return this;}all(){return {results:this.database.prepare(this.sql).all(...this.values)};}first(){return this.database.prepare(this.sql).get(...this.values)||null;}run(){return this.database.prepare(this.sql).run(...this.values);}}
class D1Adapter{constructor(database){this.database=database;}prepare(sql){return new Statement(this.database,sql);}async batch(statements){return statements.map((statement)=>statement.run());}}
test("route aliases use itinerary context for fuzzy and ambiguous station names",async()=>{
  const database=new DatabaseSync(":memory:");
  for(const name of ["0011_intelligence_platform.sql","0014_rail_graph_registry.sql","0013_rail_intelligence_v2.sql","0015_rail_intelligence_routing.sql","0016_rail_foundation_fusion.sql","0018_observation_fusion_v2.sql","0024_rail_graph_v4_registry_quality.sql","0026_route_aware_rail_graph.sql"])database.exec(await readFile(new URL(`../backend/migrations/${name}`,import.meta.url),"utf8"));
  const versionId="osm-context-test",stations=[
    {stationId:"start",officialName:"Початок",coordinates:[25.6,49.55],aliases:[{key:"початок",value:"Початок",confidence:1}]},
    {stationId:"zolochiv-west",officialName:"Золочів",coordinates:[24.89,49.79],aliases:[]},
    {stationId:"zolochiv-east",officialName:"Золочів",coordinates:[35.99,50.28],aliases:[]},
    {stationId:"krasne-west",officialName:"Красне",coordinates:[24.62,49.92],aliases:[]},
    {stationId:"krasne-south",officialName:"Красне",coordinates:[29.27,46.12],aliases:[]},
    {stationId:"finish",officialName:"Кінець",coordinates:[23.99,49.84],aliases:[{key:"кінець",value:"Кінець",confidence:1}]},
  ],segments=[
    {fromStationId:"start",toStationId:"zolochiv-west",geometry:{type:"LineString",coordinates:[[25.6,49.55],[24.89,49.79]]},distanceKm:60,geometryQuality:.98,bidirectional:true},
    {fromStationId:"zolochiv-west",toStationId:"krasne-west",geometry:{type:"LineString",coordinates:[[24.89,49.79],[24.62,49.92]]},distanceKm:25,geometryQuality:.98,bidirectional:true},
    {fromStationId:"krasne-west",toStationId:"finish",geometry:{type:"LineString",coordinates:[[24.62,49.92],[23.99,49.84]]},distanceKm:50,geometryQuality:.98,bidirectional:true},
  ],assets=new Map([
    ["manifest.json",{versionId,source:"test",checksum:"context",stationCount:stations.length,segmentCount:segments.length,aliasConflictCount:2,unmatchedStationCount:0,stationChunkSize:stations.length,segmentChunkSize:segments.length,stationChunks:["stations-000.json"],segmentChunks:["segments-000.json"]}],
    ["stations-000.json",{versionId,stations}],["segments-000.json",{versionId,segments}],
    ["topology.json",{versionId,edges:segments.map((item)=>({from:item.fromStationId,to:item.toStationId,distanceKm:item.distanceKm,railwayType:"rail",usage:"main",services:[],routeRelationIds:[]}))}],
  ]),env={DB:new D1Adapter(database),ASSETS:{fetch:async(request)=>{const name=new URL(request.url).pathname.split("/").at(-1);return assets.has(name)?Response.json(assets.get(name)):new Response("missing",{status:404});}}};
  assert.equal((await syncRailGraphReference(env,"2026-08-11T10:00:00Z",{stationChunks:2,segmentChunks:2})).status,"activated");
  database.prepare(`INSERT INTO expected_train_runs(expected_id,run_id,service_date,train_number,origin,destination,first_seen_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)`).run("128","run-128","2026-08-11","128","Початок","Кінець","2026-08-11T10:00:00Z","2026-08-11T10:00:00Z",JSON.stringify({orderedStations:["Початок","Злочів","Красне","Кінець"]}));
  const result=await resolvePublicRailRoutes(env,[{key:"128",trainNumber:"128",origin:"Початок",destination:"Кінець",serviceDate:"2026-08-11",runId:"run-128"}],"2026-08-11T10:05:00Z");
  assert.equal(result.routes[0].status,"ready",JSON.stringify(result));assert.equal(result.routes[0].verification.waypointCount,2);assert.equal(result.routes[0].method,"itinerary-constrained-v1");database.close();
});