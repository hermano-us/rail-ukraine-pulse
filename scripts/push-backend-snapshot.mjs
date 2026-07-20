import { readFile } from "node:fs/promises";

const endpoint = String(process.env.RAIL_API_URL || "").replace(/\/$/, "");
const token = String(process.env.RAIL_INGEST_TOKEN || "");

if (!endpoint || !token) {
  console.log("Live backend is not configured; GitHub Pages snapshot remains the active transport.");
  process.exit(0);
}

const payload = JSON.parse(await readFile(new URL("../data/live.json", import.meta.url), "utf8"));
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

try {
  const response = await fetch(`${endpoint}/api/v1/ingest`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "RailUkrainePulse-GitHub-Collector/1.0",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Live backend HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result = await response.json();
  console.log(`Live backend accepted ${result.accepted} events for ${result.runs} runs.`);
} finally {
  clearTimeout(timeout);
}

