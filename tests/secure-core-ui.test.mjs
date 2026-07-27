import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("operations center supports role sessions while retaining the legacy token path", async () => {
  const script = await readFile(new URL("../js/admin.js", import.meta.url), "utf8");
  assert.match(script, /account-login/);
  assert.match(script, /\/api\/auth\/session/);
  assert.match(script, /else token=accessKey/);
  assert.match(script, /sessionStorage\.setItem\("rail-ops-token"/);
});

test("operations center renders and moderates the restricted evidence inbox", async () => {
  const script = await readFile(new URL("../js/admin.js", import.meta.url), "utf8");
  assert.match(script, /\/api\/restricted\/evidence/);
  assert.match(script, /renderEvidenceInbox/);
  assert.match(script, /corroborated/);
  assert.match(script, /needs_context/);
  assert.match(script, /rejected/);
});
