import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { handleIntelligencePlatformRequest } from "../backend/src/intelligence/api.js";

class Statement{constructor(database,sql){this.database=database;this.sql=sql;this.values=[];}bind(...values){this.values=values;return this;}all(){return{results:this.database.prepare(this.sql).all(...this.values)};}first(){return this.database.prepare(this.sql).get(...this.values)||null;}run(){return this.database.prepare(this.sql).run(...this.values);}}
class D1Adapter{constructor(database){this.database=database;}prepare(sql){return new Statement(this.database,sql);}async batch(statements){return statements.map(statement=>statement.run());}}

test("restricted Operations Hub returns probabilistic freight corridors and station facts",async()=>{
  const database=new DatabaseSync(":memory:");
  for(const file of ["0001_initial.sql","0010_secure_core.sql","0011_intelligence_platform.sql","0013_rail_intelligence_v2.sql","0014_rail_graph_registry.sql"])database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));
  const now=new Date().toISOString();
  database.prepare("INSERT INTO restricted_evidence(evidence_id,domain,source_id,occurred_at,received_at,evidence_excerpt,classification_json,corridor_code,confidence,sensitivity_level,review_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("e-1","rail_freight","freight-tg-test",now,now,"Вантажний поїзд на станції Коростень",JSON.stringify({freightType:"bulk",station:"Коростень",direction:"київ",locomotive:"ВЛ80Т-1445",entityKey:"locomotive:ВЛ80Т-1445",entityConfidence:.92}),"kyiv-korosten",.55,"restricted","pending",now,now);
  const response=await handleIntelligencePlatformRequest(new Request("https://example.test/api/restricted/operations-hub"),{DB:new D1Adapter(database)},{permissions:["*"]},(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}}));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.freightCorridors.length,1);
  assert.equal(body.freightStationFacts[0].station,"Коростень");
  assert.equal(body.freightTracks.length,1);
  assert.equal(body.freightTracks[0].linkedMovementId,null);
  assert.equal(body.freightPolicy.exactFreightPositions,false);
  database.prepare("INSERT INTO runs(run_id,train_number,service_date,route,origin,destination,current_update_json,first_observed_at,last_observed_at) VALUES(?,?,?,?,?,?,?,?,?)").run("run-ops","6366","2026-07-27","Гребінка — Ромодан","Гребінка","Ромодан","{}",now,now);
  database.prepare("INSERT INTO ops_movements(movement_id,run_id,train_number,last_observed_at,confidence,position_status) VALUES(?,?,?,?,?,?)").run("run-ops","run-ops","6366",now,.3,"estimated");
  const factResponse=await handleIntelligencePlatformRequest(new Request("https://example.test/api/restricted/rail-intelligence",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"run-ops",trainNumber:"6366",station:"Гребінка",observedAt:now,reliability:.82,note:"operator check"})}),{DB:new D1Adapter(database)},{id:"admin-1",role:"administrator",permissions:["*"]},(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}}));
  assert.equal(factResponse.status,201); assert.equal(database.prepare("SELECT source_id FROM events WHERE run_id='run-ops'").get().source_id,"operations-hub"); const movement=database.prepare("SELECT last_station,position_status,confidence FROM ops_movements WHERE run_id='run-ops'").get(); assert.equal(movement.last_station,"Гребінка"); assert.equal(movement.position_status,"reported"); assert.equal(movement.confidence,.82); assert.equal(database.prepare("SELECT COUNT(*) total FROM secure_audit WHERE action='rail.observation_created'").get().total,1);
  database.prepare("INSERT INTO rail_graph_versions(version_id,source,checksum,status,station_count,segment_count,imported_stations,imported_segments,created_at,activated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("graph-v1","OpenStreetMap","checksum","active",4314,13444,4314,13444,now,now);
  database.prepare("INSERT INTO rail_graph_import_state(version_id,next_station_chunk,next_segment_chunk,last_attempt_at,finished_at) VALUES(?,?,?,?,?)").run("graph-v1",35,108,now,now);
  const graphResponse=await handleIntelligencePlatformRequest(new Request("https://example.test/api/restricted/rail-intelligence"),{DB:new D1Adapter(database)},{permissions:["*"]},(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}}));
  assert.equal(graphResponse.status,200); const graphBody=await graphResponse.json(); assert.equal(graphBody.graphReference.versionId,"graph-v1"); assert.equal(graphBody.graphReference.status,"active"); assert.equal(graphBody.graphReference.stations,4314);
  database.close();
});
