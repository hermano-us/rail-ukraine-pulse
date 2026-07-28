import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { runIntelligenceCycle } from "../backend/src/intelligence/service.js";

class Statement {
  constructor(database, sql) { this.database=database; this.sql=sql; this.values=[]; }
  bind(...values) { this.values=values; return this; }
  all() { return { results:this.database.prepare(this.sql).all(...this.values) }; }
  first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  run() { return this.database.prepare(this.sql).run(...this.values); }
}

class D1Adapter {
  constructor(database) { this.database=database; }
  prepare(sql) { return new Statement(this.database,sql); }
  async batch(statements) { return statements.map((statement)=>statement.run()); }
}

test("autonomous intelligence cycle persists graph, twin, operations and analytics", async () => {
  const database=new DatabaseSync(":memory:");
  for(const file of ["0001_initial.sql","0004_model_observability.sql","0011_intelligence_platform.sql","0013_rail_intelligence_v2.sql","0014_rail_graph_registry.sql"]){
    database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));
  }
  const now=new Date(),observedAt=new Date(now.getTime()-5*60_000).toISOString(),nowIso=now.toISOString();
  database.prepare(`INSERT INTO runs(run_id,train_number,service_date,route,origin,destination,current_update_json,first_observed_at,last_observed_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("run-1","091","2026-07-27","Kyiv - Lviv","Kyiv","Lviv",JSON.stringify({delayMinutes:90,reportedStation:"Kyiv",confidence:.8}),observedAt,observedAt);
  database.prepare(`INSERT INTO events(event_id,run_id,event_type,station,occurred_at,observed_at,source_id,authority,reliability,position_evidence,raw_update_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("event-1","run-1","station_report","Kyiv",observedAt,observedAt,"test-source","public",.9,"station",JSON.stringify({lat:50.45,lon:30.52}));
  database.prepare(`INSERT INTO segment_stats(from_station_id,to_station_id,train_family,sample_count,mean_minutes,variance_minutes,p10_minutes,p50_minutes,p90_minutes,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("kyiv","lviv","091",20,300,100,270,300,345,observedAt);
  database.prepare("UPDATE international_corridors SET border_nodes_json='[\"kyiv\"]' WHERE corridor_id='ua-pl'").run();

  const result=await runIntelligenceCycle({DB:new D1Adapter(database)},nowIso);
  assert.equal(result.status,"success");
  assert.equal(database.prepare("SELECT COUNT(*) total FROM rail_nodes").get().total,2);
  assert.equal(database.prepare("SELECT COUNT(*) total FROM rail_edges").get().total,1);
  assert.equal(database.prepare("SELECT COUNT(*) total FROM rail_observations").get().total,1);
  assert.equal(database.prepare("SELECT COUNT(*) total FROM twin_predictions WHERE status='pending'").get().total,1);
  assert.equal(database.prepare("SELECT COUNT(*) total FROM twin_states").get().total,1);
  assert.equal(database.prepare("SELECT COUNT(*) total FROM twin_hypotheses WHERE status='active'").get().total,1);
  assert.equal(database.prepare("SELECT method FROM twin_states WHERE run_id='run-1'").get().method,"station-graph-probabilistic-twin-v2");
  const movement=database.prepare("SELECT * FROM ops_movements WHERE run_id='run-1'").get();
  assert.equal(movement.status,"delayed");
  assert.ok(movement.eta);
  assert.equal(movement.position_status,"estimated");
  assert.equal(database.prepare("SELECT COUNT(*) total FROM ops_notifications").get().total,1);
  const corridor=database.prepare("SELECT * FROM international_corridors WHERE corridor_id='ua-pl'").get();
  assert.equal(corridor.status,"monitored");
  assert.ok(corridor.activity_score>0);
  const cycle=database.prepare("SELECT * FROM intelligence_cycles WHERE cycle_id=?").get(result.cycleId);
  assert.equal(cycle.status,"success");
  assert.equal(cycle.observations_added,1);
  database.close();
});

test("historical station pairs warm calibration while stale positions lose coordinates", async () => {
  const database=new DatabaseSync(":memory:");
  for(const file of ["0001_initial.sql","0004_model_observability.sql","0011_intelligence_platform.sql","0013_rail_intelligence_v2.sql","0014_rail_graph_registry.sql"]){database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));}
  const now=new Date(),firstAt=new Date(now.getTime()-6*60*60_000).toISOString(),lastAt=new Date(now.getTime()-5*60*60_000).toISOString(),nowIso=now.toISOString();
  database.prepare(`INSERT INTO runs(run_id,train_number,service_date,route,origin,destination,current_update_json,first_observed_at,last_observed_at) VALUES(?,?,?,?,?,?,?,?,?)`).run("run-replay","2417","2026-07-27","Kyiv - Fastiv","Kyiv","Fastiv",JSON.stringify({latitude:50.45,longitude:30.52,confidence:.9,reportedStation:"Fastiv"}),firstAt,lastAt);
  const event=database.prepare(`INSERT INTO events(event_id,run_id,event_type,station,occurred_at,observed_at,source_id,authority,reliability,position_evidence,raw_update_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  event.run("replay-a","run-replay","station_report","Kyiv",firstAt,firstAt,"test-source","public",.9,"station","{}");
  event.run("replay-b","run-replay","station_report","Fastiv",lastAt,lastAt,"test-source","public",.9,"station","{}");
  database.prepare(`INSERT INTO segment_stats(from_station_id,to_station_id,train_family,sample_count,mean_minutes,variance_minutes,p10_minutes,p50_minutes,p90_minutes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run("kyiv","fastiv","2417",24,58,25,50,60,70,lastAt);
  const result=await runIntelligenceCycle({DB:new D1Adapter(database)},nowIso);
  assert.ok(result.replayed>=1); const evaluation=database.prepare("SELECT * FROM model_evaluations WHERE evaluation_id LIKE 'replay:%'").get(); assert.ok(evaluation); assert.equal(evaluation.absolute_error_minutes,0); assert.equal(evaluation.within_p80,1);
  const movement=database.prepare("SELECT * FROM ops_movements WHERE run_id='run-replay'").get(); assert.equal(movement.position_status,"unknown"); assert.equal(movement.latitude,null); assert.equal(movement.longitude,null); assert.ok(JSON.parse(movement.metadata_json).uncertaintyKm>100);
  database.close();
});
