import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDelayTable } from "./update-ukraine-data.mjs";
import { fetchText } from "./source-adapters/html.mjs";
import { collectOfficialBoard } from "./source-adapters/official-board.mjs";
import { checkReferences } from "./source-adapters/references.mjs";
import { collectTelegram, rehydrateTelegramPosts, telegramUpdates } from "./source-adapters/telegram.mjs";

const DELAY_URL = "https://uz-vezemo.uz.gov.ua/delayform/";
const liveTarget = resolve("data/live.json");
const runtimeTarget = resolve("data/source-runtime.json");

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function staleStatus(previous, error, label) {
  return {
    status: previous ? "stale" : "unavailable", checkedAt: new Date().toISOString(),
    label: previous ? `${label}: последний снимок` : `${label}: недоступен`,
    error: String(error?.message || error || "unknown error").slice(0, 500),
  };
}

async function collectDelay(previousUpdates = []) {
  const checkedAt = new Date().toISOString();
  try {
    const updates = parseDelayTable(await fetchText(DELAY_URL));
    if (!updates.length) throw new Error("Delay table returned no parseable trains");
    return {
      status: { status: "online", checkedAt, label: `Задержки УЗ: ${updates.length} поездов`, capabilities: ["movement-status", "delay", "forecast"] },
      updates,
    };
  } catch (error) {
    const updates = previousUpdates.filter((item) => item.sourceId === "uz-delay-dashboard");
    return { status: staleStatus(updates.length, error, "Задержки УЗ"), updates };
  }
}

function normalizeRoute(value = "") {
  return value.toLocaleLowerCase("uk").replace(/\s+/g, " ").replace(/[—–]/g, "-").trim();
}

function mergeUpdates(groups) {
  const priority = { "uz-public-board": 1, "uz-suburban-telegram": 2, "uz-delay-dashboard": 3 };
  const result = new Map();
  for (const update of groups.flat().filter(Boolean)) {
    if (!update.trainNumber) continue;
    const key = `${update.trainNumber}:${normalizeRoute(update.route)}`;
    const existing = result.get(key);
    if (!existing || (priority[update.sourceId] || 0) >= (priority[existing.sourceId] || 0)) result.set(key, update);
  }
  return [...result.values()].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
}

async function main() {
  const previousLive = await readJson(liveTarget, { updates: [] });
  const previousRuntime = await readJson(runtimeTarget, { sources: {} });
  const delayPromise = collectDelay(previousLive.updates || []);
  const telegramPromise = collectTelegram().catch((error) => {
    const posts = rehydrateTelegramPosts(previousRuntime.sources?.["uz-suburban-telegram"]?.posts || []);
    return {
      status: staleStatus(posts.length, error, "УЗ Пригород"),
      posts, updates: telegramUpdates(posts),
    };
  });
  const boardPromise = process.env.SKIP_BROWSER_SOURCE === "1"
    ? Promise.resolve({ status: { status: "unavailable", checkedAt: new Date().toISOString(), label: "Табло УЗ: browser-adapter отключён" }, records: [], updates: [] })
    : collectOfficialBoard().catch((error) => ({
      status: staleStatus(previousRuntime.sources?.["uz-public-board"]?.records?.length, error, "Табло УЗ"),
      records: previousRuntime.sources?.["uz-public-board"]?.records || [], failures: [], updates: [],
    }));
  const referencePromise = checkReferences();

  const [delay, telegram, board, references] = await Promise.all([delayPromise, telegramPromise, boardPromise, referencePromise]);
  const referenceRuntime = Object.fromEntries(references.map((item) => [item.id, item]));
  const sources = {
    "uz-delay-dashboard": delay,
    "uz-public-board": board,
    "uz-suburban-telegram": telegram,
    ...referenceRuntime,
  };
  const updates = mergeUpdates([board.updates || [], telegram.updates || [], delay.updates || []]);
  const onlineCount = Object.values(sources).filter((source) => ["online", "snapshot"].includes(source.status?.status || source.status)).length;
  const checkedAt = new Date().toISOString();
  const anyFreshOperational = [delay, telegram, board].some((source) => source.status.status === "online");
  const generatedAt = anyFreshOperational ? checkedAt : (previousLive.generatedAt || checkedAt);
  const sourceStatus = {
    sourceId: "uz-public-fusion", status: anyFreshOperational ? "online" : updates.length ? "stale" : "unavailable",
    label: `UZ fusion: ${updates.length} событий · ${onlineCount}/5 источников доступны`, checkedAt,
    capabilities: { officialStatus: true, forecast: true, stationPassage: true, gps: false, scope: "public-passenger-and-commuter-events" },
  };
  await atomicJson(runtimeTarget, { schemaVersion: 1, generatedAt: checkedAt, sources });
  await atomicJson(liveTarget, { schemaVersion: 5, provider: "Ukrzaliznytsia public source fusion", generatedAt, sourceStatus, updates });
  console.log(`${sourceStatus.label}; board ${board.status.status}, Telegram ${telegram.status.status}, delays ${delay.status.status}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
