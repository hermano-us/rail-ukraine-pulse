import { createHash } from "node:crypto";

const apiUrl = String(process.env.RAIL_API_URL || "").replace(/\/$/, "");
const token = process.env.RAIL_INGEST_TOKEN;
if (!apiUrl || !token) throw new Error("RAIL_API_URL and RAIL_INGEST_TOKEN are required");

const query = '("gas station" OR "petrol station" OR "fuel station") (Ukraine OR Ukrainian) (strike OR attack OR damaged OR closed OR reopened)';
const gdeltUrl = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
for (const [key, value] of Object.entries({ query, mode: "artlist", maxrecords: "75", format: "json", timespan: "1d" })) gdeltUrl.searchParams.set(key, value);

function isoDate(value) {
  const raw = String(value || ""); const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}
const stableId = (url) => `gdelt:${createHash("sha256").update(url).digest("hex").slice(0, 40)}`;
const response = await fetch(gdeltUrl, { headers: { Accept: "application/json", "User-Agent": "RailUkrainePulse/1.0 fuel-safety-monitor" } });
if (!response.ok) throw new Error(`GDELT HTTP ${response.status}`);
const payload = await response.json(); const articles = Array.isArray(payload.articles) ? payload.articles : [];
const signals = articles.flatMap((article) => {
  try {
    const sourceUrl = new URL(article.url).href; const title = String(article.title || "").trim(); if (!title) return [];
    return [{ signalId: stableId(sourceUrl), sourceId: "gdelt-doc", sourceName: article.domain || "GDELT DOC 2.0", sourceUrl, title, snippet: "", publishedAt: isoDate(article.seendate), locationText: article.sourcecountry === "Ukraine" ? "Україна" : "", confidence: 0.46, raw: { domain: article.domain, language: article.language, sourceCountry: article.sourcecountry } }];
  } catch { return []; }
});
if (!signals.length) { console.log(JSON.stringify({ ok: true, received: articles.length, submitted: 0, note: "no candidate articles" })); process.exit(0); }
let accepted = 0; let located = 0;
for (let index = 0; index < signals.length; index += 100) {
  const ingest = await fetch(`${apiUrl}/api/fuel/v1/incidents/import`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ signals: signals.slice(index, index + 100) }) });
  if (!ingest.ok) throw new Error(`incident ingest HTTP ${ingest.status}: ${(await ingest.text()).slice(0, 500)}`);
  const result = await ingest.json(); accepted += Number(result.accepted || 0); located += Number(result.located || 0);
}
console.log(JSON.stringify({ ok: true, received: articles.length, submitted: signals.length, accepted, located, moderationRequired: true }));
