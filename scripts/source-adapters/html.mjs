export function decodeHtml(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&rarr;|&rightarrow;|&#8594;/gi, "→")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#8470;|&numero;/gi, "№")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function normalizeTrainNumber(value = "") {
  return String(value).replace(/^№\s*/u, "").replace(/[^0-9/]/g, "").replace(/^\/+|\/+$/g, "");
}

export function splitRoute(value = "") {
  const clean = value.replace(/\/\/.*$/s, "").trim();
  const parts = clean.split(/\s+(?:→|—|–|-{1,2})\s+/u);
  return parts.length >= 2
    ? { route: `${parts[0].trim()} → ${parts.slice(1).join(" – ").trim()}`, origin: parts[0].trim(), destination: parts.slice(1).join(" – ").trim() }
    : { route: clean, origin: "", destination: "" };
}

export function parseDelayMinutes(value = "") {
  // Train identifiers are not durations. Mask them before looking for clocks so
  // a fragment such as №6366: ... 40 хв cannot become a 66-hour delay.
  const clean = String(value).replace(
    /(?:№\s*|[Пп]оїзд(?:а|и)?\s+|[Пп]оезд(?:а|ы)?\s+)(\d{1,4}(?:\s*\/\s*\d{1,4})?)/gu,
    (match) => " ".repeat(match.length),
  );
  const bounded = (minutes) => Number.isFinite(minutes) && minutes >= 0 && minutes <= 24 * 60 ? minutes : null;

  // A clock-shaped value is a delay only with an explicit plus or a nearby
  // delay/holding cue. Plain timetable values such as 09:26 are ignored.
  const clock = clean.match(/(?:\+\s*|(?:затрим\w*|запізнен\w*|задерж\w*|притрима\w*|очіку\w*|до|на)\D{0,24})(\d{1,2})\s*[:.]\s*(\d{2})(?!\d)/iu);
  if (clock && Number(clock[2]) < 60) return bounded(Number(clock[1]) * 60 + Number(clock[2]));
  const hours = clean.match(/(\d{1,2}(?:[.,]\d+)?)\s*(?:год(?:ина|ини|ин)?|г(?:од)?)(?!\p{L})/iu);
  const minutes = clean.match(/(\d{1,3})\s*(?:хв(?:илин[аи]?)?|мин(?:ут[ыа]?)?)(?!\p{L})/iu);
  if (!hours && !minutes) return null;
  return bounded(Math.round(Number(String(hours?.[1] || 0).replace(",", ".")) * 60) + Number(minutes?.[1] || 0));
}

export async function fetchText(url, { timeoutMs = 25_000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "RailUkrainePulse/3.0 (+https://github.com/hermano-us/rail-ukraine-pulse)", ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
