export const TRANSPORT_LABELS = { train: "Поезд", vessel: "Морское судно" };
export const TYPE_LABELS = { passenger: "Пассажирский", commuter: "Региональный", freight: "Грузовой железнодорожный", ferry: "Паром", cargo: "Грузовое судно" };
export const OPERATION_LABELS = {
  moving: "В пути", station: "На станции", depot: "В депо", "source-unavailable": "Источник недоступен",
};
export const OPERATION_COLORS = { moving: "#48d9e6", station: "#f2ce61", depot: "#a98cff", "source-unavailable": "#71818b" };
OPERATION_LABELS.planned="\u041f\u043e \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u044e";
OPERATION_COLORS.planned="#78909b";
OPERATION_LABELS.freight_activity="Грузовая активность";
OPERATION_COLORS.freight_activity="#d99a45";

export function formatDateTime(value) {
  if (!value || Number.isNaN(Date.parse(value))) return "Нет данных";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
export function formatRelative(value, now = new Date()) {
  if (!value || Number.isNaN(Date.parse(value))) return "нет подтверждений";
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} ч назад` : formatDateTime(value);
}
export function formatSpeed(object) {
  const value = object.telemetry?.speedKph;
  return Number.isFinite(value) ? `${Math.round(value)} км/ч` : "Нет данных";
}
export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

