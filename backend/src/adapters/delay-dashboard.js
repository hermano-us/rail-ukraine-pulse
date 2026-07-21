const DASHBOARD_URL = "https://uz-vezemo.uz.gov.ua/delayform/";

function decodeHtml(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&rarr;|&rightarrow;|&#8594;/gi, "→")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#8470;|&numero;/gi, "№")
    .replace(/\s+/g, " ")
    .trim();
}

function delayMinutes(label = "") {
  const clock = label.match(/\+?\s*(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (clock && Number(clock[2]) < 60) return Math.min(1440, Number(clock[1]) * 60 + Number(clock[2]));
  const minutes = label.match(/\+?\s*(\d{1,4})\s*(?:хв|мин)/iu);
  return minutes ? Math.min(1440, Number(minutes[1])) : null;
}

function operationFromStatus(status = "") {
  const value = status.toLocaleLowerCase("uk");
  if (/скас|не курс|відмін|отмен/iu.test(value)) return "source-unavailable";
  if (/станц|очіку|відправ|готов|прибув|прибыл/iu.test(value)) return "station";
  return "moving";
}

export function parseEdgeDelayDashboard(html, observedAt = new Date().toISOString()) {
  const updates = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => decodeHtml(match[1]));
    if (cells.length < 3) continue;
    const number = cells[0].match(/(?:№\s*)?(\d{1,4}(?:\s*\/\s*\d{1,4})?)/u)?.[1]?.replace(/\s/g, "");
    if (!number) continue;
    const route = cells[1] || "";
    const routeParts = route.split(/\s*(?:→|—|–)\s*/u);
    const delayLabel = cells.find((cell) => /^\+?\s*\d+(?::\d{2}|\s*(?:хв|мин))/iu.test(cell)) || cells[2] || "";
    const status = cells[3] || "В дорозі";
    updates.push({
      trainNumber: number,
      route,
      origin: routeParts[0] || "",
      destination: routeParts.length > 1 ? routeParts.slice(1).join(" — ") : "",
      delayMinutes: delayMinutes(delayLabel),
      delayLabel,
      publicStatus: status,
      operationalStatus: operationFromStatus(status),
      forecastDeparture: cells[4] && cells[4] !== "—" ? cells[4] : null,
      forecastArrival: cells[5] && cells[5] !== "—" ? cells[5] : null,
      reliability: cells[6] || "Официальный публичный источник",
      reason: cells[7] || null,
      updatedAt: observedAt,
      source: DASHBOARD_URL,
      sourceId: "uz-delay-dashboard",
      sourceEvidence: "official-public-dashboard-edge",
      positionEvidence: "none",
    });
  }
  return updates;
}

export { DASHBOARD_URL };
