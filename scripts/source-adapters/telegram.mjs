import { decodeHtml, fetchText, normalizeTrainNumber, parseDelayMinutes, splitRoute } from "./html.mjs";

export const TELEGRAM_URL = "https://t.me/s/UZprymisky";
const TRAIN_MENTION_PATTERN = /(?:№\s*|[Пп]оїзд(?:а|и)?\s+)(\d{3,4}(?:\s*\/\s*\d{3,4})?)/gu;

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

function cleanRouteStop(value) {
  return String(value || "")
    .replace(/^сполученням\s+/iu, "")
    .replace(/\s+(?:орієнтовно\s+)?до\s+\d{1,3}\s*(?:хв(?:илин(?:и|у)?)?|мин(?:ут(?:ы|у)?)?)(?:\s|$).*$/iu, "")
    .replace(/\s+\+\s*\d{1,2}(?::\d{2})?\s*(?:хв(?:илин(?:и|у)?)?)?.*$/iu, "")
    .replace(/\s+\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}.*$/u, "")
    .replace(/\s+\(замість\b.*$/iu, "")
    .replace(/\s+до\s+[\p{L} -]{2,40}\s+без\s+змін.*$/iu, "")
    .replace(/\s+(?:(?:сьогодні|завтра)\s+)?(?:притримаємо|курсує|курсуватиме|прямує|відправ(?:ився|иться)?|рушив|приб(?:уде|уває)|затрим(?:ується|ано)?|зупинятиметься|виводиться|має)(?:\s|$).*$/iu, "")
    .replace(/[\s,:;.!?–—-]+$/gu, "")
    .trim();
}

function routeNearTrain(text, rawNumber) {
  const escaped = rawNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:№\\s*)?${escaped}\\s+([^\\n.]{2,100}?(?:→|–|—|-)\\s*[^\\n.]{2,80}?)(?=\\s+(?:курсує|прямує|затрим|відправ|руш|має|із|зі|з\\s)|[.;\\n]|$)`, "u"));
  const route = splitRoute(match?.[1] || "");
  return { origin: cleanRouteStop(route.origin), destination: cleanRouteStop(route.destination) };
}

function trainMentions(text) {
  return [...text.matchAll(TRAIN_MENTION_PATTERN)].map((match) => ({
    trainNumber: normalizeTrainNumber(match[1]),
    index: match.index,
    end: match.index + match[0].length,
  })).filter((mention) => mention.trainNumber);
}

function contextsByTrain(text, mentions) {
  const contexts = {};
  for (let index = 0; index < mentions.length; index += 1) {
    const mention = mentions[index];
    const next = mentions[index + 1];
    const end = Math.min(next?.index ?? text.length, mention.index + 320);
    const context = text.slice(mention.index, end).replace(/^[\s,:;–—-]+|[\s,:;–—-]+$/gu, "").trim();
    if (!contexts[mention.trainNumber] || contexts[mention.trainNumber].length < context.length) contexts[mention.trainNumber] = context;
  }
  return contexts;
}

export function rehydrateTelegramPosts(posts = []) {
  return posts.map((post) => {
    const mentions = trainMentions(post.text || "");
    const trainNumbers = [...new Set(mentions.map((mention) => mention.trainNumber))];
    const contexts = contextsByTrain(post.text || "", mentions);
    const delaysByTrain = Object.fromEntries(trainNumbers.map((trainNumber) => [trainNumber, parseDelayMinutes(contexts[trainNumber] || "")]));
    const reportedStationsByTrain = Object.fromEntries(trainNumbers.map((trainNumber) => [trainNumber, extractReportedStation(contexts[trainNumber] || "")]));
    return {
      ...post, trainNumbers, contexts, delaysByTrain, reportedStationsByTrain,
      delayMinutes: trainNumbers.length === 1 ? delaysByTrain[trainNumbers[0]] : null,
      reportedStation: trainNumbers.length === 1 ? reportedStationsByTrain[trainNumbers[0]] : null,
    };
  }).filter((post) => post.trainNumbers.length);
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
    const mentions = trainMentions(text);
    const trainNumbers = [...new Set(mentions.map((mention) => mention.trainNumber))];
    if (!trainNumbers.length) continue;
    const contexts = contextsByTrain(text, mentions);
    const delaysByTrain = Object.fromEntries(trainNumbers.map((trainNumber) => [trainNumber, parseDelayMinutes(contexts[trainNumber] || "")]));
    const reportedStationsByTrain = Object.fromEntries(trainNumbers.map((trainNumber) => [trainNumber, extractReportedStation(contexts[trainNumber] || "")]));
    posts.push({
      id: postId, sourceId: "uz-suburban-telegram", sourceUrl: `https://t.me/${postId}`,
      occurredAt, checkedAt, authority: "official", type: classify(text), text,
      trainNumbers, contexts, delaysByTrain, reportedStationsByTrain,
      delayMinutes: trainNumbers.length === 1 ? delaysByTrain[trainNumbers[0]] : null,
      reportedStation: trainNumbers.length === 1 ? reportedStationsByTrain[trainNumbers[0]] : null,
    });
  }
  return posts.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

export function telegramUpdates(posts) {
  const updates = [];
  for (const post of posts) {
    for (const trainNumber of post.trainNumbers) {
      const route = routeNearTrain(post.text, trainNumber);
      const delayMinutes = post.delaysByTrain?.[trainNumber] ?? (post.trainNumbers.length === 1 ? post.delayMinutes : null);
      const publicStatus = post.contexts?.[trainNumber] || post.text.slice(0, 240);
      const reportedStation = post.reportedStationsByTrain?.[trainNumber] ?? (post.trainNumbers.length === 1 ? post.reportedStation : null);
      updates.push({
        trainNumber, ...route,
        delayMinutes,
        delayLabel: Number.isFinite(delayMinutes) ? `+${Math.floor(delayMinutes / 60)}:${String(delayMinutes % 60).padStart(2, "0")}` : "",
        publicStatus: publicStatus.slice(0, 240),
        operationalStatus: post.type === "station" ? "station" : post.type === "cancelled" ? "source-unavailable" : "moving",
        forecastDeparture: null, forecastArrival: null, reliability: "Официальный публичный канал",
        reason: post.type === "cancelled" ? "Изменение движения" : null,
        updatedAt: post.occurredAt, source: TELEGRAM_URL, sourceId: post.sourceId,
        sourceEvidence: "official-public-channel", positionEvidence: reportedStation ? "reported-station-passage" : "none",
        reportedStation, sourceEventUrl: post.sourceUrl,
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
