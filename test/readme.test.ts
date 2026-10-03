import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("runtime README retains preparation gates, notices and Windows Java proof",async()=>{
 const readme=await readFile("README.md","utf8");
 const windows=readme.split("### Prepare Windows x64 runtimes")[1]!.split("### Compare PDF engines")[0]!;
 const command=windows.match(/```powershell\n([\s\S]*?)```/)?.[1];
 assert.ok(command,"Windows commands use the repository's code fences");
 assert.match(command,/\$env:CHECK_WINDOWS_JAVA_RUNTIME = "\$build\/java-verapdf"/);
 assert.match(command,/node --test .*prepare-windows-java\.test\.mjs .*windows-pe\.test\.mjs/);
 for(const phrase of ["supplemental-notices/<package>/","Missing licences, unresolved libraries, filename collisions and conflicting runtime","veraPDF input must contain its project licence files","does not include a general browser UI","path with spaces","Source links alone do not fulfil source","Java and the libraries in veraPDF's jar need a separate review"]) assert.ok(readme.includes(phrase),phrase);
 assert.equal(readme.includes("~~~"),false);
});
