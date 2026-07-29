import { enrichPriorities } from "./data-reliability.js";

const rows = (result) => result?.results || [];
const normalize = (value) => String(value || "").normalize("NFKC")
  .toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value || "") ?? fallback; } catch { return fallback; } };
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

export function calculateStationPriority({
  expectedRuns = 0,
  silentRuns = 0,
  ambiguousTwins = 0,
  overdueTwins = 0,
  minutesSinceFact = null,
  activityScore = 0,
} = {}) {
  const silence = Number.isFinite(Number(minutesSinceFact)) ? Math.max(0, Number(minutesSinceFact)) : 12 * 60;
  const freshnessNeed = Math.min(22, silence / 30);
  const score = expectedRuns * 4 + silentRuns * 18 + ambiguousTwins * 14
    + overdueTwins * 24 + freshnessNeed + clamp(activityScore, 0, 100) * .08;
  const reasons = [];
  if (expectedRuns) reasons.push(`${expectedRuns} \u043e\u0436\u0438\u0434\u0430\u0435\u043c\u044b\u0445 \u0440\u0435\u0439\u0441\u043e\u0432`);
  if (silentRuns) reasons.push(`${silentRuns} \u043c\u043e\u043b\u0447\u0430\u0449\u0438\u0445 \u0440\u0435\u0439\u0441\u043e\u0432`);
  if (ambiguousTwins) reasons.push(`${ambiguousTwins} \u043d\u0435\u043e\u0434\u043d\u043e\u0437\u043d\u0430\u0447\u043d\u044b\u0445 \u0434\u0432\u043e\u0439\u043d\u0438\u043a\u043e\u0432`);
  if (overdueTwins) reasons.push(`${overdueTwins} \u043f\u0440\u043e\u0433\u043d\u043e\u0437\u043e\u0432 \u0437\u0430 P80`);
  reasons.push(Number.isFinite(Number(minutesSinceFact)) ? `\u043d\u0435\u0442 \u0444\u0430\u043a\u0442\u0430 ${Math.round(silence)} \u043c\u0438\u043d` : "\u0441\u0442\u0430\u043d\u0446\u0438\u044f \u0435\u0449\u0451 \u043d\u0435 \u043d\u0430\u0431\u043b\u044e\u0434\u0430\u043b\u0430\u0441\u044c");
  return { score: Number(score.toFixed(2)), reasons };
}

function stationCandidates(expectedRuns, now) {
  const nowMs = Date.parse(now), candidates = [];
  for (const run of expectedRuns) {
    const metadata = parseJson(run.metadata_json);
    const calls = Array.isArray(metadata.stationCalls) ? metadata.stationCalls : [];
    for (const call of calls) {
      const at = Date.parse(call.scheduledAt || "");
      if (!call.station || !Number.isFinite(at) || Math.abs(at - nowMs) > 6 * 3600_000) continue;
      candidates.push({ name: call.station, runId: run.run_id, silent: ["unobserved", "unknown_completion"].includes(run.status) });
    }
    for (const name of [run.origin, run.destination]) if (name) {
      candidates.push({ name, runId: run.run_id, silent: ["unobserved", "unknown_completion"].includes(run.status) });
    }
  }
  return candidates;
}

export async function refreshStationCoveragePriorities(env, now = new Date().toISOString(), aliases = new Map()) {
  const [expectedResult, twinResult, factResult, activityResult] = await Promise.all([
    env.DB.prepare(`SELECT run_id,status,origin,destination,metadata_json
      FROM expected_train_runs
      WHERE service_date>=date('now','-1 day') AND service_date<=date('now','+1 day')`).all(),
    env.DB.prepare(`SELECT anchor_node_id,next_node_id,operational_state,alternatives_count,state_json
      FROM twin_states WHERE calculated_at>=datetime('now','-12 hours')`).all(),
    env.DB.prepare(`SELECT station,MAX(occurred_at) last_fact_at FROM events
      WHERE event_type='station_report' AND station IS NOT NULL
      GROUP BY station`).all(),
    env.DB.prepare(`SELECT node_id,MAX(activity_score) activity_score
      FROM node_activity_scores WHERE calculated_at>=datetime('now','-24 hours') GROUP BY node_id`).all(),
  ]);
  const canonical = (value) => aliases.get(normalize(value)) || normalize(value);
  const stationNames = new Map(), demand = new Map();
  const ensure = (name) => {
    const id = canonical(name);
    if (!id) return null;
    if (!demand.has(id)) demand.set(id, { stationId: id, stationName: String(name), expected: new Set(), silent: new Set(), ambiguousTwins: 0, overdueTwins: 0 });
    if (!stationNames.has(id)) stationNames.set(id, String(name));
    return demand.get(id);
  };
  for (const candidate of stationCandidates(rows(expectedResult), now)) {
    const item = ensure(candidate.name); if (!item) continue;
    item.expected.add(candidate.runId);
    if (candidate.silent) item.silent.add(candidate.runId);
  }
  for (const twin of rows(twinResult)) {
    const state = parseJson(twin.state_json);
    for (const nodeId of [twin.anchor_node_id, twin.next_node_id]) {
      const item = ensure(nodeId); if (!item) continue;
      if (Number(twin.alternatives_count) > 0 || state.ambiguous) item.ambiguousTwins += 1;
      if (twin.operational_state === "overdue") item.overdueTwins += 1;
    }
  }
  const lastFacts = new Map(rows(factResult).map((fact) => [canonical(fact.station), fact.last_fact_at]));
  const activity = new Map(rows(activityResult).map((item) => [item.node_id, Number(item.activity_score) || 0]));
  const rawPriorities = [...demand.values()].map((item) => {
    const lastFactAt = lastFacts.get(item.stationId);
    const minutesSinceFact = lastFactAt ? Math.max(0, (Date.parse(now) - Date.parse(lastFactAt)) / 60_000) : null;
    const priority = calculateStationPriority({
      expectedRuns: item.expected.size, silentRuns: item.silent.size,
      ambiguousTwins: item.ambiguousTwins, overdueTwins: item.overdueTwins,
      minutesSinceFact, activityScore: activity.get(item.stationId) || 0,
    });
    return {
      stationId: item.stationId, stationName: stationNames.get(item.stationId) || item.stationName,
      priorityScore: priority.score, expectedRuns: item.expected.size, silentRuns: item.silent.size,
      ambiguousTwins: item.ambiguousTwins, overdueTwins: item.overdueTwins,
      minutesSinceFact: minutesSinceFact == null ? null : Number(minutesSinceFact.toFixed(1)),
      reasons: priority.reasons,
    };
  }).sort((left, right) => right.priorityScore - left.priorityScore).slice(0, 500);
  const pollHealth = rows(await env.DB.prepare("SELECT * FROM station_poll_health WHERE updated_at>=datetime('now','-7 days')").all());
  const priorities = enrichPriorities(rawPriorities, pollHealth, now);
  const statements = priorities.map((item) => env.DB.prepare(`INSERT INTO station_coverage_priorities(
    station_id,station_name,priority_score,expected_runs,silent_runs,ambiguous_twins,
    overdue_twins,minutes_since_fact,reason_json,calculated_at,priority_tier,collector_failures,next_eligible_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    ON CONFLICT(station_id) DO UPDATE SET station_name=excluded.station_name,
    priority_score=excluded.priority_score,expected_runs=excluded.expected_runs,
    silent_runs=excluded.silent_runs,ambiguous_twins=excluded.ambiguous_twins,
    overdue_twins=excluded.overdue_twins,minutes_since_fact=excluded.minutes_since_fact,
    reason_json=excluded.reason_json,calculated_at=excluded.calculated_at,
    priority_tier=excluded.priority_tier,collector_failures=excluded.collector_failures,
    next_eligible_at=excluded.next_eligible_at`)
    .bind(item.stationId, item.stationName, item.priorityScore, item.expectedRuns,
      item.silentRuns, item.ambiguousTwins, item.overdueTwins, item.minutesSinceFact,
      JSON.stringify(item.reasons), now, item.priorityTier, item.collectorFailures, item.nextEligibleAt));
  for (let index = 0; index < statements.length; index += 75) await env.DB.batch(statements.slice(index, index + 75));
  await env.DB.prepare("DELETE FROM station_coverage_priorities WHERE calculated_at<datetime('now','-2 days')").run();
  if (env.SNAPSHOT) await env.SNAPSHOT.put("intelligence:board-priorities:v1", JSON.stringify({
    generatedAt: now, strategy: "information-gain-v3",
    stations: priorities.slice(0, 100),
  }), { expirationTtl: 30 * 60 });
  return { total: priorities.length, urgent: priorities.filter((item) => item.priorityScore >= 40).length, priorities };
}
