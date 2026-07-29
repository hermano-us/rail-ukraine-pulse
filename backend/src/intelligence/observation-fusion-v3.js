const rows = (result) => result?.results || [];
const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const normalize = (value) => String(value || "").normalize("NFKC")
  .toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const trainKey = (value) => normalize(value).replace(/-/g, "");
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value || "") ?? fallback; } catch { return fallback; } };
const authorityWeight = (authority) => authority === "official" ? 1 : authority === "operator" ? .97 : authority === "reference" ? .72 : .62;
const sourceDomain = (sourceId = "") => {
  const value = normalize(sourceId);
  if (value.includes("uz-public") || value.includes("official-board")) return "uz-official";
  if (value.includes("trusted-collector") || value.includes("station-edge")) return "trusted-board";
  if (value.includes("telegram") || value.includes("freight-tg") || value.startsWith("tg-")) return "telegram";
  if (value.includes("operator") || value.includes("operations-hub")) return "operator";
  return value || "unknown";
};
const directionKey = (event) => [event.origin, event.destination].map(normalize).filter(Boolean).join(">") || normalize(event.route);

function weightedTime(members) {
  const values = members.map((event) => ({
    time: Date.parse(event.occurred_at),
    weight: Math.max(.05, clamp(event.reliability) * authorityWeight(event.authority)),
  })).filter((item) => Number.isFinite(item.time)).sort((left, right) => left.time - right.time);
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  let accumulated = 0;
  for (const item of values) {
    accumulated += item.weight;
    if (accumulated >= total / 2) return new Date(item.time).toISOString();
  }
  return values.length ? new Date(values.at(-1).time).toISOString() : null;
}

export function fuseObservationRowsV4(events = [], {
  windowMinutes = 20,
  canonicalStation = (value) => normalize(value),
} = {}) {
  const ordered = [...events].filter((event) => event?.train_number && event?.station
    && Number.isFinite(Date.parse(event.occurred_at)))
    .map((event) => {
      const raw = parseJson(event.raw_update_json);
      return {
        ...event,
        stationId: canonicalStation(event.station) || normalize(event.station),
        direction: directionKey({ ...raw, ...event }),
        locomotive: normalize(raw.locomotive || raw.locomotiveNumber),
        boardType: raw.boardType || null,
      };
    }).sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
  const groups = [];
  for (const event of ordered) {
    const key = `${trainKey(event.train_number)}:${event.stationId}`;
    const group = groups.findLast((candidate) => candidate.key === key
      && Date.parse(event.occurred_at) - Date.parse(candidate.windowEnd) <= windowMinutes * 60_000);
    if (group) {
      group.members.push(event);
      group.windowEnd = event.occurred_at;
    } else {
      groups.push({
        key, trainNumber: event.train_number, station: event.station,
        stationId: event.stationId, windowStart: event.occurred_at,
        windowEnd: event.occurred_at, members: [event],
      });
    }
  }
  return groups.map((group) => {
    const sourceBest = new Map(), domainBest = new Map();
    for (const member of group.members) {
      const weighted = clamp(member.reliability) * authorityWeight(member.authority);
      if (weighted > (sourceBest.get(member.source_id) || 0)) sourceBest.set(member.source_id, weighted);
      const domain = sourceDomain(member.source_id);
      if (weighted > (domainBest.get(domain) || 0)) domainBest.set(domain, weighted);
    }
    const sourceIds = [...sourceBest.keys()], sourceDomains = [...domainBest.keys()];
    const effectiveReliability = 1 - [...domainBest.values()].reduce((product, value) => product * (1 - Math.min(.96, value)), 1);
    const directions = [...new Set(group.members.map((event) => event.direction).filter(Boolean))];
    const locomotives = [...new Set(group.members.map((event) => event.locomotive).filter(Boolean))];
    const boardTypes = [...new Set(group.members.map((event) => event.boardType).filter(Boolean))];
    const conflicts = [
      directions.length > 1 ? "direction-conflict" : null,
      locomotives.length > 1 ? "locomotive-conflict" : null,
      boardTypes.length > 1 ? "arrival-departure-conflict" : null,
    ].filter(Boolean);
    const ranked = [...group.members].sort((left, right) =>
      authorityWeight(right.authority) * clamp(right.reliability)
      - authorityWeight(left.authority) * clamp(left.reliability)
      || Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
    const times = group.members.map((item) => Date.parse(item.occurred_at)).filter(Number.isFinite);
    const temporalSpreadMinutes = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 60_000 : 0;
    if (temporalSpreadMinutes > Math.max(12, windowMinutes * .75)) conflicts.push("temporal-spread");
    const negativeEvidence = group.members.flatMap((item) => { const raw = parseJson(item.raw_update_json); return Array.isArray(raw.negativeEvidence) ? raw.negativeEvidence : []; }).filter(Boolean);
    const evidenceGrade = conflicts.length ? "conflict"
      : sourceDomains.length >= 2 && effectiveReliability >= .8 ? "corroborated"
        : ranked[0]?.authority === "official" ? "official-single" : "single-source";
    const canonicalOccurredAt = weightedTime(group.members);
    const bucket = Math.floor(Date.parse(canonicalOccurredAt || group.windowStart) / (windowMinutes * 60_000));
    return {
      ...group,
      fusionId: `fusion-v4:${trainKey(group.trainNumber)}:${group.stationId}:${bucket}`,
      primaryEventId: ranked[0].event_id,
      primaryRunId: ranked[0].run_id,
      sourceIds,
      effectiveReliability: Number(Math.min(.99, effectiveReliability * (conflicts.length ? .62 : 1)).toFixed(4)),
      canonicalOccurredAt,
      evidenceGrade,
      ambiguous: conflicts.length > 0,
      explanation: {
        method: "observation-fusion-v4", memberCount: group.members.length,
        independentSources: sourceIds.length, independentDomains: sourceDomains.length, sourceDomains, canonicalStationId: group.stationId,
        canonicalOccurredAt, temporalSpreadMinutes:Number(temporalSpreadMinutes.toFixed(1)), evidenceGrade, conflicts, directions, locomotives, negativeEvidence,
        windowMinutes,
      },
    };
  });
}

async function batch(env, statements, size = 75) {
  for (let index = 0; index < statements.length; index += size) await env.DB.batch(statements.slice(index, index + size));
}

export async function fuseRecentObservationsV4(env, now = new Date().toISOString(), stationAliases = new Map()) {
  const events = rows(await env.DB.prepare(`SELECT e.event_id,e.run_id,e.station,e.occurred_at,e.source_id,e.authority,e.reliability,e.raw_update_json,
    r.train_number,r.route,r.origin,r.destination
    FROM events e JOIN runs r ON r.run_id=e.run_id
    WHERE e.event_type='station_report' AND e.station IS NOT NULL
      AND e.occurred_at>=datetime('now','-36 hours')
    ORDER BY e.occurred_at`).all());
  const canonicalStation = (value) => stationAliases.get(normalize(value)) || normalize(value);
  const groups = fuseObservationRowsV4(events, { canonicalStation });
  const statements = [];
  for (const group of groups) {
    statements.push(env.DB.prepare(`INSERT INTO observation_fusion_groups(
      fusion_id,train_number,station_id,window_started_at,window_ended_at,primary_event_id,
      member_count,independent_sources,effective_reliability,status,source_ids_json,explanation_json,updated_at,source_domains,temporal_spread_minutes,negative_evidence_json)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
      ON CONFLICT(fusion_id) DO UPDATE SET window_ended_at=excluded.window_ended_at,
      primary_event_id=excluded.primary_event_id,member_count=excluded.member_count,
      independent_sources=excluded.independent_sources,effective_reliability=excluded.effective_reliability,
      status=excluded.status,source_ids_json=excluded.source_ids_json,
      explanation_json=excluded.explanation_json,updated_at=excluded.updated_at,source_domains=excluded.source_domains,temporal_spread_minutes=excluded.temporal_spread_minutes,negative_evidence_json=excluded.negative_evidence_json`)
      .bind(group.fusionId, group.trainNumber, group.stationId, group.windowStart,
        group.windowEnd, group.primaryEventId, group.members.length, group.sourceIds.length,
        group.effectiveReliability, group.ambiguous ? "conflict" : "fused",
        JSON.stringify(group.sourceIds), JSON.stringify(group.explanation), now, group.explanation.independentDomains, group.explanation.temporalSpreadMinutes, JSON.stringify(group.explanation.negativeEvidence)));
    for (const member of group.members) {
      statements.push(env.DB.prepare(`INSERT INTO observation_fusion_members(
        fusion_id,event_id,source_id,reliability,is_primary,created_at)
        VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(event_id) DO UPDATE SET fusion_id=excluded.fusion_id,
        source_id=excluded.source_id,reliability=excluded.reliability,
        is_primary=excluded.is_primary,created_at=excluded.created_at`)
        .bind(group.fusionId, member.event_id, member.source_id, clamp(member.reliability),
          member.event_id === group.primaryEventId ? 1 : 0, now));
    }
    statements.push(env.DB.prepare(`INSERT INTO twin_recalculation_queue(
      run_id,trigger_event_id,trigger_fusion_id,reason,priority,queued_at,processed_at,result)
      VALUES(?1,?2,?3,?4,?5,?6,NULL,NULL)
      ON CONFLICT(run_id) DO UPDATE SET trigger_event_id=excluded.trigger_event_id,
      trigger_fusion_id=excluded.trigger_fusion_id,reason=excluded.reason,
      priority=MAX(twin_recalculation_queue.priority,excluded.priority),
      queued_at=excluded.queued_at,processed_at=NULL,result=NULL`)
      .bind(group.primaryRunId, group.primaryEventId, group.fusionId,
        group.ambiguous ? "fusion-conflict" : "new-canonical-station-fact",
        group.ambiguous ? 90 : group.sourceIds.length >= 2 ? 80 : 60, now));
  }
  await batch(env, statements);
  return {
    events: events.length, groups: groups.length,
    collapsed: Math.max(0, events.length - groups.length),
    corroborated: groups.filter((group) => group.evidenceGrade === "corroborated").length,
    ambiguous: groups.filter((group) => group.ambiguous).length,
    queuedTwins: new Set(groups.map((group) => group.primaryRunId)).size,
  };
}

export const fuseObservationRowsV3 = fuseObservationRowsV4;
export const fuseRecentObservationsV3 = fuseRecentObservationsV4;
