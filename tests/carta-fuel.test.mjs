import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { partnerMatchScore } from "../backend/src/fuel/partner.js";

test("Carta.ua partner bundle is complete and every local photo exists", async () => {
  const records = JSON.parse(await readFile(new URL("../AZC/azs_full_data.json", import.meta.url), "utf8"));
  assert.equal(records.length, 722);
  const usable = records.filter((record) => Number(record.lat) >= 44 && Number(record.lat) <= 53 && Number(record.lng) >= 21 && Number(record.lng) <= 41);
  assert.equal(usable.length, 721);
  const photos = records.flatMap((record) => record.local_photos || []);
  assert.equal(new Set(photos).size, 870);
  await Promise.all([...new Set(photos)].map((photo) => access(new URL(`../AZC/${photo}`, import.meta.url))));
});

test("partner matcher accepts the same nearby brand and rejects a conflicting brand", () => {
  const record = { lat: 50.4483273, lng: 30.4765337, brand: "WOG", name: "WOG, проспект Победы, 11Б", address: "г. Киев, пр-т. Победы, 11Б" };
  const same = partnerMatchScore(record, { latitude: 50.44834, longitude: 30.47655, brand: "WOG", canonical_name: "АЗС WOG", address: "Київ, проспект Перемоги, 11Б" });
  const conflict = partnerMatchScore(record, { latitude: 50.44834, longitude: 30.47655, brand: "SOCAR", canonical_name: "SOCAR", address: "Київ, проспект Перемоги, 11Б" });
  assert.ok(same.score >= 0.7);
  assert.ok(conflict.score < 0.7);
});

test("partner matcher unifies Cyrillic brand aliases and generic OSM labels", () => {
  const klo = partnerMatchScore(
    { lat: 50.4516832, lng: 30.634, brand: "КЛО", name: "КЛО, перекресток Карельский, 3а", address: "Фінський провулок 3-А" },
    { latitude: 50.4516588, longitude: 30.634, brand: "KLO", canonical_name: "КЛО", address: "Карельський провулок, 3-А" },
  );
  const generic = partnerMatchScore(
    { lat: 50.45, lng: 30.63, brand: "Укрнафта", name: "Укрнафта" },
    { latitude: 50.45005, longitude: 30.63004, brand: null, canonical_name: "АЗС" },
  );
  const conflict = partnerMatchScore(
    { lat: 50.45, lng: 30.63, brand: "Укрнафта" },
    { latitude: 50.45005, longitude: 30.63004, brand: "WOG", canonical_name: "WOG" },
  );
  assert.ok(klo.score >= 0.7);
  assert.ok(generic.score >= 0.7);
  assert.ok(conflict.score < 0.7);
});
test("Carta.ua import filters shared phones and publishes attributed photo galleries", async () => {
  const importer = await readFile(new URL("../scripts/import-carta-fuel.mjs", import.meta.url), "utf8");
  const app = await readFile(new URL("../fuel/js/app.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build-web.mjs", import.meta.url), "utf8");
  assert.match(importer, /SHARED_PHONE_LIMIT/);
  assert.match(importer, /phoneFrequency/);
  assert.match(app, /media\.imageUrls/);
  assert.match(app, /Carta\.ua/);
  assert.match(build, /assets\/fuel\/carta/);
});
