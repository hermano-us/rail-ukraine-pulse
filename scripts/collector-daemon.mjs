import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const intervalMs = Math.max(60_000, Number(process.env.COLLECTOR_INTERVAL_MS) || 180_000);
const port = Math.max(1, Number(process.env.COLLECTOR_HEALTH_PORT) || 8080);
const attempts = Math.min(5, Math.max(1, Number(process.env.COLLECTOR_ATTEMPTS) || 3));
const scriptTimeoutMs = Math.max(60_000, Number(process.env.COLLECTOR_SCRIPT_TIMEOUT_MS) || 480_000);
const staleAfterMs = Math.max(15 * 60_000, intervalMs * 3);
const apiEndpoint = String(process.env.RAIL_API_URL || "").replace(/\/$/, "");
const ingestToken = String(process.env.RAIL_INGEST_TOKEN || "");
const collectorId = String(process.env.COLLECTOR_ID || "trusted-collector");
let timer;
let stopping = false;
const state = {
  status: "starting",
  startedAt: new Date().toISOString(),
  lastStartedAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  nextRunAt: null,
  runs: 0,
  consecutiveFailures: 0,
  attemptsLastCycle: 0,
  lastHeartbeatAt: null,
  lastHeartbeatError: null,
  lastPriorityCount: 0,
  lastPriorityError: null,
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function runScript(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: "inherit", env: { ...process.env, ...extraEnv } });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${script} timed out after ${scriptTimeoutMs}ms`));
    }, scriptTimeoutMs);
    child.once("error", finish);
    child.once("exit", (code, signal) => code === 0 ? finish() : finish(new Error(`${script} exited with ${signal || code}`)));
  });
}

async function loadBoardPriorities(){
  if(!apiEndpoint||ingestToken.length<24)return [];
  const response=await fetch(`${apiEndpoint}/api/v1/collector/board-priorities`,{headers:{Authorization:`Bearer ${ingestToken}`,Accept:"application/json"},signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error(`collector priorities HTTP ${response.status}`);
  const payload=await response.json();return Array.isArray(payload?.stations)?payload.stations:[];
}
async function runCycle() {
  const priorities=await loadBoardPriorities().catch((error)=>{state.lastPriorityError=String(error?.message||error).slice(0,300);return [];});
  state.lastPriorityCount=priorities.length;if(priorities.length)state.lastPriorityError=null;
  await runScript("scripts/update-transport-data.mjs", { BOARD_HEADLESS: process.env.BOARD_HEADLESS || "true", BOARD_COVERAGE_PRIORITIES_JSON:JSON.stringify(priorities) });
  await runScript("scripts/push-backend-snapshot.mjs");
}
async function sendHeartbeat() {
  if (!apiEndpoint || ingestToken.length < 24) return;
  let board = null;
  try {
    const runtime = JSON.parse(await readFile(new URL("../data/source-runtime.json", import.meta.url), "utf8"));
    board = runtime?.sources?.["uz-public-board"] || null;
  } catch {}
  const response = await fetch(`${apiEndpoint}/api/v1/collector/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ingestToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      collectorId,
      status: state.status,
      version: "trusted-collector-v1",
      lastStartedAt: state.lastStartedAt,
      lastSucceededAt: state.lastSucceededAt,
      consecutiveFailures: state.consecutiveFailures,
      runs: state.runs,
      recordsCount: Number(board?.coverage?.records || 0),
      board: board?.scheduler ? {
        selectedStation: board.scheduler.selectedStation,
        strategy: board.scheduler.strategy,
        requestBudget: board.scheduler.requestBudget,
      } : null,
    }),
  });
  if (!response.ok) throw new Error(`collector heartbeat HTTP ${response.status}`);
  state.lastHeartbeatAt = new Date().toISOString();
  state.lastHeartbeatError = null;
}

async function collect() {
  state.status = "collecting";
  state.lastStartedAt = new Date().toISOString();
  state.nextRunAt = null;
  state.runs += 1;
  let error;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    state.attemptsLastCycle = attempt;
    try {
      await runCycle();
      error = null;
      break;
    } catch (candidate) {
      error = candidate;
      console.error(`Collector attempt ${attempt}/${attempts} failed:`, candidate);
      if (attempt < attempts) await sleep(Math.min(60_000, 5_000 * (2 ** (attempt - 1))));
    }
  }

  if (!error) {
    state.status = "healthy";
    state.lastSucceededAt = new Date().toISOString();
    state.lastError = null;
    state.consecutiveFailures = 0;
  } else {
    state.status = "degraded";
    state.lastFailedAt = new Date().toISOString();
    state.lastError = String(error?.message || error).slice(0, 500);
    state.consecutiveFailures += 1;
  }

  await sendHeartbeat().catch((candidate) => { state.lastHeartbeatError = String(candidate?.message || candidate).slice(0, 300); });

  if (!stopping) {
    state.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    timer = setTimeout(collect, intervalMs);
  }
}

const server = createServer((request, response) => {
  if (!["/health", "/ready"].includes(request.url)) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(`${JSON.stringify({ error: "not_found" })}\n`);
    return;
  }
  const lastSuccess = Date.parse(state.lastSucceededAt || "");
  const stale = !Number.isFinite(lastSuccess) || Date.now() - lastSuccess > staleAfterMs;
  const ready = !stale && state.status !== "degraded";
  response.writeHead(ready ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify({ ...state, ready, stale, intervalMs, attempts, scriptTimeoutMs, staleAfterMs, checkedAt: new Date().toISOString() })}\n`);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Collector health endpoint listening on :${port}`);
  collect();
});

function shutdown() {
  stopping = true;
  clearTimeout(timer);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
