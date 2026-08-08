import { readFile } from "node:fs/promises";
import { collectFreightTelegram } from "./source-adapters/freight-telegram.mjs";

const apiUrl = String(process.env.RAIL_API_URL || "").replace(/\/$/, ""); const token = process.env.RAIL_INGEST_TOKEN;
const CHUNK_SIZE = 30; const MAX_ATTEMPTS = 4;
if (!apiUrl || !token) throw new Error("RAIL_API_URL and RAIL_INGEST_TOKEN are required");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function ingest(payload) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/api/v1/freight/ingest`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (response.ok) return response.json();
      lastError = new Error(`freight ingest HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === MAX_ATTEMPTS) break;
    } catch (error) {
      lastError = new Error(`freight ingest network failure: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt === MAX_ATTEMPTS) break;
    }
    await wait(Math.min(8_000, 750 * 2 ** (attempt - 1)));
  }
  throw lastError;
}
const registry = JSON.parse(await readFile(new URL("../data/freight-telegram-sources.json", import.meta.url), "utf8")); const observations = []; const sources = [];
for (const source of registry.sources) {
  if (!source.enabled || source.access !== "public-preview") { sources.push({ sourceId: source.id, status: source.access === "requires-membership" ? "requires_membership" : "disabled", checkedAt: new Date().toISOString() }); continue; }
  try {
    const result = await collectFreightTelegram(source); observations.push(...result.observations); sources.push({ sourceId: source.id, status: result.status, checkedAt: result.checkedAt, previewMessages: result.previewMessages, acceptedObservations: result.observations.length, restricted: result.restricted, rejected: result.rejected });
  } catch (error) { sources.push({ sourceId: source.id, status: "unavailable", checkedAt: new Date().toISOString(), error: String(error?.message || error) }); }
}
let accepted = 0;
for (let index = 0; index < observations.length; index += CHUNK_SIZE) {
  const result = await ingest({ observations: observations.slice(index, index + CHUNK_SIZE), sources: [] }); accepted += Number(result.accepted || 0);
}
await ingest({ observations: [], sources });
console.log(JSON.stringify({ received: observations.length, accepted, chunks: Math.ceil(observations.length / CHUNK_SIZE), sources: sources.length, online: sources.filter((item) => item.status === "online").length, unavailable: sources.filter((item) => item.status === "unavailable").length }));
