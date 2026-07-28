import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("operations center exposes complete responsive access management", async () => {
  const [script,styles,html]=await Promise.all([
    readFile(new URL("../js/admin.js",import.meta.url),"utf8"),
    readFile(new URL("../css/admin.css",import.meta.url),"utf8"),
    readFile(new URL("../rail-ops-center.html",import.meta.url),"utf8"),
  ]);
  assert.match(script,/access-management/);assert.match(script,/access-create-form/);
  assert.match(script,/rotate-key/);assert.match(script,/revoke-sessions/);assert.match(script,/rolePermissions/);
  assert.match(script,/navigator\.clipboard\.writeText/);assert.match(script,/ONE-TIME CREDENTIAL/);
  assert.match(styles,/\.access-create-form/);assert.match(styles,/@media\(max-width:640px\).*access-create-form/);
  assert.match(html,/admin\.js\?v=observation-fusion-v2/);assert.match(html,/admin\.css\?v=ops-center-v5/);
});
