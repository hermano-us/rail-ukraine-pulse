import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = "https://uz-vezemo.uz.gov.ua/delayform/";
const target = resolve("data/live.json");

function decodeHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&rarr;|&rightarrow;/gi, "→")
    .replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—").replace(/&amp;/gi, "&").replace(/&#8470;|&numero;/gi, "№")
    .replace(/\s+/g, " ").trim();
}

function delayMinutes(label) {
  const clock = label.match(/\+?\s*(\d{1,2})\s*[:г]\s*(\d{2})/i);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const minutes = label.match(/\+?\s*(\d+)\s*(?:хв|мин)/i);
  return minutes ? Number(minutes[1]) : null;
}

function operationFromStatus(status) {
  const value = status.toLocaleLowerCase("uk");
  if (value.includes("станц") || value.includes("очіку") || value.includes("відправ") || value.includes("готу")) return "station";
  return "moving";
}

export function parseDelayTable(html) {
  const updates = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => decodeHtml(match[1]));
    if (cells.length < 3) continue;
    const numberMatch = cells[0].match(/(?:№\s*)?(\d{1,3}(?:\s*\/\s*\d{1,3})?)/);
    if (!numberMatch) continue;
    const trainNumber = numberMatch[1].replace(/\s/g, "");
    const delayLabel = cells.find((cell) => /^\+?\s*\d+(?::\d{2}|\s*(?:хв|мин))/.test(cell)) || cells[2] || "";
    const status = cells[3] || "В дорозі";
    const route = cells[1] || "";
    const [origin = "", destination = ""] = route.split(/\s*(?:→|—|–)\s*/);
    updates.push({
      trainNumber,
      route,
      origin,
      destination,
      delayMinutes: delayMinutes(delayLabel),
      delayLabel,
      publicStatus: status,
      operationalStatus: operationFromStatus(status),
      forecastDeparture: cells[4] && cells[4] !== "—" ? cells[4] : null,
      forecastArrival: cells[5] && cells[5] !== "—" ? cells[5] : null,
      reliability: cells[6] || "Не указана",
      reason: cells[7] || null,
      updatedAt: new Date().toISOString(),
      source: endpoint,
    });
  }
  return updates;
}

async function previousSnapshot() {
  try { return JSON.parse(await readFile(target, "utf8")); } catch { return null; }
}

async function main() {
  const previous = await previousSnapshot();
  let updates = [];
  let sourceStatus;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    const response = await fetch(endpoint, { signal: controller.signal, headers: { "User-Agent": "RailUkrainePulse/2.0 public-passenger-monitor" } });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    updates = parseDelayTable(await response.text());
    if (!updates.length) throw new Error("Delay table returned no parseable trains");
    sourceStatus = { status:"online", label:`UZ: ${updates.length} обновлений задержек`, endpoint, checkedAt:new Date().toISOString() };
  } catch (error) {
    updates = Array.isArray(previous?.updates) ? previous.updates : [];
    sourceStatus = { status:updates.length?"stale":"unavailable", label:updates.length?"UZ: используется последний снимок":"UZ: источник временно недоступен", endpoint, checkedAt:new Date().toISOString(), error:String(error.message||error) };
  }
  const generatedAt = sourceStatus.status === "online" ? new Date().toISOString() : (previous?.generatedAt || new Date().toISOString());
  const output = { schemaVersion:2, generatedAt, sourceStatus, updates };
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output,null,2)}\n`, "utf8");
  await rename(temporary,target);
  console.log(`${sourceStatus.label}; stored ${updates.length} public updates.`);
}

const isDirectRun = process.argv[1]
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

