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
  const clock = value.match(/\+?\s*(\d{1,2})\s*[:.]\s*(\d{2})/u);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const hours = value.match(/(\d+(?:[.,]\d+)?)\s*(?:год(?:ина|ини|ин)?|г(?:од)?)/iu);
  const minutes = value.match(/(\d+)\s*(?:хв(?:илин[аи]?)?|мин)/iu);
  if (!hours && !minutes) return null;
  return Math.round(Number(String(hours?.[1] || 0).replace(",", ".")) * 60) + Number(minutes?.[1] || 0);
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
