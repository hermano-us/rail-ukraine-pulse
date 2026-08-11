const rows = (result) => result?.results || [];
const assetUrl = (path) => new Request(new URL(path, "https://rail-reference.local"));

const reverseGeometry = (geometry) => geometry?.type === "LineString" && Array.isArray(geometry.coordinates)
  ? { ...geometry, coordinates:[...geometry.coordinates].reverse() }
  : geometry;

const ageMinutes = (value, now) => Number.isFinite(Date.parse(value))
  ? Math.max(0, (Date.parse(now) - Date.parse(value)) / 60_000)
  : null;

export function analyzeRailTopology(edges = [], stationCount = 0, { anomalousSegmentKm = 250 } = {}) {
  const adjacency = new Map(); let anomalousSegments = 0; let maximumSegmentKm = 0;
  for (const raw of edges) {
    const edge=Array.isArray(raw)?{from:raw[0],to:raw[1],distanceKm:raw[2]}:raw||{},from=edge.from,to=edge.to,rawDistance=edge.distanceKm??edge.distance;
    if (!from || !to || from === to) continue;
    const distance = Number(rawDistance) || 0; maximumSegmentKm = Math.max(maximumSegmentKm, distance);
    if (distance > anomalousSegmentKm) anomalousSegments += 1;
    if (!adjacency.has(from)) adjacency.set(from, new Set()); if (!adjacency.has(to)) adjacency.set(to, new Set());
    adjacency.get(from).add(to); adjacency.get(to).add(from);
  }
  const visited = new Set(); const componentSizes = [];
  for (const node of adjacency.keys()) {
    if (visited.has(node)) continue;
    const queue = [node]; visited.add(node); let size = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]; size += 1;
      for (const neighbor of adjacency.get(current) || []) if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
    }
    componentSizes.push(size);
  }
  componentSizes.sort((left, right) => right - left);
  const isolatedStations = Math.max(0, Number(stationCount || 0) - adjacency.size);
  const terminalNodes = [...adjacency.values()].filter((neighbors) => neighbors.size === 1).length;
  const largest = componentSizes[0] || 0; const coverage = stationCount ? adjacency.size / stationCount : 0;
  const healthStatus = coverage < .75 || largest < adjacency.size * .8 ? "degraded" : anomalousSegments ? "warning" : "healthy";
  return { healthStatus, connectedComponents:componentSizes.length, largestComponentNodes:largest, topologyNodes:adjacency.size, isolatedStations, terminalNodes, anomalousSegments, maximumSegmentKm:Number(maximumSegmentKm.toFixed(2)), componentSizes:componentSizes.slice(0,20) };
}

export function graphImportTelemetry(state = {}, manifest = {}, now = new Date().toISOString()) {
  const stationChunks = manifest.stationChunks?.length || 0, segmentChunks = manifest.segmentChunks?.length || 0, totalChunks = stationChunks + segmentChunks;
  const completedChunks = Math.min(stationChunks, Number(state.next_station_chunk)||0) + Math.min(segmentChunks, Number(state.next_segment_chunk)||0);
  const startedAt = state.first_attempt_at || state.last_progress_at || state.last_attempt_at || now;
  const elapsedHours = Math.max(1 / 60, (Date.parse(now) - Date.parse(startedAt)) / 3_600_000);
  const chunksPerHour = completedChunks ? completedChunks / elapsedHours : 0;
  const remainingChunks = Math.max(0, totalChunks - completedChunks);
  const etaMinutes = chunksPerHour > 0 ? Math.ceil(remainingChunks / chunksPerHour * 60) : null;
  return { completedChunks,totalChunks,progress:totalChunks?completedChunks/totalChunks:0,chunksPerHour:Number(chunksPerHour.toFixed(2)),etaMinutes,estimatedCompletionAt:etaMinutes==null?null:new Date(Date.parse(now)+etaMinutes*60_000).toISOString(),stalled:completedChunks<totalChunks&&(ageMinutes(state.last_progress_at||state.last_attempt_at,now)??0)>=20 };
}
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
    for (const alias of station.aliases || []) if (alias.type === "ref" && alias.value) statements.push(env.DB.prepare(`INSERT INTO station_codes(code_type,code_value,station_id,source,confidence,verified,updated_at)
      VALUES('osm_ref',?1,?2,?3,?4,0,?5) ON CONFLICT(code_type,code_value) DO UPDATE SET station_id=excluded.station_id,source=excluded.source,confidence=excluded.confidence,updated_at=excluded.updated_at`)
      .bind(String(alias.value).trim(),station.stationId,alias.source||"openstreetmap",Number(alias.confidence)||.8,now));
  }
  return statements;
}

function segmentStatements(env, versionId, segments, now, active = 0) {
  const statements = [];
  for (const segment of segments) {
    const directions = segment.bidirectional === false ? [[segment.fromStationId,segment.toStationId,segment.geometry]] : [
      [segment.fromStationId,segment.toStationId,segment.geometry],
      [segment.toStationId,segment.fromStationId,reverseGeometry(segment.geometry)],
    ];
    for (const [from,to,geometry] of directions) statements.push(env.DB.prepare(`INSERT INTO rail_segment_geometries(segment_id,version_id,from_station_id,to_station_id,geometry_json,distance_km,railway_type,usage_type,track_count,electrified,source_way_ids_json,geometry_quality,active,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
      ON CONFLICT(segment_id) DO UPDATE SET geometry_json=excluded.geometry_json,distance_km=excluded.distance_km,railway_type=excluded.railway_type,usage_type=excluded.usage_type,track_count=excluded.track_count,electrified=excluded.electrified,source_way_ids_json=excluded.source_way_ids_json,geometry_quality=excluded.geometry_quality,active=excluded.active,updated_at=excluded.updated_at`)
      .bind(`${versionId}:${from}>${to}`,versionId,from,to,JSON.stringify(geometry),Number(segment.distanceKm)||0,segment.railwayType||"rail",segment.usageType||null,Number.isFinite(Number(segment.trackCount))?Number(segment.trackCount):null,segment.electrified||null,JSON.stringify(segment.sourceWayIds||[]),Number(segment.geometryQuality)||0,active?1:0,now));
  }
  return statements;
}

export async function syncRailGraphReference(env, now = new Date().toISOString(), limits = {}) {
  if (!env.ASSETS?.fetch) return { status:"disabled", reason:"assets-binding-unavailable" };
  const stationChunksPerCycle = Math.max(1, Number(limits.stationChunks)||12);
  const segmentChunksPerCycle = Math.max(1, Number(limits.segmentChunks)||4);
  const manifest = await fetchAssetJson(env, "manifest.json");
  if (!manifest?.versionId || !Array.isArray(manifest.stationChunks) || !Array.isArray(manifest.segmentChunks)) throw new Error("invalid rail graph manifest");

  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO rail_graph_versions(version_id,source,source_generated_at,checksum,status,station_count,segment_count,alias_conflict_count,unmatched_station_count,created_at)
      VALUES(?1,?2,?3,?4,'importing',?5,?6,?7,?8,?9)`).bind(manifest.versionId,manifest.source||"OpenStreetMap",manifest.sourceGeneratedAt||null,manifest.checksum,Number(manifest.stationCount)||0,Number(manifest.segmentCount)||0,Number(manifest.aliasConflictCount)||0,Number(manifest.unmatchedStationCount)||0,now),
    env.DB.prepare("INSERT OR IGNORE INTO rail_graph_import_state(version_id,last_attempt_at,first_attempt_at,last_progress_at) VALUES(?1,?2,?2,?2)").bind(manifest.versionId,now),
  ]);
  let state = await env.DB.prepare("SELECT * FROM rail_graph_import_state WHERE version_id=?1").bind(manifest.versionId).first();
  if (state?.finished_at) return { status:"active", versionId:manifest.versionId, ...graphImportTelemetry(state,manifest,now) };
  const activeVersion = await env.DB.prepare("SELECT version_id FROM rail_graph_versions WHERE status='active' ORDER BY activated_at DESC LIMIT 1").first();
  const progressiveActive = !activeVersion || activeVersion.version_id === manifest.versionId;

  const before = graphImportTelemetry(state,manifest,now); const recovered = before.stalled;
  await env.DB.prepare(`UPDATE rail_graph_import_state SET last_attempt_at=?1,first_attempt_at=COALESCE(first_attempt_at,?1),attempt_count=attempt_count+1,
    recovery_count=recovery_count+?2 WHERE version_id=?3`).bind(now,recovered?1:0,manifest.versionId).run();

  let nextStation = Number(state?.next_station_chunk)||0;
  let nextSegment = Number(state?.next_segment_chunk)||0;
  try {
    for (let count=0; count<stationChunksPerCycle && nextStation<manifest.stationChunks.length; count+=1) {
      const chunk = await fetchAssetJson(env, manifest.stationChunks[nextStation]);
      if (chunk?.versionId !== manifest.versionId) throw new Error("rail station chunk version mismatch");
      await batch(env, stationStatements(env,manifest.versionId,chunk.stations||[],now)); nextStation += 1;
      await env.DB.batch([
        env.DB.prepare("UPDATE rail_graph_import_state SET next_station_chunk=?1,last_attempt_at=?2,last_progress_at=?2,consecutive_failures=0,error=NULL WHERE version_id=?3").bind(nextStation,now,manifest.versionId),
        env.DB.prepare("UPDATE rail_graph_versions SET imported_stations=MIN(station_count,?1),error=NULL WHERE version_id=?2").bind(nextStation*Number(manifest.stationChunkSize||125),manifest.versionId),
      ]);
    }
    const knownStations = new Set(rows(await env.DB.prepare("SELECT station_id FROM station_registry WHERE source_version=?1").bind(manifest.versionId).all()).map((item) => item.station_id));
    for (let count=0; count<segmentChunksPerCycle && nextSegment<manifest.segmentChunks.length; count+=1) {
      const chunk = await fetchAssetJson(env, manifest.segmentChunks[nextSegment]);
      if (chunk?.versionId !== manifest.versionId) throw new Error("rail segment chunk version mismatch");
      const chunkSegments = chunk.segments || [];
      const importableSegments = chunkSegments.filter((segment) => knownStations.has(segment.fromStationId) && knownStations.has(segment.toStationId));
      if (importableSegments.length) await batch(env, segmentStatements(env,manifest.versionId,importableSegments,now,progressiveActive));
      if (importableSegments.length < chunkSegments.length) break;
      nextSegment += 1;
      await env.DB.batch([
        env.DB.prepare("UPDATE rail_graph_import_state SET next_segment_chunk=?1,last_attempt_at=?2,last_progress_at=?2,consecutive_failures=0,error=NULL WHERE version_id=?3").bind(nextSegment,now,manifest.versionId),
        env.DB.prepare("UPDATE rail_graph_versions SET imported_segments=MIN(segment_count,?1),error=NULL WHERE version_id=?2").bind(nextSegment*Number(manifest.segmentChunkSize||125),manifest.versionId),
      ]);
    }

    const complete = nextStation>=manifest.stationChunks.length && nextSegment>=manifest.segmentChunks.length;
    if (complete) {
      const topology = await fetchAssetJson(env, manifest.topologyFile||"topology.json");
      const diagnostics = analyzeRailTopology(topology?.edges||[],manifest.stationCount);
      await env.DB.batch([
        env.DB.prepare("UPDATE rail_segment_geometries SET active=0 WHERE active=1 AND version_id!=?1").bind(manifest.versionId),
        env.DB.prepare("UPDATE rail_segment_geometries SET active=1 WHERE version_id=?1").bind(manifest.versionId),
        env.DB.prepare("DELETE FROM station_aliases WHERE source_version IS NOT NULL AND source_version!=?1").bind(manifest.versionId),
        env.DB.prepare("DELETE FROM rail_route_cache WHERE version_id!=?1").bind(manifest.versionId),
        env.DB.prepare("UPDATE rail_graph_versions SET status='superseded' WHERE status='active' AND version_id!=?1").bind(manifest.versionId),
        env.DB.prepare("UPDATE rail_graph_versions SET status='active',imported_stations=station_count,imported_segments=segment_count,activated_at=?1,error=NULL WHERE version_id=?2").bind(now,manifest.versionId),
        env.DB.prepare("UPDATE rail_graph_import_state SET finished_at=?1,last_attempt_at=?1,last_progress_at=?1,estimated_completion_at=?1,consecutive_failures=0,error=NULL WHERE version_id=?2").bind(now,manifest.versionId),
        env.DB.prepare(`INSERT INTO rail_graph_diagnostics(version_id,health_status,connected_components,largest_component_nodes,topology_nodes,isolated_stations,terminal_nodes,anomalous_segments,maximum_segment_km,details_json,calculated_at)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(version_id) DO UPDATE SET health_status=excluded.health_status,connected_components=excluded.connected_components,largest_component_nodes=excluded.largest_component_nodes,topology_nodes=excluded.topology_nodes,isolated_stations=excluded.isolated_stations,terminal_nodes=excluded.terminal_nodes,anomalous_segments=excluded.anomalous_segments,maximum_segment_km=excluded.maximum_segment_km,details_json=excluded.details_json,calculated_at=excluded.calculated_at`)
          .bind(manifest.versionId,diagnostics.healthStatus,diagnostics.connectedComponents,diagnostics.largestComponentNodes,diagnostics.topologyNodes,diagnostics.isolatedStations,diagnostics.terminalNodes,diagnostics.anomalousSegments,diagnostics.maximumSegmentKm,JSON.stringify({componentSizes:diagnostics.componentSizes}),now),
      ]);
      await env.DB.prepare(`INSERT OR IGNORE INTO rail_route_rebuild_queue(queue_id,version_id,from_station_id,to_station_id,run_id,priority,reason,queued_at)
        SELECT ?1||':'||anchor_node_id||'>'||next_node_id,?1,anchor_node_id,next_node_id,run_id,
          CASE WHEN position_status IN ('confirmed','reported') THEN 90 ELSE 60 END,'graph-version-activated',?2
        FROM twin_states WHERE anchor_node_id IS NOT NULL AND next_node_id IS NOT NULL AND anchor_node_id!=next_node_id`)
        .bind(manifest.versionId,now).run();
      return { status:"activated",versionId:manifest.versionId,recovered,diagnostics,...graphImportTelemetry({ ...state,next_station_chunk:nextStation,next_segment_chunk:nextSegment,finished_at:now,last_progress_at:now },manifest,now) };
    }
    state = { ...state,next_station_chunk:nextStation,next_segment_chunk:nextSegment,last_progress_at:now };
    const telemetry = graphImportTelemetry(state,manifest,now);
    await env.DB.prepare("UPDATE rail_graph_import_state SET estimated_completion_at=?1 WHERE version_id=?2").bind(telemetry.estimatedCompletionAt,manifest.versionId).run();
    return { status:"importing",versionId:manifest.versionId,recovered,...telemetry };
  } catch (error) {
    const message = String(error?.message||error).slice(0,300);
    await env.DB.batch([
      env.DB.prepare("UPDATE rail_graph_import_state SET consecutive_failures=consecutive_failures+1,error=?1,last_attempt_at=?2 WHERE version_id=?3").bind(message,now,manifest.versionId),
      env.DB.prepare("UPDATE rail_graph_versions SET error=?1 WHERE version_id=?2").bind(message,manifest.versionId),
    ]);
    return { status:"degraded",versionId:manifest.versionId,error:message,recovered,...graphImportTelemetry({ ...state,next_station_chunk:nextStation,next_segment_chunk:nextSegment },manifest,now) };
  }
}
export async function loadStationAliasMap(env) {
  const aliases = rows(await env.DB.prepare("SELECT alias_key,station_id FROM station_aliases").all());
  return new Map(aliases.map((item) => [item.alias_key,item.station_id]));
}
