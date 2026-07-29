import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { BOARD_API_BASE, BOARD_API_USER_AGENT, selectApiStations } from "./source-adapters/official-board-api.mjs";

const values = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "true"];
}));
const maxRequests = Math.max(1, Math.min(6, Number(values.get("max")) || 1));
const intervalMs = maxRequests > 1 ? Math.max(60_000, Number(values.get("interval-ms")) || 180_000) : 0;
const sessionMode = values.get("session") === "fresh" ? "fresh" : "stable";
const requestedStations = String(values.get("stations") || "").split(",").map((item) => item.trim()).filter(Boolean);
const sessionId = randomUUID();

function headers(currentSession) {
  return {
    Accept: "application/json",
    "x-client-locale": "uk",
    "x-session-id": currentSession,
    "x-user-agent": BOARD_API_USER_AGENT,
  };
}

async function request(label, url, currentSession) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: headers(currentSession), signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    const result = {
      checkedAt: new Date().toISOString(), label, status: response.status, durationMs: Date.now() - started,
      contentType: response.headers.get("content-type"), retryAfter: response.headers.get("retry-after"),
      cfRay: response.headers.get("cf-ray"), bytes: text.length,
    };
    console.log(JSON.stringify(result));
    return { ...result, text };
  } catch (error) {
    const result = { checkedAt: new Date().toISOString(), label, status: 0, durationMs: Date.now() - started, error: String(error?.cause?.message || error?.message || error).slice(0, 300) };
    console.log(JSON.stringify(result));
    return result;
  }
}

const catalogResult = await request("catalog", BOARD_API_BASE, sessionId);
if (catalogResult.status !== 200 || !String(catalogResult.contentType).includes("application/json")) process.exit(1);
const catalog = JSON.parse(catalogResult.text);
const selected = selectApiStations(catalog, requestedStations.length ? requestedStations : null).slice(0, maxRequests);
console.log(JSON.stringify({ mode: sessionMode, maxRequests, intervalMs, catalogStations: catalog.length, selected: selected.map(({ id, name }) => ({ id, name })) }));
for (let index = 0; index < selected.length; index += 1) {
  if (index > 0) await wait(intervalMs);
  const station = selected[index];
  const result = await request(`station:${station.name}`, `${BOARD_API_BASE}/${encodeURIComponent(station.id)}`, sessionMode === "fresh" ? randomUUID() : sessionId);
  if ([429, 441].includes(result.status) || result.status === 0) break;
}
