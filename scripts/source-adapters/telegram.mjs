import { decodeHtml, fetchText, normalizeTrainNumber, parseDelayMinutes, splitRoute } from "./html.mjs";

export const TELEGRAM_URL = "https://t.me/s/UZprymisky";

function classify(text) {
  const value = text.toLocaleLowerCase("uk");
  if (/виводиться з маршруту|скасован|не курсуватиме/u.test(value)) return "cancelled";
  if (/рушили|відправився|прямує|курсує|вже в русі/u.test(value)) return "moving";
  if (/зачека|затрим.*початков/u.test(value)) return "station";
  return "notice";
}

function extractReportedStation(text) {
  const match = text.match(/(?:зі|із|з)\s+(?:станції|зупинки|роз[’']?їзду)\s+([А-ЯІЇЄҐ][\p{L}\d .’'()-]{1,42}?)(?=\s+(?:\+|прямує|курсує|відправ|затрим)|[.,;\n]|$)/u);
  return match?.[1]?.trim() || null;
}

function routeNearTrain(text, rawNumber) {
  const escaped = rawNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:№\\s*)?${escaped}\\s+([^\\n.]{2,100}?(?:→|–|—|-)\\s*[^\\n.]{2,80}?)(?=\\s+(?:курсує|прямує|затрим|відправ|руш|має|із|зі|з\\s)|[.;\\n]|$)`, "u"));
  return splitRoute(match?.[1] || "");
}

export function parseTelegramFeed(html, checkedAt = new Date().toISOString()) {
  const posts = [];
  const starts = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*"/gi)].map((match) => match.index);
  for (let index = 0; index < starts.length; index += 1) {
    const body = html.slice(starts[index], starts[index + 1] ?? html.length);
    const messageHtml = body.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (!messageHtml) continue;
    const text = decodeHtml(messageHtml);
    const occurredAt = body.match(/<time[^>]+datetime="([^"]+)"/i)?.[1] || checkedAt;
    const postId = body.match(/data-post="([^"]+)"/i)?.[1] || `UZprymisky/${occurredAt}`;
    const rawNumbers = [...text.matchAll(/(?:№\s*|[Пп]оїзд(?:а|и)?\s+)(\d{3,4}(?:\s*\/\s*\d{3,4})?)/gu)].map((match) => match[1].replace(/\s/g, ""));
    const trainNumbers = [...new Set(rawNumbers.map(normalizeTrainNumber).filter(Boolean))];
    if (!trainNumbers.length) continue;
    posts.push({
      id: postId, sourceId: "uz-suburban-telegram", sourceUrl: `https://t.me/${postId}`,
      occurredAt, checkedAt, authority: "official", type: classify(text), text,
      trainNumbers, delayMinutes: parseDelayMinutes(text), reportedStation: extractReportedStation(text),
    });
  }
  return posts.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

export function telegramUpdates(posts) {
  const updates = [];
  for (const post of posts) {
    for (const trainNumber of post.trainNumbers) {
      const route = routeNearTrain(post.text, trainNumber);
      updates.push({
        trainNumber, ...route,
        delayMinutes: post.delayMinutes,
        delayLabel: Number.isFinite(post.delayMinutes) ? `+${Math.floor(post.delayMinutes / 60)}:${String(post.delayMinutes % 60).padStart(2, "0")}` : "",
        publicStatus: post.text.slice(0, 240),
        operationalStatus: post.type === "station" ? "station" : post.type === "cancelled" ? "source-unavailable" : "moving",
        forecastDeparture: null, forecastArrival: null, reliability: "Официальный публичный канал",
        reason: post.type === "cancelled" ? "Изменение движения" : null,
        updatedAt: post.occurredAt, source: TELEGRAM_URL, sourceId: post.sourceId,
        sourceEvidence: "official-public-channel", positionEvidence: post.reportedStation ? "reported-station-passage" : "none",
        reportedStation: post.reportedStation, sourceEventUrl: post.sourceUrl,
      });
    }
  }
  return updates;
}

export async function collectTelegram() {
  const checkedAt = new Date().toISOString();
  const posts = parseTelegramFeed(await fetchText(TELEGRAM_URL), checkedAt);
  if (!posts.length) throw new Error("Telegram preview returned no train events");
  return {
    status: { status: "online", checkedAt, label: `УЗ Пригород: ${posts.length} событий`, capabilities: ["service-alerts", "station-passage", "delay"] },
    posts, updates: telegramUpdates(posts),
  };
}
