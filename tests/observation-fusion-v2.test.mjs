import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { classifyExpectedRun, normalizeExpectedRun, ingestExpectedRuns, refreshExpectedRunCoverage } from "../backend/src/intelligence/expected-registry.js";
import { fuseObservationRows } from "../backend/src/intelligence/observation-fusion-v2.js";
import { buildExpectedRuns } from "../scripts/source-adapters/expected-registry.mjs";
import { collectInternationalRailSources } from "../scripts/source-adapters/international-rail.mjs";
import { handlePublicObservationRequest, reviewObservationSubmission } from "../backend/src/intelligence/observation-submissions.js";

test("expected registry preserves planned and silent passenger runs", () => {
  const now="2026-07-28T12:00:00.000Z";
  const planned=normalizeExpectedRun({trainNumber:"91",serviceDate:"2026-07-28",route:"Kyiv — Lviv",scheduledDeparture:"2026-07-28T14:00:00Z"},now);
  assert.equal(classifyExpectedRun({...planned,service_date:planned.serviceDate,scheduled_departure:planned.scheduledDeparture},now).status,"planned");
  assert.equal(classifyExpectedRun({service_date:"2026-07-28",scheduled_departure:"2026-07-28T08:00:00Z",last_observation_at:null},now).status,"unobserved");
});

test("expected registry preserves explicit station presence and completion", () => {
  const now = "2026-07-28T12:00:00.000Z";
  const base = {
    service_date: "2026-07-28",
    scheduled_departure: "2026-07-28T08:00:00Z",
    last_observation_at: "2026-07-28T11:55:00Z",
  };
  assert.equal(classifyExpectedRun({ ...base, last_operational_status: "station", last_board_type: "departure" }, now).status, "at_station");
  assert.equal(classifyExpectedRun({ ...base, last_operational_status: "completed" }, now).status, "completed");
  assert.equal(classifyExpectedRun({ ...base, last_operational_status: "planned", last_board_type: "departure" }, now).status, "active");
});
test("observation fusion collapses corroborating station facts without inventing coordinates", () => {
  const groups=fuseObservationRows([
    {event_id:"a",train_number:"91",station:"Lviv",occurred_at:"2026-07-28T10:00:00Z",source_id:"board",authority:"official",reliability:.8},
    {event_id:"b",train_number:"91",station:"Lviv",occurred_at:"2026-07-28T10:06:00Z",source_id:"telegram",authority:"reference",reliability:.6},
  ]);
  assert.equal(groups.length,1);
  assert.equal(groups[0].sourceIds.length,2);
  assert.ok(groups[0].effectiveReliability>.8);
  assert.equal(groups[0].latitude,undefined);
});

test("daily registry is built from every collected passenger update", () => {
  const runs=buildExpectedRuns([{trainNumber:"91",route:"Kyiv — Lviv",origin:"Kyiv",destination:"Lviv",sourceId:"uz-public-board",updatedAt:"2026-07-28T09:00:00Z"}],[],"2026-07-28T09:00:00Z");
  assert.equal(runs.length,1);
  assert.equal(runs[0].trainNumber,"91");
  assert.deepEqual(runs[0].sourceIds,["uz-public-board"]);
});

test("external adapters remain inert until authorized endpoints are configured", async () => {
  const result=await collectInternationalRailSources({});

  assert.equal(result.updates.length,0);
  assert.equal(Object.keys(result.sources).length,5);
  assert.equal(result.sources["pkp-plk-realtime"].status.status,"requires_configuration");
});

test("daily registry preserves station calls and endpoint schedule boundaries", () => {
  const update = { trainNumber: "91", route: "Kyiv — Lviv", origin: "Kyiv", destination: "Lviv", sourceId: "uz-public-board", updatedAt: "2026-07-28T06:00:00Z" };
  const records = [
    { trainNumber: "91", route: "Kyiv — Lviv", station: "Kyiv", boardType: "departure", scheduledTime: "09:30", observedAt: "2026-07-28T06:00:00Z" },
    { trainNumber: "91", route: "Kyiv — Lviv", station: "Korosten", boardType: "arrival", scheduledTime: "11:15", observedAt: "2026-07-28T06:00:00Z" },
    { trainNumber: "91", route: "Kyiv — Lviv", station: "Lviv", boardType: "arrival", scheduledTime: "16:20", observedAt: "2026-07-28T06:00:00Z" },
  ];
  const [run] = buildExpectedRuns([update], records, "2026-07-28T06:00:00Z");
  assert.equal(run.metadata.stationCalls.length, 3);
  assert.equal(run.metadata.boardObservationCount, 3);
  assert.equal(run.scheduledDeparture, "2026-07-28T09:30:00+03:00");
  assert.equal(run.scheduledArrival, "2026-07-28T16:20:00+03:00");
});
test("board-only trains remain in the complete daily registry", () => {
  const runs=buildExpectedRuns([], [{trainNumber:"701",route:"Kyiv — Lviv",station:"Kyiv",boardType:"departure",scheduledTime:"09:30",observedAt:"2026-07-28T06:00:00Z",sourceId:"uz-public-board"}], "2026-07-28T06:00:00Z");
  assert.equal(runs.length,1);
  assert.equal(runs[0].trainNumber,"701");
  assert.equal(runs[0].sourceIds[0],"uz-public-board");
  assert.equal(runs[0].metadata.stationCalls.length,1);
});

class Statement { constructor(database,sql){this.database=database;this.sql=sql;this.values=[];} bind(...values){this.values=values;return this;} all(){return {results:this.database.prepare(this.sql).all(...this.values)};} first(){return this.database.prepare(this.sql).get(...this.values)||null;} run(){return this.database.prepare(this.sql).run(...this.values);} }
class DB { constructor(database){this.database=database;} prepare(sql){return new Statement(this.database,sql);} async batch(statements){return statements.map(item=>item.run());} }

const addRegistryV4Columns=(database)=>database.exec("ALTER TABLE expected_train_runs ADD COLUMN operational_status TEXT NOT NULL DEFAULT 'planned'; ALTER TABLE expected_train_runs ADD COLUMN operational_reason TEXT; ALTER TABLE expected_train_runs ADD COLUMN state_changed_at TEXT;");
test("passenger witness facts require moderation before becoming events", async () => {
  const database=new DatabaseSync(":memory:");
  for(const file of ["0001_initial.sql","0011_intelligence_platform.sql","0018_observation_fusion_v2.sql"])database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));
  const now=new Date().toISOString(),date=now.slice(0,10);database.prepare("INSERT INTO expected_train_runs(expected_id,run_id,service_date,train_number,status,source_ids_json,first_seen_at,updated_at) VALUES(?,?,?,?,?,'[]',?,?)").run("expected:91","run:91",date,"91","active",now,now);
  const env={DB:new DB(database)},respond=(value,status=200)=>({value,status});
  const submitted=await handlePublicObservationRequest(new Request("https://example.test/api/v1/rail-observations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedId:"expected:91",station:"Lviv",observedAt:now})}),env,respond);
  assert.equal(submitted.status,202);assert.equal(database.prepare("SELECT COUNT(*) total FROM events").get().total,0);
  const reviewed=await reviewObservationSubmission(env,{id:"operator-1"},{submissionId:submitted.value.submissionId,decision:"approve"});
  assert.equal(reviewed.ok,true);assert.equal(database.prepare("SELECT COUNT(*) total FROM events WHERE source_id='passenger-witness'").get().total,1);database.close();
});
test("silent expected runs remain visible and open one idempotent coverage workflow", async () => {
  const database=new DatabaseSync(":memory:");for(const file of ["0001_initial.sql","0011_intelligence_platform.sql","0015_rail_intelligence_routing.sql","0018_observation_fusion_v2.sql"])database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));addRegistryV4Columns(database);const env={DB:new DB(database)},now="2026-07-28T12:00:00.000Z";
  await ingestExpectedRuns(env,[{expectedId:"expected:silent",runId:"run:silent",trainNumber:"777",serviceDate:"2026-07-28",route:"Kyiv — Lviv",scheduledDeparture:"2026-07-28T08:00:00Z"}],now);await refreshExpectedRunCoverage(env,now);await refreshExpectedRunCoverage(env,now);
  assert.equal(database.prepare("SELECT status FROM expected_train_runs WHERE expected_id='expected:silent'").get().status,"unobserved");assert.equal(database.prepare("SELECT COUNT(*) total FROM rail_coverage_gaps WHERE resolved_at IS NULL").get().total,1);assert.equal(database.prepare("SELECT COUNT(*) total FROM ops_workflows WHERE workflow_type='silent_run'").get().total,1);assert.equal(database.prepare("SELECT status FROM ops_movements WHERE run_id='run:silent'").get().status,"unobserved");database.close();
});
test("canonical observation links activate the matched expected run", async () => {
  const database=new DatabaseSync(":memory:");
  for(const file of ["0001_initial.sql","0011_intelligence_platform.sql","0015_rail_intelligence_routing.sql","0018_observation_fusion_v2.sql"]) database.exec(await readFile(new URL(`../backend/migrations/${file}`,import.meta.url),"utf8"));
  const env={DB:new DB(database)},now="2026-07-28T12:00:00.000Z";
  addRegistryV4Columns(database);
  await ingestExpectedRuns(env,[{expectedId:"expected:canonical",runId:"run:canonical",trainNumber:"91",serviceDate:"2026-07-28",route:"Kyiv — Lviv",scheduledDeparture:"2026-07-28T08:00:00Z"}],now);
  database.prepare("INSERT INTO runs(run_id,train_number,service_date,route,current_update_json,first_observed_at,last_observed_at) VALUES(?,?,?,?,?,?,?)").run("run:source","91","2026-07-28","Kyiv — Lviv","{}","2026-07-28T11:55:00Z","2026-07-28T11:55:00Z");
  database.prepare("INSERT INTO events(event_id,run_id,event_type,event_value_json,station,occurred_at,observed_at,source_id,authority,reliability,position_evidence,raw_update_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("event:station","run:source","station_report","{}","Korosten","2026-07-28T11:55:00Z","2026-07-28T11:56:00Z","uz-public-board","official",.78,"station-board-window","{}");
  database.prepare("INSERT INTO observation_run_links(event_id,original_run_id,canonical_run_id,status,confidence,method,updated_at) VALUES(?,?,?,?,?,?,?)").run("event:station","run:source","run:canonical","linked",.9,"entity-resolution-v2",now);
  await refreshExpectedRunCoverage(env,now);
  const run=database.prepare("SELECT status,observation_count,last_station FROM expected_train_runs WHERE expected_id='expected:canonical'").get();
  assert.equal(run.status,"active");
  assert.equal(run.observation_count,1);
  assert.equal(run.last_station,"Korosten");
  database.close();
});
