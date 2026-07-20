import { cp, mkdir, rm } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);
const requiredEntries = ["index.html", "admin.html", "css", "data", "js", "shared", "THIRD_PARTY_NOTICES.md"];
const optionalEntries = ["assets"];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of requiredEntries) {
  await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
}

for (const entry of optionalEntries) {
  try {
    await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
console.log("Static application built in dist/");
