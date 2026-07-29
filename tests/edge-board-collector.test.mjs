import test from "node:test";
import assert from "node:assert/strict";
import { collectOfficialBoardEdge } from "../backend/src/edge-board-collector.js";

function environment(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
  return {
    BOARD_EDGE_MODE: "enabled",
    SNAPSHOT: {
      async get(key, type) {
        const value = values.get(key) || null;
        return type === "json" && value ? JSON.parse(value) : value;
      },
      async put(key, value) { values.set(key, value); },
    },
    values,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cf-ray": "test-ray" } });
}

test("edge collector uses one stable session and publishes a station fact", async () => {
  const env = environment();
  const sessions = [];
  const fetchImpl = async (url, options) => {
    sessions.push(options.headers["x-session-id"]);
    if (String(url).endsWith("station-boards")) return jsonResponse([{ id: 2200001, name: "\u041a\u0438\u0457\u0432-\u041f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439" }]);
    return jsonResponse({
      station: { name: "\u041a\u0438\u0457\u0432-\u041f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439" },
      departures: [{ train: "091", route: "\u041a\u0438\u0457\u0432 \u2192 \u041b\u044c\u0432\u0456\u0432", time: Date.parse("2026-07-29T12:20:00Z") / 1000, delay_minutes: 12, platform: 3 }],
      arrivals: [],
    });
  };
  const result = await collectOfficialBoardEdge(env, { now: "2026-07-29T12:00:00Z", fetchImpl });
  assert.equal(result.status, "online");
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].reportedStation, "\u041a\u0438\u0457\u0432-\u041f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439");
  assert.equal(result.updates[0].positionEvidence, "station-board-window");
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0], sessions[1]);
  assert.equal(JSON.parse(env.values.get("collector:heartbeat")).status, "healthy");
});

test("canary performs only one upstream attempt across scheduled cycles", async () => {
  const env = environment();
  env.BOARD_EDGE_MODE = "canary";
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return String(url).endsWith("station-boards")
      ? jsonResponse([{ id: 1, name: "\u041b\u044c\u0432\u0456\u0432" }])
      : jsonResponse({ station: { name: "\u041b\u044c\u0432\u0456\u0432" }, departures: [], arrivals: [] });
  };
  const first = await collectOfficialBoardEdge(env, { now: "2026-07-29T12:00:00Z", fetchImpl });
  const second = await collectOfficialBoardEdge(env, { now: "2026-07-29T12:05:00Z", fetchImpl });
  assert.equal(first.status, "online");
  assert.equal(second.status, "skipped");
  assert.equal(calls, 2);
});

test("edge collector persists cooldown and degraded heartbeat after throttling", async () => {
  const env = environment();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return String(url).endsWith("station-boards")
      ? jsonResponse([{ id: 1, name: "\u041b\u044c\u0432\u0456\u0432" }])
      : jsonResponse({ error: "rate limited" }, 441);
  };
  const first = await collectOfficialBoardEdge(env, { now: "2026-07-29T12:00:00Z", fetchImpl });
  const second = await collectOfficialBoardEdge(env, { now: "2026-07-29T12:05:00Z", fetchImpl });
  const state = JSON.parse(env.values.get("collector:board-edge-state"));
  assert.equal(first.status, "degraded");
  assert.equal(second.status, "cooldown");
  assert.equal(calls, 2);
  assert.equal(state.cooldownUntil, "2026-07-29T12:10:00.000Z");
  assert.equal(JSON.parse(env.values.get("collector:heartbeat")).status, "degraded");
});

test("edge collector follows adaptive Rail Intelligence station priority", async () => {
  const env=environment({"intelligence:board-priorities:v1":{stations:[{stationName:"Priority Junction",priorityScore:90,reasons:["silent run"]}]}});
  const requested=[];
  const fetchImpl=async (url)=>{
    requested.push(String(url));
    if(String(url).endsWith("station-boards"))return jsonResponse([{id:1,name:"Routine Junction"},{id:2,name:"Priority Junction"}]);
    return jsonResponse({station:{name:String(url).endsWith("/2")?"Priority Junction":"Routine Junction"},departures:[],arrivals:[]});
  };
  const result=await collectOfficialBoardEdge(env,{now:"2026-07-29T12:00:00Z",fetchImpl});
  assert.equal(result.station.name,"Priority Junction");
  assert.ok(requested[1].endsWith("/2"));
  assert.equal(result.diagnostics.scheduler.strategy,"information-gain-edge-v2");
});
