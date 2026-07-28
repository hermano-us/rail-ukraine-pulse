import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyFreightText, extractFreightEntities, parseFreightPreview } from "../scripts/source-adapters/freight-telegram.mjs";
import { handleFreightRequest } from "../backend/src/freight/api.js";

test("freight source registry separates public previews from membership-only chats", async () => {
  const registry = JSON.parse(await readFile(new URL("../data/freight-telegram-sources.json", import.meta.url), "utf8"));
  assert.equal(registry.sources.length, 21); assert.ok(registry.sources.filter((item) => item.access === "public-preview" && item.enabled).length >= 14);
  assert.ok(registry.sources.some((item) => item.access === "requires-membership" && !item.enabled));
  assert.equal(registry.policy.individualPublicPositions, false);
});

test("freight classifier accepts cargo evidence and discards sensitive or irrelevant posts", () => {
  assert.equal(classifyFreightText("Вантажний поїзд із зерновозами пройшов перегін").accepted, true);
  assert.equal(classifyFreightText("Пасажирський поїзд прибув за розкладом").accepted, false);
  assert.equal(classifyFreightText("Електровоз ВЛ80 на перегоні").freightType, "unclassified_rail");
  const sensitive = classifyFreightText("Військовий ешелон з технікою на станції"); assert.equal(sensitive.accepted, false); assert.equal(sensitive.restricted, true);
});

test("freight preview emits private evidence without public positions", () => {
  const html = `<div class="tgme_widget_message_wrap"><div data-post="demo/15"><div class="tgme_widget_message_text">Вантажний поїзд, цистерни</div><time datetime="2026-07-22T10:00:00Z"></time></div></div>`;

  const result = parseFreightPreview(html, { id: "demo", reliability: 0.4, corridor: "test" }, "2026-07-22T10:01:00Z");
  assert.equal(result.observations.length, 1); assert.equal(result.observations[0].freightType, "tank_cars"); assert.equal(result.observations[0].publicEligible, false);
  assert.equal("latitude" in result.observations[0], false); assert.equal("longitude" in result.observations[0], false);
});

test("freight entity extraction keeps a directional report probabilistic", () => {
  const entities=extractFreightEntities("Вл80т-1445 на Київ");
  assert.equal(entities.locomotive,"ВЛ80Т-1445");
  assert.equal(entities.direction,"київ");
  assert.equal(classifyFreightText("Вл80т-1445 на Київ").freightType,"unclassified_rail");
  const station=extractFreightEntities("Вантажний поїзд на станції Коростень, слідує далі");
  assert.equal(station.station,"Коростень");
  assert.equal(station.direction,null);
  assert.equal("latitude" in station,false);
});

test("freight ingest repeats the sensitive-content guard before D1", async () => {
  const batches = [];
  const env = { DB: { prepare(sql) { return { bind(...values) { return { sql, values }; } }; }, async batch(statements) { batches.push(statements); } } };
  const base = { observationId: "freight-tg-test:1", sourceId: "freight-tg-test", sourceUrl: "https://t.me/test/1", occurredAt: "2026-07-27T10:00:00Z", corridor: "test", freightType: "bulk", confidence: 0.4, contentFingerprint: "abc", publicEligible: false };
  const request = new Request("https://example.test/api/v1/freight/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ observations: [
    { ...base, evidenceExcerpt: "Вантажний поїзд із зерновозами" },
    { ...base, observationId: "freight-tg-test:2", evidenceExcerpt: "Військовий ешелон з технікою" },
    { ...base, observationId: "freight-tg-test:3", evidenceExcerpt: "Вантажний поїзд", latitude: 50.4 },
  ], sources: [] }) });
  const response = await handleFreightRequest(request, env, { authorized: () => true, authorizedAdmin: () => false });
  const result = await response.json();
  assert.equal(response.status, 202); assert.equal(result.received, 3); assert.equal(result.accepted, 1); assert.equal(result.publicObjects, 0);
  assert.equal(batches.flat().length, 2);
  assert.match(batches.flat()[1].sql, /restricted_evidence/);
});
test("freight entity extraction separates station facts, directions and stable identities", () => {
  const passed=extractFreightEntities("Вантажний поїзд ВЛ80Т-1445 прослідував станцію Фастів, слідує на Київ");
  assert.equal(passed.locomotive,"ВЛ80Т-1445"); assert.equal(passed.station,"Фастів"); assert.equal(passed.stationEvidence,"passed_station"); assert.equal(passed.direction,"київ"); assert.equal(passed.entityKey,"locomotive:ВЛ80Т-1445");
  const numbered=extractFreightEntities("Вантажний поїзд №2417 відправився зі станції Козятин");
  assert.equal(numbered.trainNumber,"2417"); assert.equal(numbered.entityKey,"train:2417"); assert.equal(numbered.station,"Козятин");
  const vague=extractFreightEntities("Вантажний склад рухається у напрямку Києва");
  assert.equal(vague.entityKey,null);
});
test("freight ingest infers a known corridor from an explicit station", async () => {
  const batches=[]; const env={DB:{prepare(sql){return{bind(...values){return{sql,values};}};},async batch(statements){batches.push(statements);}}};
  const observation={observationId:"freight-tg-test:station",sourceId:"freight-tg-test",sourceUrl:"https://t.me/test/2",occurredAt:"2026-07-27T10:00:00Z",corridor:"unresolved",freightType:"bulk",confidence:.4,contentFingerprint:"station",evidenceExcerpt:"Вантажний поїзд ВЛ80Т-1445 пройшов станцію Коростень",publicEligible:false};
  const response=await handleFreightRequest(new Request("https://example.test/api/v1/freight/ingest",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({observations:[observation],sources:[]})}),env,{authorized:()=>true,authorizedAdmin:()=>false});
  assert.equal(response.status,202); assert.equal(batches[0][0].values[5],"kyiv-korosten"); assert.equal(batches[0][1].values[8],"kyiv-korosten");
});
