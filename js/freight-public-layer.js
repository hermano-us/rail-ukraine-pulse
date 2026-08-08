const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));

function freshness(lastObservedAt, now) {
  const ageMinutes = Math.max(0, (now.getTime() - Date.parse(lastObservedAt || "")) / 60_000);
  if (!Number.isFinite(ageMinutes)) return { key: "expired", label: "Нет времени наблюдения", tone: "danger", frozen: true, ageMinutes: Infinity };
  if (ageMinutes <= 48 * 60) return { key: "delayed", label: "Агрегат за предыдущие сутки", tone: "warning", frozen: true, ageMinutes };
  return { key: "expired", label: "Архивная грузовая активность", tone: "danger", frozen: true, ageMinutes };
}

export function materializePublicFreight(snapshot = {}, regionResolver = () => [], now = new Date()) {
  const objects = []; const features = [];
  for (const [index, item] of (snapshot.objects || []).entries()) {
    const routeCoordinates = Array.isArray(item.routeCoordinates) ? item.routeCoordinates.filter((point) => Array.isArray(point) && point.length >= 2) : [];
    if (routeCoordinates.length < 2 || !item.id || !item.corridorCode) continue;
    const routeId = `freight-public-${item.corridorCode}-${index}`;
    const confidence = clamp(item.confidence, 0.05, 0.88);
    const sourceFreshness = freshness(item.lastObservedAt, now);
    const quality = Number(clamp(confidence * 0.82 + Math.min(1, Number(item.independentSources || 0) / 4) * 0.18, 0.05, 0.9).toFixed(2));
    const publicNumber = `F-${String(item.id).replace(/^freight-/, "").toUpperCase()}`;
    const route = item.label || `${item.origin || "Грузовой коридор"} — ${item.destination || "направление"}`;
    const errorKm = Math.max(35, Number(item.uncertaintyKm) || 80);
    const corroborationLabel = item.corroboration === "operator-reviewed" ? "Проверено оператором" : `${item.independentSources || 0} независимых источника`;
    features.push({
      type: "Feature",
      properties: { id: routeId, quality, source: "public-freight-corridor-v2", freight: true, corridorCode: item.corridorCode },
      geometry: { type: "LineString", coordinates: routeCoordinates },
    });
    objects.push({
      id: item.id, runId: item.id, serviceDate: String(item.lastObservedAt || snapshot.generatedAt || "").slice(0, 10), directionId: item.corridorCode,
      trainNumber: publicNumber, transport: "train", type: "freight", name: `Грузовая активность ${publicNumber}`,
      route, origin: item.origin || "Коридор", destination: item.destination || "Коридор", routeId,
      regions: regionResolver(routeCoordinates), routeCoordinates,
      description: "Обезличенная агрегированная активность по открытому грузовому коридору. Это не точная позиция отдельного состава.",
      rollingStock: "Тип и идентификатор состава публично не раскрываются",
      operationalStatus: "freight_activity", stationPresence: null, stationLifecycle: null, registryState: "observed",
      positionAdmission: { allowed: false, reasonCode: "freight_corridor_only", reason: "Публично доступен только вероятностный коридор, а не координата состава" },
      stationQueue: null,
      liveUpdate: {
        trainNumber: publicNumber, route, origin: item.origin, destination: item.destination,
        publicStatus: `Агрегировано: ${item.observationCount || 0} наблюдений · ${corroborationLabel.toLocaleLowerCase("ru-RU")}`,
        operationalStatus: "freight_activity", delayMinutes: null, delayLabel: "публикация ≥24 ч", updatedAt: item.lastObservedAt,
        sourceId: "public-freight-projection", hasOperationalObservation: true,
      },
      telemetry: { speedKph: null },
      position: {
        status: sourceFreshness.key === "expired" ? "stale" : "estimated", coordinates: null, updatedAt: item.lastObservedAt, sourceUpdatedAt: item.lastObservedAt,
        calculatedAt: snapshot.generatedAt || now.toISOString(), confidence, errorKm,
        method: item.method || "delayed-corroborated-corridor-v2", lastConfirmedAt: null, freshness: sourceFreshness,
        sources: [corroborationLabel, "публичная проекция с задержкой ≥24 ч"],
        confidenceReasons: [
          { positive: true, text: corroborationLabel },
          { positive: false, text: "Точная координата и идентификатор не публикуются" },
        ],
      },
      quality,
      evidence: { ledger: [], sources: [], method: item.method || "delayed-corroborated-corridor-v2" },
      events: [{ kind: "aggregate", label: "Агрегированная грузовая активность", value: `${item.observationCount || 0} наблюдений`, occurredAt: item.lastObservedAt, sourceLabel: "Открытые источники", authority: "aggregate" }],
      corridor: { coordinates: routeCoordinates, widthKm: errorKm * 2, fromKm: 0, toKm: errorKm * 2, totalKm: errorKm * 2 },
      routeTimeline: [
        { kind: "origin", label: item.origin || route, evidence: "corridor", timestamp: null },
        { kind: "estimate", label: "Вероятностная активность внутри коридора", evidence: "aggregate", timestamp: item.lastObservedAt },
        { kind: "destination", label: item.destination || route, evidence: "corridor", timestamp: null },
      ],
      waypoints: [], stationPlan: [], forecast: { departureAt: null, arrivalAt: null },
      journey: { progress: null, lastEvent: null, nextEvent: null, previousWaypoint: null, nextWaypoint: null },
      history: [], freight: { ...item, corroborationLabel, publicDelayHours: 24, exactPosition: false },
    });
  }
  return { objects, features };
}
