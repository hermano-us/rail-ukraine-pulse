import test from "node:test";
import assert from "node:assert/strict";
import { collectAnyTrain } from "../scripts/source-adapters/anytrain.mjs";

test("AnyTrain page without its own update clock cannot make the global snapshot fresh", async () => {
  const html = `<div class="brow"><span class="bno">91</span><span class="brt"><b>A - B</b><span>moving</span></span><span class="bdel"><i></i>+0:20</span><span class="bst"><i></i>moving</span><span class="beta">-</span><span class="beta">12:00</span><span class="bcause">-</span></div>`;
  const result = await collectAnyTrain({ stationBudget: 0, fetchImpl: async () => new Response(html, { status: 200 }) });
  assert.equal(result.updates.length, 1);
  assert.equal(result.status.sourceUpdatedAt, null);
  assert.equal(result.status.status, "degraded");
});
