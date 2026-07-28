import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mergeOverpassElements } from "./lib/rail-graph-builder.mjs";

const argumentsList = process.argv.slice(2);
const fullGraph = argumentsList.includes("--full");
const outputArgument = argumentsList.find((value) => value.startsWith("--output="));
const outputPath = resolve(outputArgument?.slice("--output=".length) || "data/osm-rail-source.json");
const cacheDirectory = resolve(process.env.RAIL_OSM_CACHE || ".cache/rail-osm");
const endpoint = process.env.OVERPASS_ENDPOINT || "https://overpass-api.de/api/interpreter";
const timeoutSeconds = fullGraph ? 300 : 120;

// Ukraine is queried in bounded tiles. This is substantially more reliable than
// one nationwide Overpass request and lets repeated OSM elements be deduplicated.
const fullGraphTiles = [
  [43.5, 21, 48.2, 28.2], [43.5, 28.2, 48.2, 35.1], [43.5, 35.1, 48.2, 42],
  [48.2, 21, 53.5, 28.2], [48.2, 28.2, 53.5, 35.1], [48.2, 35.1, 53.5, 42],
];
const tiles = fullGraph ? fullGraphTiles : [[43.5, 21, 53.5, 42]];

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function queryForTile([south, west, north, east]) {
  const bbox = `${south},${west},${north},${east}`;
  const stationSelectors = `node(area.ua)["railway"="station"];node(area.ua)["railway"="halt"];node(area.ua)["railway"="junction"];way(area.ua)["railway"="station"];`;
  const trackSelectors = fullGraph ? `way(area.ua)["railway"="rail"];way(area.ua)["railway"="narrow_gauge"];` : "";
  return `[out:json][timeout:${timeoutSeconds}][maxsize:536870912][bbox:${bbox}];area["ISO3166-1"="UA"][admin_level=2]->.ua;(${stationSelectors}${trackSelectors})->.rail;(.rail;>;);out body qt;`;
}
async function fetchTile(tile, index) {
  const cachePath = resolve(cacheDirectory, `v2-${fullGraph ? "full" : "stations"}-${tile.join("_")}.json`);
  try { const cached=JSON.parse(await readFile(cachePath,"utf8"));if(Array.isArray(cached.elements)){console.log(`OSM tile ${index+1}/${tiles.length}: cache ${cached.elements.length} elements`);return cached;} } catch(error) { if(error?.code!=="ENOENT")console.warn(`Ignoring invalid OSM cache: ${error.message}`); }
  let failure;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), (timeoutSeconds + 30) * 1000);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8", "User-Agent":"Rail-Ukraine-Pulse/3.0 (rail graph build)" },
        body: new URLSearchParams({ data:queryForTile(tile) }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!response.ok) { const retryAfter=Number(response.headers.get("retry-after"));const error=new Error(`Overpass HTTP ${response.status}`);error.retryAfterSeconds=Number.isFinite(retryAfter)?retryAfter:null;throw error; }
      const payload = await response.json();
      if (!Array.isArray(payload.elements)) throw new Error("Overpass response has no elements");
      await mkdir(cacheDirectory,{recursive:true});await writeFile(cachePath,`${JSON.stringify(payload)}\n`,"utf8");
      console.log(`OSM tile ${index + 1}/${tiles.length}: ${payload.elements.length} elements`);
      return payload;
    } catch (error) {
      failure = error;
      if (attempt < 6) await sleep(Math.min(120_000, Math.max((error.retryAfterSeconds||0)*1000, 2500 * 2 ** (attempt - 1))));
    }
  }
  throw new Error(`OSM tile ${index + 1} failed: ${failure?.message || failure}`);
}
const collections = [];
for (const [index, tile] of tiles.entries()) { collections.push(await fetchTile(tile, index)); if(index<tiles.length-1)await sleep(2500); }
const elements = mergeOverpassElements(collections);
const snapshot = {
  schemaVersion: 1,
  source: "OpenStreetMap via Overpass API",
  endpoint,
  mode: fullGraph ? "full-rail-graph" : "station-registry",
  generatedAt: new Date().toISOString(),
  attribution: "© OpenStreetMap contributors, ODbL",
  elements,
};
await mkdir(dirname(outputPath), { recursive:true });
await writeFile(outputPath, `${JSON.stringify(snapshot)}\n`, "utf8");
console.log(`OSM rail source written: ${outputPath} (${elements.length} unique elements)`);
