import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);
const requiredEntries = ["index.html", "rail-ops-center.html", "fuel", "css", "data", "js", "shared", "THIRD_PARTY_NOTICES.md"];
const optionalEntries = ["assets", "manifest.webmanifest", "sw.js"];

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
// Carta.ua explicitly permitted redistribution of this partner photo set. Keep
// source filenames private to the import bundle and expose stable, URL-safe names.
try {
  const carta = JSON.parse(await readFile(new URL("AZC/azs_full_data.json", root), "utf8"));
  const photoOutput = new URL("assets/fuel/carta/", output);
  await mkdir(photoOutput, { recursive: true });
  for (const station of carta) {
    for (const [index, relativePath] of (station.local_photos || []).entries()) {
      const assetName = `${createHash("sha256").update(String(relativePath)).digest("hex").slice(0, 20)}.jpg`;
      await cp(new URL(`AZC/${relativePath}`, root), new URL(assetName, photoOutput));
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

console.log("Static application built in dist/");
