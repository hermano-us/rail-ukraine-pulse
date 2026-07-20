export const FRESHNESS_THRESHOLDS = Object.freeze({
  fresh: 30,
  watch: 60,
  extrapolationLimit: 90,
  hidden: 180,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function sourceAgeMinutes(sourceTimestamp, now = new Date()) {
  const timestamp = Date.parse(sourceTimestamp);
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.max(0, (now.getTime() - timestamp) / 60_000);
}

/**
 * Defines what the UI and positioning model may claim from an aging event.
 * The model is never allowed to extrapolate farther than 90 minutes.
 */
export function evaluateFreshness(ageMinutes) {
  const age = Math.max(0, Number(ageMinutes) || 0);
  if (age <= FRESHNESS_THRESHOLDS.fresh) {
    return { key: "fresh", label: "Свежий расчёт", tone: "good", canPosition: true, frozen: false, modelAgeMinutes: age };
  }
  if (age <= FRESHNESS_THRESHOLDS.watch) {
    return { key: "watch", label: "Требует внимания", tone: "watch", canPosition: true, frozen: false, modelAgeMinutes: age };
  }
  if (age <= FRESHNESS_THRESHOLDS.extrapolationLimit) {
    return { key: "degraded", label: "Устаревающий расчёт", tone: "warning", canPosition: true, frozen: false, modelAgeMinutes: age };
  }
  if (age <= FRESHNESS_THRESHOLDS.hidden) {
    return {
      key: "stale", label: "Экстраполяция остановлена", tone: "stale", canPosition: true, frozen: true,
      modelAgeMinutes: FRESHNESS_THRESHOLDS.extrapolationLimit,
    };
  }
  return {
    key: "expired", label: "Положение неизвестно", tone: "offline", canPosition: false, frozen: true,
    modelAgeMinutes: FRESHNESS_THRESHOLDS.extrapolationLimit,
  };
}

export function freshnessConfidenceFactor(ageMinutes) {
  const age = Math.max(0, Number(ageMinutes) || 0);
  if (age <= 30) return 1;
  if (age <= 60) return clamp(1 - (age - 30) / 150, 0.8, 1);
  if (age <= 90) return clamp(0.8 - (age - 60) / 100, 0.5, 0.8);
  if (age <= 180) return clamp(0.5 - (age - 90) / 450, 0.3, 0.5);
  return 0;
}

export function freshnessReasons({ freshness, hasRoute, hasForecast, anchorErrorKm = 0 }) {
  const reasons = [];
  reasons.push(hasRoute ? { positive: true, text: "Маршрут построен по железнодорожной геометрии" } : { positive: false, text: "Геометрия маршрута не найдена" });
  reasons.push(hasForecast ? { positive: true, text: "Есть официальный прогноз прибытия" } : { positive: false, text: "Нет прогноза прибытия" });
  if (anchorErrorKm > 20) reasons.push({ positive: false, text: `Привязка маршрута имеет отклонение ${Math.round(anchorErrorKm)} км` });
  if (freshness.frozen) reasons.push({ positive: false, text: "Новых данных более 90 минут — движение маркера остановлено" });
  else if (freshness.key === "degraded") reasons.push({ positive: false, text: "Исходным данным более 60 минут" });
  else if (freshness.key === "watch") reasons.push({ positive: false, text: "Исходным данным более 30 минут" });
  else reasons.push({ positive: true, text: "Исходные данные моложе 30 минут" });
  return reasons;
}
