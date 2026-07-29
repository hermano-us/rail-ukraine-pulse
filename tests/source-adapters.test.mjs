import test from "node:test";
import assert from "node:assert/strict";
import { boardRowsToUpdates, recoverOfficialBoard } from "../scripts/source-adapters/official-board.mjs";
import { BOARD_STATIONS, classifyBoardWindow, distributeStations, stationBoardPlan } from "../scripts/source-adapters/station-board-coverage.mjs";
import { apiBoardToRecords, fetchOfficialBoardRecords, selectApiStations } from "../scripts/source-adapters/official-board-api.mjs";
import { mergeBoardCache, rankBoardStations } from "../scripts/source-adapters/board-intelligence.mjs";
import { parseTelegramFeed, rehydrateTelegramPosts, telegramUpdates } from "../scripts/source-adapters/telegram.mjs";

test("official board rows become station-window updates, not GPS", () => {
  const [update] = boardRowsToUpdates([{
    station: "Київ-Пасажирський", boardType: "arrival", trainNumber: "28Л",
    route: "Чоп → Київ-Пас // затримується на 30 хв", scheduledTime: "09:26", platform: "9",
    delayLabel: "затримується на 30 хв", observedAt: "2026-07-20T07:00:00Z",
  }]);
  assert.equal(update.trainNumber, "28");
  assert.equal(update.reportedStation, "Київ-Пасажирський");
  assert.equal(update.positionEvidence, "station-board-window");
  assert.equal(update.delayMinutes, 30);
  assert.equal(update.gps, undefined);
});

test("mass station plan covers core and corridor nodes without duplicates", () => {
  const plan = stationBoardPlan();
  assert.ok(plan.length >= 50);
  assert.equal(new Set(plan).size, plan.length);
  const shards = [0, 1, 2].flatMap((shardIndex) => stationBoardPlan({ shardIndex, shardCount: 3 }));
  assert.deepEqual(new Set(shards), new Set(BOARD_STATIONS));
  const buckets = distributeStations(plan, 3);
  assert.equal(buckets.length, 3);
  assert.equal(buckets.flat().length, plan.length);
});

test("station board separates a current observation window from a future schedule row", () => {
  const current = classifyBoardWindow({ scheduledTime: "09:26", observedAt: "2026-07-20T07:00:00Z" });
  const future = classifyBoardWindow({ scheduledTime: "16:00", observedAt: "2026-07-20T07:00:00Z" });
  assert.equal(current.isStationFact, true);
  assert.equal(current.scheduledAt, "2026-07-20T06:26:00.000Z");
  assert.equal(future.isStationFact, false);
  const [update] = boardRowsToUpdates([{
    station: "Львів", boardType: "departure", trainNumber: "91",
    route: "Київ → Львів", scheduledTime: "16:00", platform: "2",
    delayLabel: "", observedAt: "2026-07-20T07:00:00Z",
  }]);
  assert.equal(update.reportedStation, null);
  assert.equal(update.positionEvidence, "schedule-only");
  assert.equal(update.scheduledStationAt, "2026-07-20T13:00:00.000Z");
});

test("official board failure preserves the last successful snapshot without refreshing its facts", () => {
  const observedAt = "2026-07-20T07:00:00Z";
  const recovered = recoverOfficialBoard({
    status: { status: "online", checkedAt: observedAt },
    records: [{ station: "Львів", boardType: "arrival", trainNumber: "91", route: "Київ → Львів", scheduledTime: "09:26", platform: "2", delayLabel: "", observedAt }],
    coverage: { plannedStations: 54, successfulStations: 54 },
  }, new Error("page.waitForSelector: Timeout 90000ms exceeded"), "2026-07-20T08:00:00Z");
  assert.equal(recovered.status.status, "stale");
  assert.equal(recovered.status.failureKind, "upstream-challenge");
  assert.equal(recovered.status.lastSuccessfulAt, observedAt);
  assert.equal(recovered.records.length, 1);
  assert.equal(recovered.updates.length, 0);
});

test("official Telegram preview produces traceable station-passage updates", () => {
  const html = `<div class="tgme_widget_message_wrap"><article data-post="UZprymisky/123"><div class="tgme_widget_message_text">Поїзд №6027 Дніпро – Кривий Ріг-Головний курсує зі станції Верхньодніпровськ +25 хвилин.</div><time datetime="2026-07-20T06:00:00+00:00"></time></article></div>`;
  const posts = parseTelegramFeed(html, "2026-07-20T06:01:00Z");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].reportedStation, "Верхньодніпровськ");
  const [update] = telegramUpdates(posts);
  assert.equal(update.trainNumber, "6027");
  assert.equal(update.delayMinutes, 25);
  assert.equal(update.positionEvidence, "reported-station-passage");
});

test("multi-train Telegram notices keep train numbers out of delay values", () => {
  const text = "❕ 🚊 Зберігаємо пересадки у Гребінці. Через запізнення на кінцеву №6524/6523 Ніжин – Гребінка притримаємо низку приміських рейсів: 🚊 ➡️ №6366 Гребінка – Ромодан до 40 хвилин 🚊 ➡️ №6813 сполученням Гребінка - Київ до 25 хвилин 🚊 ➡️ №6093 Гребінка – Лубни";
  const html = '<div class="tgme_widget_message_wrap"><article data-post="UZprymisky/999"><div class="tgme_widget_message_text">' + text + '</div><time datetime="2026-07-20T06:00:00+00:00"></time></article></div>';
  const [post] = parseTelegramFeed(html, "2026-07-20T06:01:00Z");
  const updates = telegramUpdates([post]);
  const byNumber = Object.fromEntries(updates.map((update) => [update.trainNumber, update]));
  assert.equal(byNumber["6524/6523"].delayMinutes, null);
  assert.equal(byNumber["6366"].delayMinutes, 40);
  assert.equal(byNumber["6366"].delayLabel, "+0:40");
  assert.equal(byNumber["6813"].delayMinutes, 25);
  assert.equal(byNumber["6093"].delayMinutes, null);
  assert.doesNotMatch(byNumber["6366"].publicStatus, /6813/u);
  assert.deepEqual([byNumber["6366"].origin, byNumber["6366"].destination], ["Гребінка", "Ромодан"]);
  assert.deepEqual([byNumber["6813"].origin, byNumber["6813"].destination], ["Гребінка", "Київ"]);
});

test("multi-train Telegram station passages stay attached to their own train", () => {
  const text = "Поїзд №6308 Конотоп – Шостка курсує зі станції Бориса Олійника +15 хвилин. Поїзд №6027 Дніпро – Кривий Ріг-Головний прямує зі станції Верхньодніпровськ +25 хвилин.";
  const html = '<div class="tgme_widget_message_wrap"><article data-post="UZprymisky/1000"><div class="tgme_widget_message_text">' + text + '</div><time datetime="2026-07-20T06:00:00+00:00"></time></article></div>';
  const updates = telegramUpdates(parseTelegramFeed(html, "2026-07-20T06:01:00Z"));
  const byNumber = Object.fromEntries(updates.map((update) => [update.trainNumber, update]));
  assert.equal(byNumber["6308"].reportedStation, "Бориса Олійника");
  assert.equal(byNumber["6027"].reportedStation, "Верхньодніпровськ");
  assert.equal(byNumber["6308"].delayMinutes, 15);
  assert.equal(byNumber["6027"].delayMinutes, 25);
});
test("Telegram route cleanup removes operational prose and timetable ranges", () => {
  const text = "Поїзд №6202 Козятин – Фастів зупинятиметься на станції Триліси. Поїзд №6370 Стоянів – Ківерці 03:50 – 07:04.";
  const html = '<div class="tgme_widget_message_wrap"><article data-post="UZprymisky/1001"><div class="tgme_widget_message_text">' + text + '</div><time datetime="2026-07-20T06:00:00+00:00"></time></article></div>';
  const updates = telegramUpdates(parseTelegramFeed(html, "2026-07-20T06:01:00Z"));
  const byNumber = Object.fromEntries(updates.map((update) => [update.trainNumber, update]));
  assert.equal(byNumber["6202"].destination, "Фастів");
  assert.equal(byNumber["6370"].destination, "Ківерці");
});
test("stale Telegram posts are reprocessed instead of dropping their trains", () => {
  const [post] = rehydrateTelegramPosts([{
    id: "UZprymisky/legacy",
    text: "Через поїзд №6902 Київ-Волинський – Гребінка притримаємо поїзд №6364 Гребінка – Ромодан орієнтовно до 15 хвилин.",
    occurredAt: "2026-07-20T06:00:00Z",
    sourceId: "uz-suburban-telegram",
  }]);
  const updates = telegramUpdates([post]);
  const byNumber = Object.fromEntries(updates.map((update) => [update.trainNumber, update]));
  assert.equal(byNumber["6902"].delayMinutes, null);
  assert.equal(byNumber["6364"].delayMinutes, 15);
  assert.equal(byNumber["6364"].destination, "Ромодан");
});
test("delay parser ignores timetable clocks and impossible values", async () => {
  const { parseDelayMinutes } = await import("../scripts/source-adapters/html.mjs");
  assert.equal(parseDelayMinutes("№6366: затримка до 40 хвилин"), 40);
  assert.equal(parseDelayMinutes("відправлення о 09:26"), null);
  assert.equal(parseDelayMinutes("затримка +66:40"), null);
});

test("official JSON board preserves exact schedule time and delay", () => {
  const scheduledAt = "2026-07-29T05:00:00.000Z";
  const records = apiBoardToRecords({
    station: { id: 2200001, name: "Київ-Пасажирський" },
    arrivals: [{ train: "24К", route: "Хелм → Київ-Пас", time: Date.parse(scheduledAt) / 1000, platform: null, delay_minutes: 145 }],
    departures: [],
    peron: false,
  }, "2026-07-29T04:50:00.000Z");
  assert.equal(records.length, 1);
  assert.equal(records[0].scheduledAt, scheduledAt);
  assert.equal(records[0].scheduledTime, "08:00");
  assert.equal(records[0].delayLabel, "+2:25");
  assert.equal(classifyBoardWindow(records[0]).isStationFact, true);
});

test("official JSON collector uses a fresh anonymous session contract", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers });
    if (url.endsWith("/station-boards")) return new Response(JSON.stringify([
      { id: 2200001, name: "Київ-Пасажирський" },
      { id: 2218000, name: "Львів" },
    ]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({
      station: { id: 2200001, name: "Київ-Пасажирський" },
      arrivals: [],
      departures: [{ train: "9К", route: "Київ-Пас → Будапешт", time: Date.parse("2026-07-29T07:00:00Z") / 1000, platform: "1", delay_minutes: null }],
      peron: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await fetchOfficialBoardRecords({ stations: ["Київ-Пасажирський"], concurrency: 1, fetchImpl, sessionId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(result.plannedStations.length, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.transport, "official-json-api");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["x-session-id"], "11111111-1111-4111-8111-111111111111");
  assert.equal(calls[0].headers["x-user-agent"], "UZ/2 Web/1 User/guest");
  assert.notEqual(calls[1].headers["x-session-id"], calls[0].headers["x-session-id"]);
  assert.match(calls[1].headers["x-session-id"], /^[0-9a-f-]{36}$/i);
  assert.equal(selectApiStations([{ id: 1, name: "Львів" }], ["Київ-Пасажирський"]).length, 0);
});
test("board scheduler prioritizes uncertain traffic and explains the choice", () => {
  const ranked = rankBoardStations([
    { id: "1", name: "\u041b\u044c\u0432\u0456\u0432" }, { id: "2", name: "\u041a\u0438\u0457\u0432-\u041f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439" },
  ], {
    now: "2026-07-29T08:00:00Z",
    updates: [{ trainNumber: "91", destination: "\u041b\u044c\u0432\u0456\u0432", confidence: .25, errorKm: 120 }],
    previousRecords: [{ station: "\u041a\u0438\u0457\u0432-\u041f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439", observedAt: "2026-07-29T07:55:00Z" }],
  });
  assert.equal(ranked[0].name, "\u041b\u044c\u0432\u0456\u0432");
  assert.equal(ranked[0].expectedTrains, 1);
  assert.match(ranked[0].reasons.join(" "), /\u043e\u0436\u0438\u0434\u0430\u0435\u043c\u044b\u0445 \u0440\u0435\u0439\u0441\u043e\u0432|\u043a\u043b\u044e\u0447\u0435\u0432\u043e\u0439 \u0443\u0437\u0435\u043b/);
});

test("board cache replaces a refreshed station and expires old evidence", () => {
  const now = "2026-07-29T08:00:00Z";
  const previous = [
    { station: "\u041b\u044c\u0432\u0456\u0432", boardType: "arrival", trainNumber: "1", scheduledAt: "2026-07-29T09:00:00Z", observedAt: "2026-07-29T07:00:00Z" },
    { station: "\u041a\u0438\u0457\u0432", boardType: "departure", trainNumber: "2", scheduledAt: "2026-07-29T10:00:00Z", observedAt: "2026-07-28T20:00:00Z" },
  ];
  const fresh = [{ station: "\u041b\u044c\u0432\u0456\u0432", boardType: "arrival", trainNumber: "3", scheduledAt: "2026-07-29T09:30:00Z", observedAt: now }];
  const cache = mergeBoardCache(previous, fresh, now, 8);
  assert.deepEqual(cache.records.map((item) => item.trainNumber), ["3"]);
  assert.equal(cache.cachedRecords, 0);
});
