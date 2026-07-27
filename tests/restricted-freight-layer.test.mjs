import test from "node:test";
import assert from "node:assert/strict";
import { buildRestrictedFreightLayer } from "../backend/src/intelligence/freight-layer.js";

const item=(overrides={})=>({evidence_id:"e-1",source_id:"freight-tg-one",source_url:"https://t.me/example/1",occurred_at:"2026-07-27T11:30:00Z",evidence_excerpt:"ВЛ80Т-1445 на Київ",classification_json:JSON.stringify({freightType:"unclassified_rail",locomotive:"ВЛ80Т-1445",direction:"київ"}),corridor_code:"kyiv-korosten",confidence:.4,sensitivity_level:"restricted",review_status:"pending",...overrides});

test("restricted freight layer aggregates independent corridor observations",()=>{
  const result=buildRestrictedFreightLayer([item(),item({evidence_id:"e-2",source_id:"freight-tg-two",occurred_at:"2026-07-27T11:40:00Z"})],"2026-07-27T12:00:00Z");
  assert.equal(result.corridors.length,1);
  assert.equal(result.corridors[0].independentSources,2);
  assert.equal(result.corridors[0].status,"corroborated");
  assert.equal(result.corridors[0].direction,"київ");
  assert.ok(result.corridors[0].uncertaintyKm>0);
  assert.equal(result.policy.exactFreightPositions,false);
});

test("station points require an explicit non-sensitive station fact",()=>{
  const station=item({classification_json:JSON.stringify({freightType:"bulk",station:"Коростень"}),review_status:"corroborated"});
  const result=buildRestrictedFreightLayer([station,item({evidence_id:"old",occurred_at:"2026-07-25T00:00:00Z"}),item({evidence_id:"secret",sensitivity_level:"highly_restricted",classification_json:JSON.stringify({station:"Київ"})})],"2026-07-27T12:00:00Z");
  assert.equal(result.stationFacts.length,1);
  assert.equal(result.stationFacts[0].station,"Коростень");
  assert.equal(result.stationFacts[0].factStatus,"confirmed");
  assert.equal("latitude" in result.stationFacts[0],false);
  assert.equal("longitude" in result.stationFacts[0],false);
});
