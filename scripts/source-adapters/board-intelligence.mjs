const normalize = (value) => String(value || "")
  .normalize("NFKC").toLocaleLowerCase("uk-UA")
  .replace(/\u00a0/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const HUB_WEIGHT = new Map(Object.entries({
  "\u043a\u0438\u0457\u0432 \u043f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439": 8, "\u043b\u044c\u0432\u0456\u0432": 7, "\u0434\u043d\u0456\u043f\u0440\u043e \u0433\u043e\u043b\u043e\u0432\u043d\u0438\u0439": 6.5,
  "\u0445\u0430\u0440\u043a\u0456\u0432 \u043f\u0430\u0441\u0430\u0436\u0438\u0440\u0441\u044c\u043a\u0438\u0439": 6.5, "\u043e\u0434\u0435\u0441\u0430 \u0433\u043e\u043b\u043e\u0432\u043d\u0430": 6, "\u0437\u0430\u043f\u043e\u0440\u0456\u0436\u0436\u044f 1": 5.5,
  "\u043a\u043e\u0437\u044f\u0442\u0438\u043d": 5, "\u0436\u043c\u0435\u0440\u0438\u043d\u043a\u0430 1": 5, "\u0444\u0430\u0441\u0442\u0456\u0432 1": 4.5, "\u043a\u043e\u0440\u043e\u0441\u0442\u0435\u043d\u044c": 4.5,
  "\u0448\u0435\u043f\u0435\u0442\u0456\u0432\u043a\u0430": 4.5, "\u043f\u043e\u043b\u0442\u0430\u0432\u0430 \u043f\u0456\u0432\u0434\u0435\u043d\u043d\u0430": 4, "\u0456\u043c \u0442\u0430\u0440\u0430\u0441\u0430 \u0448\u0435\u0432\u0447\u0435\u043d\u043a\u0430": 4,
}));

const finiteDate = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
};

function demandForUpdates(updates) {
  const demand = new Map();
  const add = (station, points, trainNumber) => {
    const key = normalize(station);
    if (!key) return;
    const item = demand.get(key) || { points: 0, trains: new Set() };
    item.points += points;
    if (trainNumber) item.trains.add(String(trainNumber));
    demand.set(key, item);
  };
  for (const update of Array.isArray(updates) ? updates : []) {
    const confidence = Number(update?.confidence);
    const uncertainty = Number.isFinite(confidence) ? Math.max(0, 1 - confidence) * 3 : 1.5;
    const error = Number(update?.errorKm);
    const bonus = uncertainty + (Number.isFinite(error) ? Math.min(3, error / 80) : 0);
    add(update?.reportedStation, 10 + bonus, update?.trainNumber);
    add(update?.origin, 2.5 + bonus, update?.trainNumber);
    add(update?.destination, 2.5 + bonus, update?.trainNumber);
  }
  return demand;
}

export function rankBoardStations(stations, { updates = [], previousRecords = [], coveragePriorities = [], now = new Date().toISOString() } = {}) {
  const nowMs = finiteDate(now) || Date.now(), demand = demandForUpdates(updates), lastSeen = new Map();
  const coverage = new Map();
  for (const priority of Array.isArray(coveragePriorities) ? coveragePriorities : []) {
    for (const value of [priority?.stationName, priority?.stationId]) { const key=normalize(value); if(key) coverage.set(key,priority); }
  }
  for (const record of Array.isArray(previousRecords) ? previousRecords : []) {
    const key = normalize(record?.station), observed = finiteDate(record?.observedAt);
    if (key && observed != null && observed > (lastSeen.get(key) || 0)) lastSeen.set(key, observed);
  }
  return (Array.isArray(stations) ? stations : []).map((station) => {
    const key = normalize(station?.name), stationDemand = demand.get(key), coverageDemand=coverage.get(key);
    const lastObservedMs = lastSeen.get(key) || null;
    const silenceMinutes = lastObservedMs == null ? 720 : Math.max(0, (nowMs - lastObservedMs) / 60_000);
    const centrality = HUB_WEIGHT.get(key) || 1;
    const score = centrality * 2 + (stationDemand?.points || 0) + Math.min(12, silenceMinutes / 60) + Math.min(90,Number(coverageDemand?.priorityScore)||0)*.75 + Math.min(18,Number(coverageDemand?.requestWeight||1)*3) + Math.max(0,12-Number(coverageDemand?.targetIntervalMinutes||20)*.5);
    const reasons = [];
    if (stationDemand?.trains.size) reasons.push(`${stationDemand.trains.size} \u043e\u0436\u0438\u0434\u0430\u0435\u043c\u044b\u0445 \u0440\u0435\u0439\u0441\u043e\u0432`);
    if (coverageDemand) reasons.push(...(Array.isArray(coverageDemand.reasons)?coverageDemand.reasons:["Rail Intelligence priority"]));
    if (centrality >= 4) reasons.push("\u043a\u043b\u044e\u0447\u0435\u0432\u043e\u0439 \u0443\u0437\u0435\u043b");
    reasons.push(lastObservedMs == null ? "\u043d\u0435\u0442 \u0441\u0432\u0435\u0436\u0435\u0433\u043e \u0441\u043d\u0438\u043c\u043a\u0430" : `\u0442\u0438\u0448\u0438\u043d\u0430 ${Math.round(silenceMinutes)} \u043c\u0438\u043d`);
    return {
      ...station, score: Number(score.toFixed(2)), expectedTrains: stationDemand?.trains.size || 0,
      lastObservedAt: lastObservedMs == null ? null : new Date(lastObservedMs).toISOString(), reasons,
    };
  }).sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), "uk"));
}

export function mergeBoardCache(previousRecords, freshRecords, now = new Date().toISOString(), ttlHours = 8) {
  const nowMs = finiteDate(now) || Date.now(), ttlMs = Math.max(1, Number(ttlHours) || 8) * 3_600_000;
  const fresh = Array.isArray(freshRecords) ? freshRecords : [];
  const refreshedStations = new Set(fresh.map((record) => normalize(record?.station)).filter(Boolean));
  const cached = (Array.isArray(previousRecords) ? previousRecords : []).filter((record) => {
    const station = normalize(record?.station), observed = finiteDate(record?.observedAt), scheduled = finiteDate(record?.scheduledAt);
    return station && !refreshedStations.has(station) && observed != null && nowMs - observed <= ttlMs
      && scheduled != null && scheduled >= nowMs - 6 * 3_600_000 && scheduled <= nowMs + 36 * 3_600_000;
  });
  const records = [...new Map([...fresh, ...cached].map((record) => [
    `${normalize(record.station)}|${record.boardType}|${record.trainNumber}|${record.scheduledAt}`, record,
  ])).values()];
  return {
    records, cachedRecords: cached.length,
    cachedStations: new Set(cached.map((record) => normalize(record.station))).size,
  };
}
