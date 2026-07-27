import { decodeHtml, fetchText } from "./html.mjs";

const RAIL_CONTEXT = /(поїзд|потяг|состав|вантаж|грузов|локомотив|електровоз|тепловоз|вагон|цистерн|зерновоз|контейнер|піввагон|полувагон|думпкар|хопер|чмэ|чме|вл\d|2те\d|дс3|дс4)/iu;
const FREIGHT_CONTEXT = /(вантаж|грузов|цистерн|зерновоз|контейнер|піввагон|полувагон|думпкар|хопер|руд[аы]|вугіл|угол|цемент|наливн|порожн|пуст[оы]й состав|карьер|метал|щеб)/iu;
const PASSENGER_CONTEXT = /(пасажир|пассажир|електричк|электричк|приміськ|пригород|інтерсіті|интерсити|intercity)/iu;
const SENSITIVE_CONTEXT = /(військ|военн|эшелон|ешелон|технік[аи]|бронетех|боєприп|боеприп|ракет|озброєн|вооружен|танк(?:и|ів|ов)?\b|ппо\b|зсу\b|всу\b)/iu;

function fingerprint(value) { let hash = 2166136261; for (const char of String(value || "").normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/\s+/g, " ").trim()) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); }
function freightType(text) {
  if (/цистерн|наливн/iu.test(text)) return "tank_cars"; if (/контейнер/iu.test(text)) return "containers";
  if (/зерновоз|зерн/iu.test(text)) return "grain"; if (/руд|вугіл|угол|щеб|думпкар|хопер|піввагон|полувагон/iu.test(text)) return "bulk";
  return "general_freight";
}

export function extractFreightEntities(text) {
  const value=String(text||"").normalize("NFKC");
  const locomotive=value.match(/((?:2?[ТT][ЕEЭ]|ВЛ|ЧС|ДС|М62|ЧМ[ЭЕ])[\p{L}\d]*\s*[-–—]?\s*\d{2,5}(?:\/\d+)?)/iu)?.[1]||null;
  const direction=value.match(/(?:на(?!\s+станц)|до|в\s+бік|у\s+напрямку|в\s+направлении)\s+([\p{L}][\p{L}'’.-]{2,})/iu)?.[1]||null;
  const stationRaw=value.match(/(?:на\s+станц(?:ії|ии)\s+|станц(?:ія|ия)\s+|ст\.?\s+)([\p{L}\d][^,.;:\n]{1,80})/iu)?.[1]||null;
  const station=stationRaw?.split(/\s+(?:на|до|у|в|пройш|прибув|прослед|відправ)/iu)[0].trim().slice(0,120)||null;
  return {locomotive:locomotive?locomotive.toLocaleUpperCase("uk-UA").replace(/\s*[-–—]\s*/,"-").replace(/\s+/g,""):null,direction:direction?direction.toLocaleLowerCase("uk-UA"):null,station};
}

export function classifyFreightText(text) {
  const value = String(text || "");
  const entities=extractFreightEntities(value);
  if (SENSITIVE_CONTEXT.test(value)) return { accepted: false, restricted: true, reason: "sensitive_content" };
  if (!RAIL_CONTEXT.test(value)) return { accepted: false, reason: "not_rail" };
  if (!FREIGHT_CONTEXT.test(value) && PASSENGER_CONTEXT.test(value)) return { accepted: false, reason: "passenger_only" };
  if (!FREIGHT_CONTEXT.test(value)) return { accepted: true, restricted: false, freightType: "unclassified_rail", confidenceFactor: 0.45, entities };
  return { accepted: true, restricted: false, freightType: freightType(value), confidenceFactor: 1, entities };
}

export function parseFreightPreview(html, source, checkedAt = new Date().toISOString()) {
  const observations = []; const starts = [...String(html || "").matchAll(/<div class="tgme_widget_message_wrap[^"]*"/gi)].map((match) => match.index);
  let restricted = 0; let rejected = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const body = html.slice(starts[index], starts[index + 1] ?? html.length); const messageHtml = body.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (!messageHtml) continue; const text = decodeHtml(messageHtml); const classification = classifyFreightText(text);
    if (!classification.accepted) { if (classification.restricted) restricted += 1; else rejected += 1; continue; }
    const occurredAt = body.match(/<time[^>]+datetime="([^"]+)"/i)?.[1] || checkedAt; const postId = body.match(/data-post="([^"]+)"/i)?.[1]; if (!postId) continue;
    observations.push({
      observationId: `${source.id}:${fingerprint(`${postId}:${text}`)}`, sourceId: source.id, sourceUrl: `https://t.me/${postId}`,
      occurredAt, checkedAt, corridor: source.corridor || "unresolved", freightType: classification.freightType,
      confidence: Math.max(0.05, Math.min(0.65, (Number(source.reliability) || 0.2) * classification.confidenceFactor)), contentFingerprint: fingerprint(text),
      evidenceExcerpt: text.replace(/\s+/g, " ").slice(0, 360), entities:classification.entities, publicEligible: false,
    });
  }
  return { observations, restricted, rejected, previewMessages: starts.length };
}

export async function collectFreightTelegram(source) {
  const checkedAt = new Date().toISOString();
  if (!source.enabled || source.access !== "public-preview") return { sourceId: source.id, status: source.access === "requires-membership" ? "requires_membership" : "disabled", checkedAt, observations: [], restricted: 0, rejected: 0 };
  const parsed = parseFreightPreview(await fetchText(`https://t.me/s/${source.handle}`), source, checkedAt);
  return { sourceId: source.id, status: "online", checkedAt, ...parsed };
}
