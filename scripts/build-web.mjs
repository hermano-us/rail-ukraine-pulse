import { cp, mkdir, rm } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);
const entries = ["index.html", "admin.html", "assets", "css", "data", "js", "shared", "THIRD_PARTY_NOTICES.md"];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of entries) {
  await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
}
console.log("Static application built in dist/");