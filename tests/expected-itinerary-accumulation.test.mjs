import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ingestExpectedRuns } from "../backend/src/intelligence/expected-registry.js";

class Statement{constructor(database,sql){this.database=database;this.sql=sql;this.values=[];}bind(...values){this.values=values;return this;}all(){return{results:this.database.prepare(this.sql).all(...this.values)};}run(){return this.database.prepare(this.sql).run(...this.values);}}
class DB{constructor(database){this.database=database;}prepare(sql){return new Statement(this.database,sql);}async batch(statements){return statements.map((item)=>item.run());}}

test("station-board cycles accumulate one dated itinerary instead of replacing it",async()=>{
  const database=new DatabaseSync(":memory:");for(const file of ["0011_intelligence_platform.sql","0018_observation_fusion_v2.sql"])database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));const env={DB:new DB(database)},base={expectedId:"expected:91",runId:"run:91",serviceDate:"2026-08-11",trainNumber:"91",origin:"Kyiv",destination:"Lviv",route:"Kyiv — Lviv",sourceIds:["uz-public-board"]};
  await ingestExpectedRuns(env,[{...base,metadata:{stations:["Kyiv","Korosten","Lviv"],stationCalls:[{key:"kyiv",station:"Kyiv",scheduledAt:"2026-08-11T09:30:00Z"},{key:"korosten",station:"Korosten",scheduledAt:"2026-08-11T11:15:00Z"}]}}],"2026-08-11T06:00:00Z");
  await ingestExpectedRuns(env,[{...base,metadata:{stations:["Kyiv","Shepetivka","Lviv"],stationCalls:[{key:"shepetivka",station:"Shepetivka",scheduledAt:"2026-08-11T14:00:00Z"},{key:"lviv",station:"Lviv",scheduledAt:"2026-08-11T18:00:00Z"}]}}],"2026-08-11T06:15:00Z");
  const metadata=JSON.parse(database.prepare("SELECT metadata_json FROM expected_train_runs WHERE expected_id='expected:91'").get().metadata_json);assert.deepEqual(metadata.stations,["Kyiv","Korosten","Lviv","Shepetivka"]);assert.equal(metadata.stationCalls.length,4);database.close();
});
