import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDelayTable } from "./update-ukraine-data.mjs";
import { fetchText } from "./source-adapters/html.mjs";
import { collectOfficialBoard, recoverOfficialBoard } from "./source-adapters/official-board.mjs";
import { checkReferences } from "./source-adapters/references.mjs";
import { collectTelegram, rehydrateTelegramPosts, telegramUpdates } from "./source-adapters/telegram.mjs";
import { buildExpectedRuns } from "./source-adapters/expected-registry.mjs";
import { collectInternationalRailSources } from "./source-adapters/international-rail.mjs";
import { collectAnyTrain } from "./source-adapters/anytrain.mjs";
import { collectSwRailway } from "./source-adapters/swrailway.mjs";
import { collectPoizdatoStations } from "./source-adapters/poizdato.mjs";
import { collectKoleoCatalog } from "./source-adapters/koleo.mjs";

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

async function loadCoveragePriorities() {
  try {
    const configured = JSON.parse(process.env.BOARD_COVERAGE_PRIORITIES_JSON || "[]");
    if (Array.isArray(configured) && configured.length) return { stations: configured.slice(0, 100), requestBudget: Math.max(1, Number(process.env.BOARD_REQUEST_BUDGET) || 1) };
  } catch {}
  const api = String(process.env.RAIL_API_URL || "").replace(/\/$/, "");
  const token = String(process.env.RAIL_INGEST_TOKEN || "");
  if (!api || token.length < 24) return { stations: [], requestBudget: 1 };
  try {
    const response = await fetch(`${api}/api/v1/collector/board-priorities`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return { stations: (Array.isArray(payload?.stations) ? payload.stations : []).slice(0, 100), requestBudget: Math.max(1, Math.min(6, Number(payload?.recommendedRequestBudget) || 1)) };
  } catch (error) {
    console.warn(`Board priority API unavailable: ${String(error?.message || error).slice(0, 160)}`);
    return { stations: [], requestBudget: 1 };
  }
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
  const priority = {
    "anytrain-uz-delay": 1,
    "uz-delay-dashboard": 2,
    "uz-suburban-telegram": 3,
    "anytrain-uz-station-board": 4,
    "uz-public-board": 5,
  };
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
  const coveragePlan = await loadCoveragePriorities();
  const coveragePriorities = coveragePlan.stations;
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
    : collectOfficialBoard({ previous: previousRuntime.sources?.["uz-public-board"], updates: previousLive.updates || [], coveragePriorities, requestBudget: coveragePlan.requestBudget, stationOffset: previousRuntime.sources?.["uz-public-board"]?.scheduler?.nextOffset || 0 }).catch((error) => recoverOfficialBoard(previousRuntime.sources?.["uz-public-board"], error));
  const anyTrainPromise = collectAnyTrain({ previous: previousRuntime.sources?.["anytrain-uz-public"] });
  const swRailwayPromise = collectSwRailway({ previous: previousRuntime.sources?.["swrailway-commuter-schedule"] });
  const poizdatoPromise = collectPoizdatoStations({ previous: previousRuntime.sources?.["poizdato-station-reference"] });
  const koleoPromise = collectKoleoCatalog({ previous: previousRuntime.sources?.["koleo-station-catalog"] });
  const referencePromise = checkReferences().catch(() => []);
  const internationalPromise = collectInternationalRailSources();

  const [delay, telegram, board, anyTrain, swRailway, poizdato, koleo, references, international] = await Promise.all([
    delayPromise, telegramPromise, boardPromise, anyTrainPromise, swRailwayPromise, poizdatoPromise, koleoPromise, referencePromise, internationalPromise,
  ]);
  const referenceRuntime = Object.fromEntries(references.map((item) => [item.id, item]));
  const sources = {
    "uz-delay-dashboard": delay,
    "uz-public-board": board,
    "uz-suburban-telegram": telegram,
    ...international.sources,
    "anytrain-uz-public": anyTrain,
    "swrailway-commuter-schedule": swRailway,
    "poizdato-station-reference": poizdato,
    "koleo-station-catalog": koleo,
    ...referenceRuntime,
  };
  const evidenceUpdates = [board.updates || [], anyTrain.updates || [], telegram.updates || [], delay.updates || [], international.updates || []];
  const updates = mergeUpdates(evidenceUpdates);
  const onlineCount = Object.values(sources).filter((source) => ["online", "snapshot"].includes(source.status?.status || source.status)).length;
  const checkedAt = new Date().toISOString();
  const plannedUpdates = swRailway.plannedUpdates || [];
  const stationRecords = [...(board.records || []), ...(anyTrain.records || []), ...(swRailway.records || [])];
  const expectedRuns = buildExpectedRuns([...evidenceUpdates.flat(), ...plannedUpdates], stationRecords, checkedAt);
  const primaryOperationalOnline = [delay, telegram, board].some((source) => source.status.status === "online");
  const anyTrainOnline = anyTrain.status?.status === "online";
  const anyFreshOperational = primaryOperationalOnline || anyTrainOnline;
  const generatedAt = primaryOperationalOnline ? checkedAt : anyTrainOnline && anyTrain.status?.sourceUpdatedAt
    ? anyTrain.status.sourceUpdatedAt : (previousLive.generatedAt || checkedAt);
  const sourceStatus = {
    sourceId: "uz-public-fusion", status: anyFreshOperational ? "online" : updates.length ? "stale" : "unavailable",
    label: `UZ fusion: ${updates.length} событий · ${onlineCount}/5 источников доступны`, checkedAt,
    capabilities: { officialStatus: true, forecast: true, stationPassage: true, gps: false, scope: "public-passenger-and-commuter-events" },
  };
  const collectorDiagnostics = {
    board: { status: board.status?.status, checkedAt: board.status?.checkedAt, scheduler: board.scheduler || board.status?.scheduler || null, coverage: board.coverage || board.status?.coverage || null },
    anyTrain: { status: anyTrain.status?.status, sourceUpdatedAt: anyTrain.status?.sourceUpdatedAt || null, scheduler: anyTrain.scheduler || null },
  };
  sourceStatus.label = `UZ fusion: ${updates.length} \u0441\u043e\u0431\u044b\u0442\u0438\u0439 \u00b7 ${onlineCount}/${Object.keys(sources).length} \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u043e\u0432 \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u044b`;
  await atomicJson(runtimeTarget, { schemaVersion: 2, generatedAt: checkedAt, sources });
  const sourceStatuses = Object.entries(sources).map(([sourceId, source]) => ({
    sourceId, ...(source.status || {}),
    recordsCount: Number(source.recordsCount || source.updates?.length || source.records?.length || source.stations?.length || 0),
  }));
  await atomicJson(liveTarget, { schemaVersion: 7, provider: "Ukrzaliznytsia public source fusion", generatedAt, sourceStatus, sourceStatuses, updates, expectedRuns, externalSources: international.sources, collectorDiagnostics });
  console.log(`${sourceStatus.label}; board ${board.status.status}, Telegram ${telegram.status.status}, delays ${delay.status.status}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
