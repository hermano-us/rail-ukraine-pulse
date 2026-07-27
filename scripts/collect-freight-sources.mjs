import { readFile } from "node:fs/promises";
import { collectFreightTelegram } from "./source-adapters/freight-telegram.mjs";

const apiUrl = String(process.env.RAIL_API_URL || "").replace(/\/$/, ""); const token = process.env.RAIL_INGEST_TOKEN;
if (!apiUrl || !token) throw new Error("RAIL_API_URL and RAIL_INGEST_TOKEN are required");
const registry = JSON.parse(await readFile(new URL("../data/freight-telegram-sources.json", import.meta.url), "utf8")); const observations = []; const sources = [];
for (const source of registry.sources) {
  if (!source.enabled || source.access !== "public-preview") { sources.push({ sourceId: source.id, status: source.access === "requires-membership" ? "requires_membership" : "disabled", checkedAt: new Date().toISOString() }); continue; }
  try {
    const result = await collectFreightTelegram(source); observations.push(...result.observations); sources.push({ sourceId: source.id, status: result.status, checkedAt: result.checkedAt, previewMessages: result.previewMessages, acceptedObservations: result.observations.length, restricted: result.restricted, rejected: result.rejected });
  } catch (error) { sources.push({ sourceId: source.id, status: "unavailable", checkedAt: new Date().toISOString(), error: String(error?.message || error) }); }
}
const response = await fetch(`${apiUrl}/api/v1/freight/ingest`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ observations, sources }) });
if (!response.ok) throw new Error(`freight ingest HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
console.log(JSON.stringify({ ...(await response.json()), sources: sources.length, online: sources.filter((item) => item.status === "online").length, unavailable: sources.filter((item) => item.status === "unavailable").length }));
