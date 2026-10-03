import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { componentManifest } from "../src/components.ts";

test("runtime documentation covers consent, offline pins and doctor without obsolete bundling commands", async () => {
 const readme = await readFile("README.md", "utf8"), usage = await readFile("docs/using-it.md", "utf8"), offline = await readFile("docs/offline-components.md", "utf8");
 for (const document of [readme, usage]) {
  for (const phrase of ["setup --yes pdf html", "setup --list", "setup --from", "doctor pdf", "CHECK_COMPONENTS_DIR", "not run", "SHA-256", "after consent"]) assert.ok(document.includes(phrase), phrase);
  assert.doesNotMatch(document, /node scripts\/prepare-(?:runtimes|windows-java|homebrew)/);
 }
 assert.match(readme, /The package includes Node, Check, npm dependencies and PDFium/);
 assert.match(readme, /Launchers start Node and preserve explicit component variables/);
 assert.match(readme, /--dependencies.*packaging option is rejected/);
 for (const platform of ["win32", "darwin", "linux"]) for (const arch of platform === "win32" ? ["x64"] : ["arm64", "x64"]) {
  for (const component of await componentManifest({ platform, arch })) for (const archive of component.archives) {
   assert.ok(offline.includes(archive.url), archive.url); assert.ok(offline.includes(archive.sha256), archive.sha256); assert.ok(offline.includes(String(archive.size)));
  }
 }
 for (const path of ["NOTICE.md", "LICENSING.md"]) {
  const notice = await readFile(path, "utf8"); assert.match(notice, /(?:does not redistribute|do not include) the browser, Java or veraPDF/); assert.match(notice, /after consent/);
 }
});
