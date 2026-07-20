import test from "node:test";
import assert from "node:assert/strict";
import { boardRowsToUpdates } from "../scripts/source-adapters/official-board.mjs";
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
