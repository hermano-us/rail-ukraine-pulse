import { createServer } from "node:http";
import { spawn } from "node:child_process";

const intervalMs = Math.max(60_000, Number(process.env.COLLECTOR_INTERVAL_MS) || 180_000);
const port = Math.max(1, Number(process.env.COLLECTOR_HEALTH_PORT) || 8080);
let timer;
let stopping = false;
const state = { status: "starting", startedAt: new Date().toISOString(), lastStartedAt: null, lastSucceededAt: null, lastFailedAt: null, lastError: null, runs: 0 };

function runScript(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: "inherit", env: { ...process.env, ...extraEnv } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(script + " exited with " + (signal || code))));
  });
}

async function collect() {
  state.status = "collecting";
  state.lastStartedAt = new Date().toISOString();
  state.runs += 1;
  try {
    await runScript("scripts/update-transport-data.mjs", { BOARD_HEADLESS: process.env.BOARD_HEADLESS || "true" });
    await runScript("scripts/push-backend-snapshot.mjs");
    state.status = "healthy";
    state.lastSucceededAt = new Date().toISOString();
    state.lastError = null;
  } catch (error) {
    state.status = "degraded";
    state.lastFailedAt = new Date().toISOString();
    state.lastError = String(error?.message || error).slice(0, 500);
    console.error("Collector cycle failed:", error);
  } finally {
    if (!stopping) timer = setTimeout(collect, intervalMs);
  }
}

const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }) + String.fromCharCode(10));
    return;
  }
  const healthy = state.status !== "degraded" || state.lastSucceededAt;
  response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ ...state, intervalMs, checkedAt: new Date().toISOString() }) + String.fromCharCode(10));
});
server.listen(port, "0.0.0.0", () => {
  console.log("Collector health endpoint listening on :" + port);
  collect();
});
function shutdown() {
  stopping = true;
  clearTimeout(timer);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);