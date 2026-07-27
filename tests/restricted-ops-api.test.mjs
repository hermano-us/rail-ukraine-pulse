import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { handleIntelligencePlatformRequest } from "../backend/src/intelligence/api.js";

class Statement{constructor(database,sql){this.database=database;this.sql=sql;this.values=[];}bind(...values){this.values=values;return this;}all(){return{results:this.database.prepare(this.sql).all(...this.values)};}first(){return this.database.prepare(this.sql).get(...this.values)||null;}run(){return this.database.prepare(this.sql).run(...this.values);}}
class D1Adapter{constructor(database){this.database=database;}prepare(sql){return new Statement(this.database,sql);}async batch(statements){return statements.map(statement=>statement.run());}}

test("restricted Operations Hub returns probabilistic freight corridors and station facts",async()=>{
  const database=new DatabaseSync(":memory:");
  for(const file of ["0010_secure_core.sql","0011_intelligence_platform.sql"])database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));
  const now=new Date().toISOString();
  database.prepare("INSERT INTO restricted_evidence(evidence_id,domain,source_id,occurred_at,received_at,evidence_excerpt,classification_json,corridor_code,confidence,sensitivity_level,review_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("e-1","rail_freight","freight-tg-test",now,now,"Вантажний поїзд на станції Коростень",JSON.stringify({freightType:"bulk",station:"Коростень",direction:"київ"}),"kyiv-korosten",.55,"restricted","pending",now,now);
  const response=await handleIntelligencePlatformRequest(new Request("https://example.test/api/restricted/operations-hub"),{DB:new D1Adapter(database)},{permissions:["*"]},(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}}));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.freightCorridors.length,1);
  assert.equal(body.freightStationFacts[0].station,"Коростень");
  assert.equal(body.freightPolicy.exactFreightPositions,false);
  database.close();
});
