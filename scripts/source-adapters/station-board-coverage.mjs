const normalize = (value) => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("uk-UA")
  .replace(/[^\p{L}\p{N}]+/gu, "-")
  .replace(/^-|-$/g, "");

const CORE_STATIONS = [
  "Київ-Пасажирський", "Львів", "Дніпро-Головний", "Запоріжжя 1", "Харків-Пасажирський",
  "Одеса-Головна", "Вінниця", "Чернівці", "Суми", "Хмельницький", "Рівне", "Івано-Франківськ",
  "Тернопіль", "Луцьк", "Ужгород", "Ковель", "Полтава-Київська", "Херсон", "Черкаси",
  "Миколаїв-Пасажирський", "Кропивницький", "Чернігів", "Житомир", "Жмеринка-Пасажирська",
  "Козятин-1", "Фастів-1", "Ніжин", "Конотоп-Пасажирський", "Гребінка", "Шепетівка",
];

const CORRIDOR_STATIONS = [
  "Мукачево", "Чоп", "Стрий", "Коломия", "Здолбунів-Пасажирський", "Сарни", "Коростень",
  "Подільськ", "Вапнярка", "Помічна", "Знам'янка-Пасажирська", "Кривий Ріг-Головний",
  "Лозова-Пасажирська", "Павлоград I", "Синельникове-1", "Кременчук", "Миргород", "Ромодан",
  "Бахмач-Пасажирський", "Шостка", "Біла Церква", "Миронівка", "Дарниця", "ім. Тараса Шевченка",
];

export const BOARD_STATIONS = [...CORE_STATIONS, ...CORRIDOR_STATIONS];

export function stationBoardPlan({ stations = BOARD_STATIONS, shardIndex = 0, shardCount = 1 } = {}) {
  const unique = [...new Map(stations.map((station) => [normalize(station), String(station).trim()])).values()].filter(Boolean);
  const count = Math.max(1, Math.min(8, Number(shardCount) || 1));
  const index = ((Number(shardIndex) || 0) % count + count) % count;
  return unique.filter((_, position) => position % count === index);
}

function clockOnServiceDay(value, observedAt) {
  const match = String(value || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  const observed = new Date(observedAt);
  if (!match || !Number.isFinite(observed.getTime())) return null;
  const candidates = [-1, 0, 1].map((offset) => {
    const candidate = new Date(observed);
    candidate.setUTCDate(candidate.getUTCDate() + offset);
    candidate.setUTCHours(Number(match[1]) - 3, Number(match[2]), 0, 0);
    return candidate;
  });
  candidates.sort((left, right) => Math.abs(left - observed) - Math.abs(right - observed));
  return candidates[0].toISOString();
}

export function classifyBoardWindow(record, options = {}) {
  const observedAt = record?.observedAt || options.observedAt || new Date().toISOString();
  const exactScheduledAt = new Date(record?.scheduledAt || "");
  const scheduledAt = Number.isFinite(exactScheduledAt.getTime())
    ? exactScheduledAt.toISOString() : clockOnServiceDay(record?.scheduledTime, observedAt);
  if (!scheduledAt) return { scheduledAt: null, phase: "schedule", isStationFact: false, offsetMinutes: null };
  const offsetMinutes = (Date.parse(observedAt) - Date.parse(scheduledAt)) / 60_000;
  const before = Number(options.beforeMinutes ?? 45), after = Number(options.afterMinutes ?? 90);
  const isStationFact = offsetMinutes >= -before && offsetMinutes <= after;
  return {
    scheduledAt,
    offsetMinutes: Number(offsetMinutes.toFixed(1)),
    isStationFact,
    phase: isStationFact ? (offsetMinutes < -10 ? "approaching-window" : offsetMinutes <= 35 ? "station-window" : "recent-window") : "schedule",
  };
}

export function distributeStations(stations, concurrency = 3) {
  const buckets = Array.from({ length: Math.max(1, Math.min(6, Number(concurrency) || 1)) }, () => []);
  stations.forEach((station, index) => buckets[index % buckets.length].push(station));
  return buckets.filter((bucket) => bucket.length);
}
