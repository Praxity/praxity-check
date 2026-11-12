import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { componentManifest } from "../src/components.ts";

// Offline setup users copy these URLs and hashes; the notices state what the package omits.
test("offline component docs list every pinned archive, and notices say the package omits downloaded components", async () => {
 const offline = await readFile("docs/offline-components.md", "utf8");
 for (const platform of ["win32", "darwin", "linux"]) for (const arch of platform === "win32" ? ["x64"] : ["arm64", "x64"]) {
  for (const component of await componentManifest({ platform, arch })) for (const archive of component.archives) {
   assert.ok(offline.includes(archive.url), archive.url); assert.ok(offline.includes(archive.sha256), archive.sha256); assert.ok(offline.includes(String(archive.size)));
  }
 }
 for (const path of ["NOTICE.md", "LICENSING.md"]) {
  const notice = await readFile(path, "utf8"); assert.match(notice, /(?:does not redistribute|do not include) the browser, Java or veraPDF/); assert.match(notice, /after consent/);
 }
});
