import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ingestExpectedRuns } from "../backend/src/intelligence/expected-registry.js";

class Statement{constructor(database,sql){this.database=database;this.sql=sql;this.values=[];}bind(...values){this.values=values;return this;}all(){return{results:this.database.prepare(this.sql).all(...this.values)};}run(){return this.database.prepare(this.sql).run(...this.values);}}
class DB{constructor(database){this.database=database;}prepare(sql){return new Statement(this.database,sql);}async batch(statements){return statements.map((item)=>item.run());}}

test("station-board cycles accumulate one dated itinerary instead of replacing it",async()=>{
  const database=new DatabaseSync(":memory:");for(const file of ["0011_intelligence_platform.sql","0018_observation_fusion_v2.sql","0027_rail_route_compiler.sql"])database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));const env={DB:new DB(database)},base={expectedId:"expected:91",runId:"run:91",serviceDate:"2026-08-11",trainNumber:"91",origin:"Kyiv",destination:"Lviv",route:"Kyiv — Lviv",sourceIds:["uz-public-board"]};
  database.exec(await readFile(new URL("../backend/migrations/0014_rail_graph_registry.sql",import.meta.url),"utf8"));
  await ingestExpectedRuns(env,[{...base,metadata:{stations:["Kyiv","Korosten","Lviv"],stationCalls:[{key:"kyiv",station:"Kyiv",scheduledAt:"2026-08-11T09:30:00Z"},{key:"korosten",station:"Korosten",scheduledAt:"2026-08-11T11:15:00Z"}]}}],"2026-08-11T06:00:00Z");
  await ingestExpectedRuns(env,[{...base,metadata:{stations:["Kyiv","Shepetivka","Lviv"],stationCalls:[{key:"shepetivka",station:"Shepetivka",scheduledAt:"2026-08-11T14:00:00Z"},{key:"lviv",station:"Lviv",scheduledAt:"2026-08-11T18:00:00Z"}]}}],"2026-08-11T06:15:00Z");
  const metadata=JSON.parse(database.prepare("SELECT metadata_json FROM expected_train_runs WHERE expected_id='expected:91'").get().metadata_json),itinerary=database.prepare("SELECT * FROM run_itineraries WHERE run_id='run:91'").get(),stops=database.prepare("SELECT station_name FROM run_itinerary_stops WHERE itinerary_id=? ORDER BY sequence_no").all(itinerary.itinerary_id).map((item)=>item.station_name);assert.deepEqual(metadata.stations,["Kyiv","Korosten","Lviv","Shepetivka"]);assert.equal(metadata.stationCalls.length,4);assert.equal(itinerary.status,"verified");assert.deepEqual(stops,["Kyiv","Korosten","Shepetivka","Lviv"]);database.close();
});
test("legacy expected id is reused when the physical run id already exists",async()=>{
  const database=new DatabaseSync(":memory:");
  for(const file of ["0011_intelligence_platform.sql","0018_observation_fusion_v2.sql","0027_rail_route_compiler.sql","0014_rail_graph_registry.sql"]) database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));
  const env={DB:new DB(database)},now="2026-08-11T06:00:00Z";
  await ingestExpectedRuns(env,[{expectedId:"expected:legacy:779",runId:"uz:2026-08-11:779",serviceDate:"2026-08-11",trainNumber:"779",origin:"Sumy",destination:"Kyiv",metadata:{orderedStations:["Sumy","Konotop","Kyiv"]}}],now);
  await ingestExpectedRuns(env,[{expectedId:"expected:new:779",runId:"uz:2026-08-11:779",serviceDate:"2026-08-11",trainNumber:"779",origin:"Sumy",destination:"Kyiv",metadata:{orderedStations:["Sumy","Vorozhba","Konotop","Kyiv"]}}],"2026-08-11T06:10:00Z");
  const persisted=database.prepare("SELECT expected_id,metadata_json FROM expected_train_runs WHERE run_id='uz:2026-08-11:779'").get();
  const itinerary=database.prepare("SELECT expected_id,stop_count FROM run_itineraries WHERE run_id='uz:2026-08-11:779'").get();
  assert.equal(persisted.expected_id,"expected:legacy:779");
  assert.deepEqual(JSON.parse(persisted.metadata_json).orderedStations,["Sumy","Vorozhba","Konotop","Kyiv"]);
  assert.equal(itinerary.expected_id,"expected:legacy:779");
  assert.equal(itinerary.stop_count,4);
  database.close();
});
