const apiUrl = String(process.env.RAIL_API_URL || "").replace(/\/$/, "");
const token = process.env.RAIL_INGEST_TOKEN;
if (!apiUrl || !token) throw new Error("RAIL_API_URL and RAIL_INGEST_TOKEN are required");
const apply = String(process.env.FUEL_DEDUPE_APPLY || "").toLowerCase() === "true";
let total = 0;
const cycles = apply ? 8 : 1;
for (let cycle = 0; cycle < cycles; cycle += 1) {
  const response = await fetch(`${apiUrl}/api/fuel/v1/deduplicate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ apply, limit: 200 }) });
  if (!response.ok) throw new Error(`fuel dedupe HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const result = await response.json(); total += Number(result.merged || 0); console.log(JSON.stringify({ cycle: cycle + 1, ...result }));
  if (!result.merged || !result.remainingCandidateMerges) break;
}
console.log(apply ? `Fuel deduplication complete: ${total} stations merged` : "Fuel deduplication dry-run complete; no records changed");
