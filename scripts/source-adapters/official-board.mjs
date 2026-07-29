import { normalizeTrainNumber, parseDelayMinutes, splitRoute } from "./html.mjs";
import { BOARD_STATIONS, classifyBoardWindow, distributeStations, stationBoardPlan } from "./station-board-coverage.mjs";
import { fetchOfficialBoardRecords } from "./official-board-api.mjs";
import { mergeBoardCache } from "./board-intelligence.mjs";

export const BOARD_URL = "https://booking.uz.gov.ua/schedule";
export { BOARD_STATIONS } from "./station-board-coverage.mjs";

export function recoverOfficialBoard(previous = {}, error, checkedAt = new Date().toISOString()) {
  const records = Array.isArray(previous.records) ? previous.records : [];
  const updates = (Array.isArray(previous.updates) ? previous.updates : []).filter((update) => {
    const age = Date.parse(checkedAt) - Date.parse(update?.updatedAt || "");
    return Number.isFinite(age) && age >= 0 && age <= 20 * 60_000;
  });
  const message = String(error?.message || error || "unknown error").slice(0, 500);
  const challengeDetected = /cloudflare|challenge|waitForSelector|timeout/i.test(message);
  const lastSuccessfulAt = previous.status?.lastSuccessfulAt
    || (previous.status?.status === "online" ? previous.status.checkedAt : null)
    || records.map((record) => record.observedAt).filter(Boolean).sort().at(-1)
    || null;
  return {
    status: {
      status: records.length || updates.length ? "stale" : "unavailable",
      checkedAt,
      lastSuccessfulAt,
      label: records.length || updates.length ? "Табло УЗ: последний успешный снимок" : "Табло УЗ: недоступно",
      error: message,
      failureKind: challengeDetected ? "upstream-challenge" : "transport-error",
      capabilities: ["station-board", "last-successful-cache"],
      coverage: previous.coverage || previous.status?.coverage || null,
      scheduler: previous.scheduler || previous.status?.scheduler || null,
    },
    records,
    updates,
    failures: [{ station: null, error: message }],
    coverage: previous.coverage || previous.status?.coverage || null,
    scheduler: previous.scheduler || previous.status?.scheduler || null,
  };
}
export function boardRowsToUpdates(records) {
  return records.map((record) => {
    const route = splitRoute(record.route);
    const delayMinutes = parseDelayMinutes(record.delayLabel);
    const window = classifyBoardWindow(record);
    return {
      trainNumber: normalizeTrainNumber(record.trainNumber), ...route,
      delayMinutes, delayLabel: record.delayLabel || "",
      publicStatus: `Табло ${record.station}: ${record.boardType === "departure" ? "отправление" : "прибытие"} ${record.scheduledTime}${record.platform && record.platform !== "–" ? `, путь ${record.platform}` : ""}`,
      operationalStatus: "station",
      forecastDeparture: record.boardType === "departure" ? record.scheduledTime : null,
      forecastArrival: record.boardType === "arrival" ? record.scheduledTime : null,
      reliability: "Официальное вокзальное табло", reason: null,
      updatedAt: record.observedAt, source: BOARD_URL, sourceId: "uz-public-board",
      sourceEvidence: "official-station-board", positionEvidence: window.isStationFact ? "station-board-window" : "schedule-only",
      reportedStation: window.isStationFact ? record.station : null, platform: record.platform, boardType: record.boardType,
      scheduledStationAt: window.scheduledAt, stationWindowPhase: window.phase, stationWindowOffsetMinutes: window.offsetMinutes,
    };
  }).filter((update) => update.trainNumber && update.route);
}

async function readStation(page, station, observedAt) {
  await page.waitForFunction((name) => document.querySelector("main h3")?.textContent?.trim() === name, station, { timeout: 20_000 });
  return page.evaluate(({ station, observedAt }) => {
    const tables = [...document.querySelectorAll("main table")].slice(0, 2);
    return tables.flatMap((table, tableIndex) => [...table.querySelectorAll("tbody tr")].map((row) => {
      const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() || "");
      const routeCell = cells[1] || "";
      const delayLabel = routeCell.match(/\/\/\s*(.+)$/)?.[1] || "";
      return { station, boardType: tableIndex === 0 ? "departure" : "arrival", trainNumber: cells[0], route: routeCell.replace(/\/\/.*$/, "").trim(), scheduledTime: cells[2], platform: cells[3], delayLabel, observedAt };
    }));
  }, { station, observedAt });
}

async function collectOfficialBoardViaUi({ stations = BOARD_STATIONS } = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: process.env.BOARD_HEADLESS !== "false" });
  const checkedAt = new Date().toISOString(), records = [], failures = [];
  const plannedStations = stationBoardPlan({ stations, shardIndex: process.env.BOARD_SHARD_INDEX, shardCount: process.env.BOARD_SHARD_COUNT });
  try {
    const context = await browser.newContext({ locale: "uk-UA", timezoneId: "Europe/Kyiv", userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/145 Safari/537.36" });
    const workers = distributeStations(plannedStations, process.env.BOARD_CONCURRENCY || 3).map(async (workerStations) => {
      const page = await context.newPage();
      page.setDefaultTimeout(12_000);
      try {
        await page.goto(BOARD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector("main h3", { timeout: 90_000 });
        for (const station of workerStations) {
          try {
            const current = await page.locator("main h3").textContent();
            if (current?.trim() !== station) {
              await page.getByRole("button", { name: "Змінити", exact: true }).click();
              const exact = page.getByRole("option", { name: station, exact: true });
              if (await exact.count()) await exact.first().click();
              else {
                const search = page.getByRole("combobox").last();
                await search.fill(station);
                await page.getByRole("option").first().click();
              }
            }
            const actualStation = (await page.locator("main h3").textContent())?.trim() || station;
            records.push(...await readStation(page, actualStation, new Date().toISOString()));
          } catch (error) {
            failures.push({ station, error: String(error.message || error).slice(0, 240) });
            await page.keyboard.press("Escape").catch(() => {});
          }
        }
      } finally {
        await page.close();
      }
    });
    await Promise.all(workers);
    await context.close();
  } finally {
    await browser.close();
  }
  if (!records.length) throw new Error(`Official board returned no records; ${failures.length} station failures`);
  const updates = boardRowsToUpdates(records), successfulStations = new Set(records.map((item) => item.station)).size;
  const coverage = { plannedStations: plannedStations.length, successfulStations, failedStations: failures.length, records: records.length, stationFacts: updates.filter((item) => item.reportedStation).length, scheduleRows: updates.filter((item) => !item.reportedStation).length };
  return {
    status: { status: failures.length && successfulStations < plannedStations.length * .7 ? "degraded" : "online", checkedAt, lastSuccessfulAt: checkedAt, label: `Табло УЗ: ${records.length} строк, ${successfulStations}/${plannedStations.length} станций, ${coverage.stationFacts} актуальных окон`, capabilities: ["station-board", "platform", "schedule", "delay", "mass-node-coverage"], coverage },
    records, failures, updates, coverage,
  };
}

export async function collectOfficialBoard(options = {}) {
  try {
    const result = await fetchOfficialBoardRecords({
      stations: Array.isArray(options.stations) ? options.stations : null,
      concurrency: options.concurrency || process.env.BOARD_CONCURRENCY || 2,
      fetchImpl: options.fetchImpl || fetch,
      sessionId: options.sessionId,
      requestDelayMs: options.requestDelayMs,
      requestBudget: options.requestBudget,
      stationOffset: options.stationOffset,
      updates: options.updates || [],
      previousRecords: options.previous?.records || [],
    });
    const updates = boardRowsToUpdates(result.records);
    const cache = mergeBoardCache(options.previous?.records || [], result.records, result.checkedAt, options.cacheTtlHours || 8);
    const successfulStations = new Set(result.records.map((item) => item.station)).size;
    const plannedStations = result.plannedStations.length;
    const coverage = { plannedStations, successfulStations, failedStations: result.failures.length, deferredStations: result.deferredStations?.length || 0, records: result.records.length, cachedRecords: cache.cachedRecords, cachedStations: cache.cachedStations, stationFacts: updates.filter((item) => item.reportedStation).length, scheduleRows: updates.filter((item) => !item.reportedStation).length, transport: result.transport };
    return {
      status: { status: result.failures.length && successfulStations < plannedStations * .7 ? "degraded" : "online", checkedAt: result.checkedAt, lastSuccessfulAt: result.checkedAt, label: `Табло УЗ API: ${result.records.length} строк, ${successfulStations}/${plannedStations} станций, ${coverage.stationFacts} актуальных окон`, capabilities: ["official-json-api", "station-board", "platform", "schedule", "delay", "mass-node-coverage"], coverage },
      records: cache.records, failures: result.failures, updates, coverage, scheduler: result.scheduler,
    };
  } catch (error) {
    if (process.env.BOARD_UI_FALLBACK === "1") return collectOfficialBoardViaUi(options);
    throw error;
  }
}
