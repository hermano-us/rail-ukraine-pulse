import { fetchText } from "./html.mjs";

const REFERENCES = [
  { id: "poezdato-station-schedule", url: "https://poezdato.net/raspisanie-po-stancyi/lvov/", marker: /расписание поездов|Тип Номер Маршрут/iu },
  { id: "kiyavia-station-schedule", url: "https://kiyavia.com/ru/rozklad-poyizdiv-po-ukrayini/rozklad-poizdiv-harkiv-pasagyrskiy", marker: /Харьков-Пассажирский|розклад|расписание/iu },
];

export async function checkReferences() {
  return Promise.all(REFERENCES.map(async (reference) => {
    const checkedAt = new Date().toISOString();
    try {
      const html = await fetchText(reference.url, { timeoutMs: 20_000 });
      if (!reference.marker.test(html)) throw new Error("Expected schedule marker not found");
      return { id: reference.id, status: "snapshot", checkedAt, label: "Справочник доступен", bytes: html.length };
    } catch (error) {
      return { id: reference.id, status: "unavailable", checkedAt, label: "Справочник недоступен", error: String(error.message || error) };
    }
  }));
}
