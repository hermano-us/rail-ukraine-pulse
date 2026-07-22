import { createHash } from "node:crypto";

const apiUrl = String(process.env.RAIL_API_URL || "").replace(/\/$/, "");
const token = process.env.RAIL_INGEST_TOKEN;
if (!apiUrl || !token) throw new Error("RAIL_API_URL and RAIL_INGEST_TOKEN are required");
const stableId = (namespace, url) => `${namespace}:${createHash("sha256").update(url).digest("hex").slice(0, 40)}`;

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json, application/rss+xml, application/xml", "User-Agent": "RailUkrainePulse/1.0 fuel-safety-monitor" }, signal: AbortSignal.timeout(25_000) });
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`upstream HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  throw lastError;
}
function isoDate(value) {
  const raw = String(value || ""); const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}
function decodeXml(value) {
  return String(value || "").replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
function xmlTag(xml, name) { return decodeXml(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]); }

async function collectGdelt() {
  const query = '("gas station" OR "petrol station" OR "fuel station") (Ukraine OR Ukrainian) (strike OR attack OR damaged OR closed OR reopened)';
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  for (const [key, value] of Object.entries({ query, mode: "artlist", maxrecords: "75", format: "json", timespan: "1d" })) url.searchParams.set(key, value);
  try {
    const response = await fetchWithRetry(url); if (!response.ok) return [];
    const payload = await response.json(); const articles = Array.isArray(payload.articles) ? payload.articles : [];
    return articles.flatMap((article) => { try { const sourceUrl = new URL(article.url).href; const title = String(article.title || "").trim(); return title ? [{ signalId: stableId("gdelt", sourceUrl), sourceId: "gdelt-doc", sourceName: article.domain || "GDELT DOC 2.0", sourceUrl, title, snippet: "", publishedAt: isoDate(article.seendate), locationText: article.sourcecountry === "Ukraine" ? "Україна" : "", confidence: 0.46, raw: { domain: article.domain, language: article.language, sourceCountry: article.sourcecountry } }] : []; } catch { return []; } });
  } catch (error) { console.warn(`GDELT unavailable: ${error.message}`); return []; }
}

async function collectGoogleNews() {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", "АЗС (пошкоджено OR удар OR закрито OR відновила роботу) Україна when:1d");
  url.searchParams.set("hl", "uk"); url.searchParams.set("gl", "UA"); url.searchParams.set("ceid", "UA:uk");
  const response = await fetchWithRetry(url); if (!response.ok) throw new Error(`Google News RSS HTTP ${response.status}`);
  const xml = await response.text(); const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  return items.flatMap((item) => { try { const sourceUrl = new URL(xmlTag(item, "link")).href; const title = xmlTag(item, "title"); return title ? [{ signalId: stableId("google-news", sourceUrl), sourceId: "google-news-rss", sourceName: xmlTag(item, "source") || "Google News RSS", sourceUrl, title, snippet: xmlTag(item, "description").slice(0, 1200), publishedAt: isoDate(xmlTag(item, "pubDate")), locationText: "Україна", confidence: 0.5, raw: {} }] : []; } catch { return []; } });
}

let signals = await collectGdelt(); let provider = "gdelt-doc";
if (!signals.length) { signals = await collectGoogleNews(); provider = "google-news-rss"; }
if (!signals.length) { console.log(JSON.stringify({ ok: true, provider, submitted: 0, note: "no candidate articles" })); process.exit(0); }
let accepted = 0; let located = 0;
for (let index = 0; index < signals.length; index += 100) {
  const ingest = await fetch(`${apiUrl}/api/fuel/v1/incidents/import`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ signals: signals.slice(index, index + 100) }) });
  if (!ingest.ok) throw new Error(`incident ingest HTTP ${ingest.status}: ${(await ingest.text()).slice(0, 500)}`);
  const result = await ingest.json(); accepted += Number(result.accepted || 0); located += Number(result.located || 0);
}
console.log(JSON.stringify({ ok: true, provider, submitted: signals.length, accepted, located, moderationRequired: true }));
