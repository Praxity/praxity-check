import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { extractPdfFacts } from "../src/pdf-facts.ts";
const path = resolve("test/fixtures/pdf-facts.pdf"), rules = ["pdf.open", "page.facts", "font.facts", "image.facts", "text.facts"];

test("real engine facts preserve the caller's snapshot and retain engine evidence", async () => {
	const before = await readFile(path), mode = (await stat(path)).mode;
	const result = await extractPdfFacts(path);
	assert.equal(result.machineStatus, "complete");
	assert.deepEqual(result.document, { sha256: "e1f5125f3debeb3acb2facce107d4cc8afc6078feb7fc86f2db30394e3e51bfe", bytes: 1071 });
	assert.deepEqual(result.evaluations.map(({rule,outcome}) => [rule,outcome]), rules.map(rule => [rule,"passed"]));
	assert.equal(result.engine.version, "2.15.1");
	assert.deepEqual(result.facts.words.map(w=>w.text), ["PDF","facts","fixture"]);
	assert.equal(result.evidence.length, 5);
	assert.ok(result.evidence.every(e => "engine" in e));
	assert.deepEqual(await readFile(path), before);
	assert.equal((await stat(path)).mode, mode);
});

test("wasm ceiling and deadline make every unavailable inventory explicitly untested", async () => {
	for(const limits of [{maxWasmBytes:1},{deadlineMs:1}]) {
		const result=await extractPdfFacts(path,limits);
		assert.equal(result.machineStatus,"incomplete");
		assert.deepEqual(result.evaluations.map(({rule,outcome})=>[rule,outcome]),rules.map(rule=>[rule,"untested"]));
		assert.deepEqual(result.facts.pages,[]);
		assert.ok(result.evidence.some(e=>e.error));
	}
});

test("both encrypted fixtures fail loudly and never expose successful inventories", async () => {
	for(const name of ["encrypted-open","encrypted-locked"]) {
		const result=await extractPdfFacts(resolve("test/fixtures/pdf-engine/"+name+".pdf"));
		assert.equal(result.machineStatus,"incomplete");
		assert.match(result.evaluations[0]!.reason,/Encrypted PDFs are not supported/);
		assert.ok(result.evaluations.every(e=>e.outcome==="untested"));
	}
});

test("snapshot read failures reject instead of returning empty facts", async () => {
	await assert.rejects(extractPdfFacts(resolve("test/fixtures/nonexistent-pdf-facts.pdf")),{code:"ENOENT"});
});

test("one failed inventory retains independent completed facts and marks its dependent rule untested",async()=>{
 const result=await extractPdfFacts(resolve("test/fixtures/pdf-engine/degenerate-image.pdf"));
 assert.equal(result.machineStatus,"incomplete");
 assert.deepEqual(result.evaluations.map(e=>[e.rule,e.outcome]),[
  ["pdf.open","passed"],["page.facts","passed"],["font.facts","passed"],["image.facts","untested"],["text.facts","passed"]
 ]);
 assert.match(result.evaluations.find(e=>e.rule==="image.facts")!.reason,/Invalid image resolution/);
 assert.equal(result.facts.pages.length,1);
});

test("a failed inventory retains preceding extraction diagnostics as a review item",async()=>{
 const result=await extractPdfFacts(resolve("test/fixtures/pdf-engine/partial-text-warning.pdf"));
 assert.equal(result.machineStatus,"incomplete");
 assert.equal(result.evaluations.find(e=>e.rule==="text.facts")!.outcome,"untested");
 assert.match(result.evaluations.find(e=>e.rule==="text.facts")!.reason,/Too much extracted text/);
 assert.ok(result.needsReview.some(r=>r.rule==="text.facts"&&r.evidence.includes("omitted 1 characters")));
 assert.ok(result.evidence.some(e=>"operation" in e&&e.operation==="words"&&e.outcome==="untested"&&e.diagnostics.some(d=>d.includes("omitted 1 characters"))));
});
