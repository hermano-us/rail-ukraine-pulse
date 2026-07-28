import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { buildRailGraph, buildStationRegistry, normalizeStationAlias, stationAliasVariants } from "../scripts/lib/rail-graph-builder.mjs";
import { loadStationAliasMap, syncRailGraphReference } from "../backend/src/intelligence/rail-graph-sync.js";

class Statement {
  constructor(database,sql){this.database=database;this.sql=sql;this.values=[];}
  bind(...values){this.values=values;return this;}
  all(){return {results:this.database.prepare(this.sql).all(...this.values)};}
  first(){return this.database.prepare(this.sql).get(...this.values)||null;}
  run(){return this.database.prepare(this.sql).run(...this.values);}
}
class D1Adapter { constructor(database){this.database=database;} prepare(sql){return new Statement(this.database,sql);} async batch(statements){return statements.map((statement)=>statement.run());} }

test("station aliases normalize common spelling and passenger suffix variants",()=>{
  assert.equal(normalizeStationAlias("  KYIV Passenger Railway  "),"kyiv-passenger-railway");
  assert.ok(stationAliasVariants("Kyiv-1").has("kyiv1"));
});

test("rail graph follows physical track geometry and never invents a straight line",()=>{
  const reviewedStations=[
    {id:"alpha",name:"Alpha",coordinates:[30,50]},
    {id:"beta",name:"Beta",coordinates:[30.2,50]},
    {id:"orphan",name:"Orphan",coordinates:[35,45]},
  ];
  const osmElements=[
    {type:"node",id:1,lat:50,lon:30,tags:{railway:"station",name:"Alpha"}},
    {type:"node",id:2,lat:50.1,lon:30.1},
    {type:"node",id:3,lat:50,lon:30.2,tags:{railway:"station",name:"Beta"}},
    {type:"way",id:10,nodes:[1,2,3],tags:{railway:"rail"}},
    {type:"way",id:11,nodes:[1,3],tags:{highway:"primary"}},
  ];
  const registry=buildStationRegistry({reviewedStations,osmElements});
  const graph=buildRailGraph({osmElements,registry});
  const segment=graph.segments.find((item)=>item.fromStationId==="alpha"&&item.toStationId==="beta");
  assert.ok(segment);
  assert.deepEqual(segment.geometry.coordinates,[[30,50],[30.1,50.1],[30.2,50]]);
  assert.equal(segment.bidirectional,true);
  assert.ok(segment.distanceKm>20);
  assert.ok(graph.unmatchedStations.includes("orphan"));
});

test("chunked graph import activates a complete version and creates reverse geometry",async()=>{
  const database=new DatabaseSync(":memory:");
  database.exec(await readFile(new URL("../backend/migrations/0014_rail_graph_registry.sql",import.meta.url),"utf8"));
  const versionId="test-v1";
  const assets=new Map([
    ["manifest.json",{versionId,source:"test",checksum:"abc",stationCount:2,segmentCount:1,aliasConflictCount:0,unmatchedStationCount:0,stationChunkSize:1,segmentChunkSize:1,stationChunks:["stations-000.json","stations-001.json"],segmentChunks:["segments-000.json"]}],
    ["stations-000.json",{versionId,stations:[{stationId:"alpha",officialName:"Alpha",coordinates:[30,50],aliases:[{key:"alpha",value:"Alpha",source:"test",confidence:1}]}]}],
    ["stations-001.json",{versionId,stations:[{stationId:"beta",officialName:"Beta",coordinates:[30.2,50],aliases:[{key:"beta",value:"Beta",source:"test",confidence:1}]}]}],
    ["segments-000.json",{versionId,segments:[{fromStationId:"alpha",toStationId:"beta",geometry:{type:"LineString",coordinates:[[30,50],[30.1,50.1],[30.2,50]]},distanceKm:25,geometryQuality:.98,bidirectional:true}]}],
  ]);
  const env={DB:new D1Adapter(database),ASSETS:{fetch:async(request)=>{const name=new URL(request.url).pathname.split("/").at(-1);return assets.has(name)?Response.json(assets.get(name)):new Response("missing",{status:404});}}};
  const partial=await syncRailGraphReference(env,"2026-07-28T10:00:00.000Z");
  assert.equal(partial.status,"importing");
  assert.equal(database.prepare("SELECT COUNT(*) total FROM rail_segment_geometries WHERE active=1").get().total,0);
  const result=await syncRailGraphReference(env,"2026-07-28T10:05:00.000Z");
  assert.equal(result.status,"activated");
  assert.equal(database.prepare("SELECT status FROM rail_graph_versions WHERE version_id=?").get(versionId).status,"active");
  assert.equal(database.prepare("SELECT COUNT(*) total FROM rail_segment_geometries WHERE active=1").get().total,2);
  const reverse=JSON.parse(database.prepare("SELECT geometry_json FROM rail_segment_geometries WHERE from_station_id='beta'").get().geometry_json);
  assert.deepEqual(reverse.coordinates,[[30.2,50],[30.1,50.1],[30,50]]);
  const aliases=await loadStationAliasMap(env);
  assert.equal(aliases.get("alpha"),"alpha");
  database.close();
});
