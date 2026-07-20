import { createServer } from "node:http";
import { spawn } from "node:child_process";

const intervalMs = Math.max(60_000, Number(process.env.COLLECTOR_INTERVAL_MS) || 180_000);
const port = Math.max(1, Number(process.env.COLLECTOR_HEALTH_PORT) || 8080);
const attempts = Math.min(5, Math.max(1, Number(process.env.COLLECTOR_ATTEMPTS) || 3));
const scriptTimeoutMs = Math.max(60_000, Number(process.env.COLLECTOR_SCRIPT_TIMEOUT_MS) || 480_000);
const staleAfterMs = Math.max(15 * 60_000, intervalMs * 3);
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

async function runCycle() {
  await runScript("scripts/update-transport-data.mjs", { BOARD_HEADLESS: process.env.BOARD_HEADLESS || "true" });
  await runScript("scripts/push-backend-snapshot.mjs");
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
