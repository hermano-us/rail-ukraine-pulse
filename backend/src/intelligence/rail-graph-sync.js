const rows = (result) => result?.results || [];
const assetUrl = (path) => new Request(new URL(path, "https://rail-reference.local"));

const reverseGeometry = (geometry) => geometry?.type === "LineString" && Array.isArray(geometry.coordinates)
  ? { ...geometry, coordinates:[...geometry.coordinates].reverse() }
  : geometry;

async function fetchAssetJson(env, name) {
  if (!env.ASSETS?.fetch) return null;
  const response = await env.ASSETS.fetch(assetUrl(`/data/rail-reference/${name}`));
  if (!response.ok) throw new Error(`rail graph asset ${name}: HTTP ${response.status}`);
  return response.json();
}

async function batch(env, statements, size = 75) {
  for (let index = 0; index < statements.length; index += size) await env.DB.batch(statements.slice(index, index + size));
}

function stationStatements(env, versionId, stations, now) {
  const statements = [];
  for (const station of stations) {
    const [longitude, latitude] = station.coordinates || [];
    statements.push(env.DB.prepare(`INSERT INTO station_registry(station_id,official_name,station_type,latitude,longitude,osm_type,osm_id,graph_node_id,match_method,match_confidence,source_version,metadata_json,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
      ON CONFLICT(station_id) DO UPDATE SET official_name=excluded.official_name,station_type=excluded.station_type,latitude=excluded.latitude,longitude=excluded.longitude,osm_type=excluded.osm_type,osm_id=excluded.osm_id,graph_node_id=excluded.graph_node_id,match_method=excluded.match_method,match_confidence=excluded.match_confidence,source_version=excluded.source_version,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
      .bind(station.stationId,station.officialName,station.stationType||"station",Number.isFinite(latitude)?latitude:null,Number.isFinite(longitude)?longitude:null,station.osmType||null,station.osmId||null,station.graphNodeId||null,station.matchMethod||"openstreetmap",Number(station.matchConfidence)||0,versionId,JSON.stringify(station.metadata||{}),now));
    for (const alias of station.aliases || []) statements.push(env.DB.prepare(`INSERT INTO station_aliases(alias_key,station_id,alias,language,alias_type,source,confidence,source_version,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(alias_key) DO UPDATE SET station_id=excluded.station_id,alias=excluded.alias,language=excluded.language,alias_type=excluded.alias_type,source=excluded.source,confidence=excluded.confidence,source_version=excluded.source_version,updated_at=excluded.updated_at`)
      .bind(alias.key,station.stationId,alias.value,alias.language||null,alias.type||"name",alias.source||"openstreetmap",Number(alias.confidence)||0,versionId,now));
  }
  return statements;
}

function segmentStatements(env, versionId, segments, now) {
  const statements = [];
  for (const segment of segments) {
    const directions = segment.bidirectional === false ? [[segment.fromStationId,segment.toStationId,segment.geometry]] : [
      [segment.fromStationId,segment.toStationId,segment.geometry],
      [segment.toStationId,segment.fromStationId,reverseGeometry(segment.geometry)],
    ];
    for (const [from,to,geometry] of directions) statements.push(env.DB.prepare(`INSERT INTO rail_segment_geometries(segment_id,version_id,from_station_id,to_station_id,geometry_json,distance_km,railway_type,usage_type,track_count,electrified,source_way_ids_json,geometry_quality,active,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13)
      ON CONFLICT(segment_id) DO UPDATE SET geometry_json=excluded.geometry_json,distance_km=excluded.distance_km,railway_type=excluded.railway_type,usage_type=excluded.usage_type,track_count=excluded.track_count,electrified=excluded.electrified,source_way_ids_json=excluded.source_way_ids_json,geometry_quality=excluded.geometry_quality,updated_at=excluded.updated_at`)
      .bind(`${versionId}:${from}>${to}`,versionId,from,to,JSON.stringify(geometry),Number(segment.distanceKm)||0,segment.railwayType||"rail",segment.usageType||null,Number.isFinite(Number(segment.trackCount))?Number(segment.trackCount):null,segment.electrified||null,JSON.stringify(segment.sourceWayIds||[]),Number(segment.geometryQuality)||0,now));
  }
  return statements;
}

export async function syncRailGraphReference(env, now = new Date().toISOString(), limits = {}) {
  if (!env.ASSETS?.fetch) return { status:"disabled", reason:"assets-binding-unavailable" };
  const stationChunksPerCycle = Math.max(1, Number(limits.stationChunks)||1);
  const segmentChunksPerCycle = Math.max(1, Number(limits.segmentChunks)||2);
  const manifest = await fetchAssetJson(env, "manifest.json");
  if (!manifest?.versionId || !Array.isArray(manifest.stationChunks) || !Array.isArray(manifest.segmentChunks)) throw new Error("invalid rail graph manifest");

  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO rail_graph_versions(version_id,source,source_generated_at,checksum,status,station_count,segment_count,alias_conflict_count,unmatched_station_count,created_at)
      VALUES(?1,?2,?3,?4,'importing',?5,?6,?7,?8,?9)`).bind(manifest.versionId,manifest.source||"OpenStreetMap",manifest.sourceGeneratedAt||null,manifest.checksum,Number(manifest.stationCount)||0,Number(manifest.segmentCount)||0,Number(manifest.aliasConflictCount)||0,Number(manifest.unmatchedStationCount)||0,now),
    env.DB.prepare("INSERT OR IGNORE INTO rail_graph_import_state(version_id,last_attempt_at) VALUES(?1,?2)").bind(manifest.versionId,now),
  ]);
  const state = await env.DB.prepare("SELECT * FROM rail_graph_import_state WHERE version_id=?1").bind(manifest.versionId).first();
  if (state?.finished_at) return { status:"active", versionId:manifest.versionId, progress:1 };

  let nextStation = Number(state?.next_station_chunk)||0;
  let nextSegment = Number(state?.next_segment_chunk)||0;
  for (let count=0; count<stationChunksPerCycle && nextStation<manifest.stationChunks.length; count+=1) {
    const chunk = await fetchAssetJson(env, manifest.stationChunks[nextStation]);
    if (chunk?.versionId !== manifest.versionId) throw new Error("rail station chunk version mismatch");
    await batch(env, stationStatements(env,manifest.versionId,chunk.stations||[],now));
    nextStation += 1;
    await env.DB.batch([
      env.DB.prepare("UPDATE rail_graph_import_state SET next_station_chunk=?1,last_attempt_at=?2,error=NULL WHERE version_id=?3").bind(nextStation,now,manifest.versionId),
      env.DB.prepare("UPDATE rail_graph_versions SET imported_stations=MIN(station_count,?1),error=NULL WHERE version_id=?2").bind(nextStation*Number(manifest.stationChunkSize||125),manifest.versionId),
    ]);
  }
  if (nextStation >= manifest.stationChunks.length) for (let count=0; count<segmentChunksPerCycle && nextSegment<manifest.segmentChunks.length; count+=1) {
    const chunk = await fetchAssetJson(env, manifest.segmentChunks[nextSegment]);
    if (chunk?.versionId !== manifest.versionId) throw new Error("rail segment chunk version mismatch");
    await batch(env, segmentStatements(env,manifest.versionId,chunk.segments||[],now));
    nextSegment += 1;
    await env.DB.batch([
      env.DB.prepare("UPDATE rail_graph_import_state SET next_segment_chunk=?1,last_attempt_at=?2,error=NULL WHERE version_id=?3").bind(nextSegment,now,manifest.versionId),
      env.DB.prepare("UPDATE rail_graph_versions SET imported_segments=MIN(segment_count,?1),error=NULL WHERE version_id=?2").bind(nextSegment*Number(manifest.segmentChunkSize||125),manifest.versionId),
    ]);
  }

  const complete = nextStation>=manifest.stationChunks.length && nextSegment>=manifest.segmentChunks.length;
  if (complete) await env.DB.batch([
    env.DB.prepare("UPDATE rail_segment_geometries SET active=0 WHERE active=1 AND version_id!=?1").bind(manifest.versionId),
    env.DB.prepare("UPDATE rail_segment_geometries SET active=1 WHERE version_id=?1").bind(manifest.versionId),
    env.DB.prepare("DELETE FROM station_aliases WHERE source_version IS NOT NULL AND source_version!=?1").bind(manifest.versionId),
    env.DB.prepare("UPDATE rail_graph_versions SET status='superseded' WHERE status='active' AND version_id!=?1").bind(manifest.versionId),
    env.DB.prepare("UPDATE rail_graph_versions SET status='active',imported_stations=station_count,imported_segments=segment_count,activated_at=?1,error=NULL WHERE version_id=?2").bind(now,manifest.versionId),
    env.DB.prepare("UPDATE rail_graph_import_state SET finished_at=?1,last_attempt_at=?1,error=NULL WHERE version_id=?2").bind(now,manifest.versionId),
  ]);
  const total = manifest.stationChunks.length + manifest.segmentChunks.length;
  return { status:complete?"activated":"importing",versionId:manifest.versionId,stationChunksImported:nextStation,segmentChunksImported:nextSegment,progress:Number(((nextStation+nextSegment)/Math.max(1,total)).toFixed(4)) };
}

export async function loadStationAliasMap(env) {
  const aliases = rows(await env.DB.prepare("SELECT alias_key,station_id FROM station_aliases").all());
  return new Map(aliases.map((item) => [item.alias_key,item.station_id]));
}
