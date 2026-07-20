import test from "node:test";
import assert from "node:assert/strict";
import { boardRowsToUpdates } from "../scripts/source-adapters/official-board.mjs";
import { parseTelegramFeed, telegramUpdates } from "../scripts/source-adapters/telegram.mjs";

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
