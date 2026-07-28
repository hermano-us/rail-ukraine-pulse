import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildRailGraph, buildStationRegistry } from "./lib/rail-graph-builder.mjs";

const argumentsList = process.argv.slice(2);
const option = (name, fallback) => resolve(argumentsList.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback);
const sourcePath = option("source", "data/osm-rail-source.json");
const reviewedPath = option("reviewed", "data/stations.json");
const stationOutputPath = option("station-output", "data/station-registry.json");
const graphOutputPath = option("graph-output", "data/rail-intelligence-graph.json");
const referenceOutputPath = option("reference-output", "data/rail-reference");
const stationChunkSize = 125;
const segmentChunkSize = 125;
const chunks = (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
const chunkName = (kind, index) => `${kind}-${String(index).padStart(3, "0")}.json`;

const reviewed = JSON.parse(await readFile(reviewedPath, "utf8"));
let osm = { elements:[], generatedAt:null, source:"reviewed station snapshot" };
try { osm = JSON.parse(await readFile(sourcePath, "utf8")); }
catch (error) { if (error?.code !== "ENOENT") throw error; }

const registry = buildStationRegistry({ reviewedStations:reviewed.stations || [], osmElements:osm.elements || [] });
const sourceDigest = createHash("sha256").update(JSON.stringify(osm.elements || [])).digest("hex");
const versionDate = String(osm.generatedAt || reviewed.generatedAt || new Date().toISOString()).slice(0,10).replaceAll("-", "");
const versionId = `osm-${versionDate}-${sourceDigest.slice(0,12)}`;
const generatedAt = new Date().toISOString();

const stationAsset = {
  schemaVersion: 2,
  versionId,
  generatedAt,
  source: osm.source,
  attribution: osm.attribution || "© OpenStreetMap contributors, ODbL",
  stations: registry.stations.map((station) => ({
    stationId:station.stationId,
    officialName:station.officialName,
    stationType:station.stationType,
    coordinates:station.coordinates,
    osmType:station.osmType,
    osmId:station.osmId,
    graphNodeId:station.graphNodeId,
    matchMethod:station.matchMethod,
    matchConfidence:Number(station.matchConfidence.toFixed(3)),
    aliases:station.aliases,
    metadata:station.metadata,
  })),
  conflicts:registry.conflicts,
};
const hasRailWays = (osm.elements || []).some((element) => element.type === "way" && ["rail", "narrow_gauge"].includes(element.tags?.railway));
if (hasRailWays) {
  const graph = buildRailGraph({ osmElements:osm.elements, registry });
  stationAsset.stations = registry.stations.map((station) => ({
    stationId:station.stationId, officialName:station.officialName, stationType:station.stationType,
    coordinates:station.coordinates, osmType:station.osmType, osmId:station.osmId,
    graphNodeId:station.graphNodeId, matchMethod:station.matchMethod,
    matchConfidence:Number(station.matchConfidence.toFixed(3)), aliases:station.aliases, metadata:station.metadata,
  }));
  const graphAsset = {
    schemaVersion: 1,
    versionId,
    generatedAt,
    source:osm.source,
    sourceGeneratedAt:osm.generatedAt,
    attribution:osm.attribution || "© OpenStreetMap contributors, ODbL",
    checksum:sourceDigest,
    stats:graph.stats,
    unmatchedStations:graph.unmatchedStations,
    stations:graph.stations.map((station) => ({ stationId:station.stationId,graphNodeId:station.graphNodeId,metadata:station.metadata })),
    segments:graph.segments,
  };
  await writeFile(stationOutputPath, `${JSON.stringify(stationAsset, null, 2)}\n`, "utf8");
  await writeFile(graphOutputPath, `${JSON.stringify(graphAsset)}\n`, "utf8");
  await rm(referenceOutputPath, { recursive:true, force:true });
  await mkdir(referenceOutputPath, { recursive:true });
  const stationChunks = chunks(stationAsset.stations, stationChunkSize);
  const segmentChunks = chunks(graphAsset.segments, segmentChunkSize);
  for (const [index, stations] of stationChunks.entries()) await writeFile(resolve(referenceOutputPath, chunkName("stations", index)), `${JSON.stringify({ versionId, stations })}\n`, "utf8");
  for (const [index, segments] of segmentChunks.entries()) await writeFile(resolve(referenceOutputPath, chunkName("segments", index)), `${JSON.stringify({ versionId, segments })}\n`, "utf8");
  const topologyFile = "topology.json";
  await writeFile(resolve(referenceOutputPath, topologyFile), `${JSON.stringify({
    schemaVersion:1, versionId,
    edges:graphAsset.segments.map((segment)=>[segment.fromStationId,segment.toStationId,segment.distanceKm]),
  })}\n`, "utf8");
  const manifest = {
    schemaVersion:1, versionId, generatedAt, source:osm.source, sourceGeneratedAt:osm.generatedAt,
    attribution:graphAsset.attribution, checksum:sourceDigest,
    stationCount:stationAsset.stations.length, segmentCount:graphAsset.segments.length,
    aliasConflictCount:stationAsset.conflicts.length, unmatchedStationCount:graph.unmatchedStations.length,
    stationChunkSize, segmentChunkSize, topologyFile,
    stationChunks:stationChunks.map((_, index) => chunkName("stations", index)),
    segmentChunks:segmentChunks.map((_, index) => chunkName("segments", index)),
  };
  await writeFile(resolve(referenceOutputPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Station registry: ${stationAsset.stations.length} stations, ${stationAsset.conflicts.length} ambiguous aliases`);
  console.log(`Rail graph: ${graph.stats.segments} exact station segments (${graph.stats.matchedStations} snapped stations)`);
  console.log(`Reference snapshot: ${stationChunks.length} station chunks, ${segmentChunks.length} segment chunks`);
} else {
  await writeFile(stationOutputPath, `${JSON.stringify(stationAsset, null, 2)}\n`, "utf8");
  console.log(`Station registry: ${stationAsset.stations.length} stations, ${stationAsset.conflicts.length} ambiguous aliases`);
  console.log("Rail graph was not generated: source contains stations only. Run fetch-osm-rail-graph.mjs --full first.");
}
