import { normalizeTrainNumber, parseDelayMinutes, splitRoute } from "./html.mjs";

export const BOARD_URL = "https://booking.uz.gov.ua/schedule";
export const BOARD_STATIONS = [
  "Київ-Пасажирський", "Львів", "Дніпро-Головний", "Запоріжжя 1", "Харків-Пасажирський",
  "Одеса-Головна", "Вінниця", "Чернівці", "Суми", "Хмельницький", "Рівне", "Івано-Франківськ",
  "Тернопіль", "Луцьк", "Ужгород", "Ковель", "Полтава-Київська", "Херсон", "Черкаси",
  "Миколаїв-Пасажирський", "Кропивницький", "Чернігів", "Житомир", "Жмеринка-Пасажирська",
  "Козятин-1", "Фастів-1", "Ніжин", "Конотоп-Пасажирський", "Гребінка", "Шепетівка",
];

export function boardRowsToUpdates(records) {
  return records.map((record) => {
    const route = splitRoute(record.route);
    const delayMinutes = parseDelayMinutes(record.delayLabel);
    return {
      trainNumber: normalizeTrainNumber(record.trainNumber), ...route,
      delayMinutes, delayLabel: record.delayLabel || "",
      publicStatus: `Табло ${record.station}: ${record.boardType === "departure" ? "отправление" : "прибытие"} ${record.scheduledTime}${record.platform && record.platform !== "–" ? `, путь ${record.platform}` : ""}`,
      operationalStatus: "station",
      forecastDeparture: record.boardType === "departure" ? record.scheduledTime : null,
      forecastArrival: record.boardType === "arrival" ? record.scheduledTime : null,
      reliability: "Официальное вокзальное табло", reason: null,
      updatedAt: record.observedAt, source: BOARD_URL, sourceId: "uz-public-board",
      sourceEvidence: "official-station-board", positionEvidence: "station-board-window",
      reportedStation: record.station, platform: record.platform, boardType: record.boardType,
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

export async function collectOfficialBoard({ stations = BOARD_STATIONS } = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: process.env.BOARD_HEADLESS !== "false" });
  const checkedAt = new Date().toISOString(), records = [], failures = [];
  try {
    const context = await browser.newContext({ locale: "uk-UA", timezoneId: "Europe/Kyiv", userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/145 Safari/537.36" });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(BOARD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.waitForSelector("main h3", { timeout: 90_000 });
    } catch (error) {
      const title=await page.title().catch(()=>"");
      const heading=await page.locator("h1").textContent().catch(()=>"");
      throw new Error(`Official board did not render (title=${title}; heading=${heading||"none"}): ${error.message}`);
    }
    for (const station of stations) {
      try {
        const current = await page.locator("main h3").textContent();
        if (current?.trim() !== station) {
          await page.getByRole("button", { name: "Змінити", exact: true }).click();
          await page.getByRole("option", { name: station, exact: true }).click();
        }
        records.push(...await readStation(page, station, new Date().toISOString()));
      } catch (error) {
        failures.push({ station, error: String(error.message || error).slice(0, 240) });
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  if (!records.length) throw new Error(`Official board returned no records; ${failures.length} station failures`);
  return {
    status: { status: "online", checkedAt, label: `Табло УЗ: ${records.length} строк, ${new Set(records.map((item) => item.station)).size}/${stations.length} станций`, capabilities: ["station-board", "platform", "schedule", "delay"] },
    records, failures, updates: boardRowsToUpdates(records),
  };
}
