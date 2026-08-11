import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { syncRailGraphReference } from "../backend/src/intelligence/rail-graph-sync.js";
import { resolvePublicRailRoutes } from "../backend/src/intelligence/public-rail-routes.js";

class Statement{constructor(database,sql){this.database=database;this.sql=sql;this.values=[];}bind(...values){this.values=values;return this;}all(){return {results:this.database.prepare(this.sql).all(...this.values)};}first(){return this.database.prepare(this.sql).get(...this.values)||null;}run(){return this.database.prepare(this.sql).run(...this.values);}}
class D1Adapter{constructor(database){this.database=database;}prepare(sql){return new Statement(this.database,sql);}async batch(statements){return statements.map((statement)=>statement.run());}}

test("train 779 public route follows imported OSM segments and scheduled waypoints",async()=>{
  const database=new DatabaseSync(":memory:");
  for(const name of ["0011_intelligence_platform.sql","0014_rail_graph_registry.sql","0013_rail_intelligence_v2.sql","0015_rail_intelligence_routing.sql","0016_rail_foundation_fusion.sql","0018_observation_fusion_v2.sql","0024_rail_graph_v4_registry_quality.sql","0026_route_aware_rail_graph.sql"])database.exec(await readFile(new URL(`../backend/migrations/${name}`,import.meta.url),"utf8"));
  const versionId="osm-779-test",stations=[
    {stationId:"sumy",officialName:"Суми",coordinates:[34.7982,50.9102],aliases:[{key:"суми",value:"Суми",confidence:1}]},
    {stationId:"nizhyn",officialName:"Ніжин",coordinates:[31.8914,51.0478],aliases:[{key:"ніжин",value:"Ніжин",confidence:1}]},
    {stationId:"bobryk",officialName:"Бобрик",coordinates:[31.1,50.72],aliases:[{key:"бобрик",value:"Бобрик",confidence:1}]},
    {stationId:"kyiv",officialName:"Київ-Пас.",coordinates:[30.484,50.4406],aliases:[{key:"київ-пас",value:"Київ-Пас.",confidence:1},{key:"київ",value:"Київ",confidence:.9}]},
  ];
  const segments=[
    {fromStationId:"sumy",toStationId:"nizhyn",geometry:{type:"LineString",coordinates:[[34.7982,50.9102],[33.5,51.18],[31.8914,51.0478]]},distanceKm:230,geometryQuality:.98,bidirectional:true},
    {fromStationId:"nizhyn",toStationId:"bobryk",geometry:{type:"LineString",coordinates:[[31.8914,51.0478],[31.5,50.9],[31.1,50.72]]},distanceKm:78,geometryQuality:.98,bidirectional:true},
    {fromStationId:"bobryk",toStationId:"kyiv",geometry:{type:"LineString",coordinates:[[31.1,50.72],[30.8,50.62],[30.484,50.4406]]},distanceKm:58,geometryQuality:.98,bidirectional:true},
  ];
  const assets=new Map([
    ["manifest.json",{versionId,source:"test",checksum:"779",stationCount:4,segmentCount:3,aliasConflictCount:0,unmatchedStationCount:0,stationChunkSize:4,segmentChunkSize:3,stationChunks:["stations-000.json"],segmentChunks:["segments-000.json"]}],
    ["stations-000.json",{versionId,stations}],
    ["segments-000.json",{versionId,segments}],
    ["topology.json",{versionId,edges:segments.map((item)=>({from:item.fromStationId,to:item.toStationId,distanceKm:item.distanceKm,railwayType:"rail",usage:"main",services:[],routeRelationIds:[]}))}],
  ]);
  const env={DB:new D1Adapter(database),ASSETS:{fetch:async(request)=>{const name=new URL(request.url).pathname.split("/").at(-1);return assets.has(name)?Response.json(assets.get(name)):new Response("missing",{status:404});}}};
  const imported=await syncRailGraphReference(env,"2026-08-09T10:00:00.000Z",{stationChunks:2,segmentChunks:2});assert.equal(imported.status,"activated");
  database.prepare(`INSERT INTO expected_train_runs(expected_id,run_id,service_date,train_number,origin,destination,first_seen_at,updated_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)`).run("779","run-779","2026-08-09","779","Суми","Київ-Пас.","2026-08-09T10:00:00Z","2026-08-09T10:00:00Z",JSON.stringify({stations:["Суми","Ніжин","Бобрик","Київ-Пас."]}));
  const result=await resolvePublicRailRoutes(env,[{key:"779|Суми|Київ-Пас.",trainNumber:"779",origin:"Суми",destination:"Київ-Пас."}],"2026-08-09T10:05:00Z");
  assert.equal(result.routes[0].status,"ready");assert.equal(result.routes[0].method,"osm-route-aware-v7");assert.equal(result.routes[0].geometry.coordinates.length,7);assert.ok(result.routes[0].geometry.coordinates.some(([longitude,latitude])=>longitude===31.1&&latitude===50.72));assert.equal(result.calculated,1);
  database.close();
});
