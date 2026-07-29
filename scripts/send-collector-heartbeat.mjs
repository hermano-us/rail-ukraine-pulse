import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function buildCollectorHeartbeat(runtime, env = process.env) {
  const board = runtime?.sources?.["uz-public-board"] || {};
  const sourceStatus = board.status || {};
  const online = sourceStatus.status === "online";
  const scheduler = board.scheduler || sourceStatus.scheduler || null;
  const coverage = board.coverage || sourceStatus.coverage || null;
  return {
    collectorId: String(env.COLLECTOR_ID || "github-actions-board"),
    status: online ? "healthy" : "degraded",
    version: "trusted-collector-github-v1",
    lastStartedAt: sourceStatus.checkedAt || runtime?.generatedAt || null,
    lastSucceededAt: sourceStatus.lastSuccessfulAt || (online ? sourceStatus.checkedAt : null),
    consecutiveFailures: online ? 0 : 1,
    runs: Math.max(0, Number(env.COLLECTOR_RUNS) || 0),
    recordsCount: Math.max(0, Number(coverage?.records) || 0),
    board: scheduler ? {
      selectedStation: scheduler.selectedStation || null,
      selectedStationId: scheduler.selectedStationId || scheduler.rankedStations?.[0]?.id || null,
      strategy: scheduler.strategy || null,
      requestBudget: Math.max(0, Number(scheduler.requestBudget) || 0),
    } : null,
  };
}

export async function sendCollectorHeartbeat({ env = process.env, fetchImpl = fetch, runtime } = {}) {
  const api = String(env.RAIL_API_URL || "").replace(/\/$/, "");
  const token = String(env.RAIL_INGEST_TOKEN || "");
  if (!api || token.length < 24) throw new Error("RAIL_API_URL and RAIL_INGEST_TOKEN are required");
  const sourceRuntime = runtime || JSON.parse(await readFile(new URL("../data/source-runtime.json", import.meta.url), "utf8"));
  const payload = buildCollectorHeartbeat(sourceRuntime, env);
  const response = await fetchImpl(`${api}/api/v1/collector/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`collector heartbeat HTTP ${response.status}`);
  return { payload, response: await response.json() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sendCollectorHeartbeat()
    .then(({ payload }) => console.log(`Trusted Collector heartbeat: ${payload.status}, ${payload.recordsCount} board records`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}