import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { comparePdfReports } from "../src/pdf-compare.ts";

function fixture(letter = "a") {
	const sha256 = letter.repeat(64);
	return { schemaVersion: "pdf-1", document: { sha256 }, machineStatus: "complete", policy: { pdfua: "off", paperSize: "A4" },
		facts: { pages: [{ page: 1 }] }, evidence: [{ tool: "pdffonts", args: ["-v"], exitCode: 0, stdout: "", stderr: "pdffonts 1" }, { tool: "pdfinfo", args: ["-v"], exitCode: 0, stdout: "pdfinfo 1", stderr: "" }],
		evaluations: [{ rule: "font.facts", outcome: "passed" }, { rule: "page.facts", outcome: "passed" }, { rule: "font.embedding", outcome: "failed" }],
		findings: [{ id: `${letter}-font`, rule: "font.embedding", message: "Font missing", location: { documentSha256: sha256 } }], needsReview: [] };
}
function repaired() { const r = fixture("b"); r.findings = []; r.evaluations[2]!.outcome = "passed"; return r; }

test("explicit comparable font and paper-size passes establish machine resolution only", () => {
	const before = fixture(), after = repaired();
	const result = comparePdfReports(before, after);
	assert.equal(result.groups[0]!.status, "resolved");
	assert.equal(result.beforeSha256, "a".repeat(64)); assert.equal(result.afterSha256, "b".repeat(64));
	assert.deepEqual(result.groups[0]!.beforeIds, ["a-font"]); assert.deepEqual(result.groups[0]!.afterIds, []);
	before.findings[0]!.rule = "page.geometry"; before.evaluations[2]!.rule = "page.geometry"; after.evaluations[2]!.rule = "page.geometry";
	assert.equal(comparePdfReports(before, after).groups[0]!.status, "resolved");
});

test("incomplete extraction, changed policy/version, unknown version and page changes prevent resolution", () => {
	for (const mutate of [
		(r: ReturnType<typeof fixture>) => { r.machineStatus = "incomplete"; },
		(r: ReturnType<typeof fixture>) => { r.policy.paperSize = "Letter"; },
		(r: ReturnType<typeof fixture>) => { r.evidence[0]!.stderr = "pdffonts 2"; },
		(r: ReturnType<typeof fixture>) => { r.evidence = []; },
		(r: ReturnType<typeof fixture>) => { r.facts.pages.push({ page: 2 }); },
		(r: ReturnType<typeof fixture>) => { r.evaluations[0]!.outcome = "untested"; },
		(r: ReturnType<typeof fixture>) => { r.evaluations[2]!.outcome = "inapplicable"; },
	]) { const after = repaired(); mutate(after); assert.equal(comparePdfReports(fixture(), after).groups[0]!.status, "unverified"); }
});

test("incomplete page extraction can retain validator page findings without claiming resolution", () => {
	const before = fixture(), after = repaired();
	before.evaluations[1]!.outcome = "untested";
	const result = comparePdfReports({ ...before, machineStatus: "incomplete", facts: { pages: [] }, findings: [{ ...before.findings[0]!, location: { documentSha256: before.document.sha256, page: 3 } }] }, after);
	assert.equal(result.groups[0]!.status, "unverified");
});

test("grouping retains revision IDs and counts without claiming individual identity or repairs", () => {
	const before = fixture(), after = fixture("b"); before.findings.push({ ...before.findings[0]!, id: "second-a" });
	const group = comparePdfReports(before, after).groups[0]!;
	assert.equal(group.status, "reported-again"); assert.equal(group.beforeCount, 2); assert.equal(group.afterCount, 1);
	assert.deepEqual(group.afterIds, ["b-font"]);
	after.findings[0]!.message = "Different reported issue";
	assert.deepEqual(comparePdfReports(before, after).groups.map((g) => g.status), ["unverified", "newly-reported"]);
});

test("model silence and needsReview silence remain unverified", () => {
	const before = fixture(), after = repaired();
	const review = (sha: string, findings: unknown[]) => ({ tier: "visual", documentSha256: sha, pagesReviewed: [1], findings });
	const inferred = { id: "inferred-a", rule: "pdf.visual.inference", message: "Clipped text", location: { documentSha256: before.document.sha256, page: 1 }, evidence: { observation: "Last word cut at right edge" } };
	const result = comparePdfReports({ ...before, needsReview: before.findings, inferenceReviews: [review(before.document.sha256, [inferred])] }, { ...after, inferenceReviews: [review(after.document.sha256, [])] });
	assert.equal(result.groups.find((g) => g.kind === "needsReview")!.status, "unverified");
	assert.equal(result.groups.find((g) => g.kind === "inference")!.status, "unverified");
});

test("complete matching PDF/UA coverage establishes absent failed rule; legacy coverage does not", () => {
	const rule = "pdfua:ISO 14289-1:2014:7.1:1";
	const before = fixture(), after = repaired(); before.findings[0]!.rule = rule;
	before.evaluations.push({ rule: "pdfua.machine", outcome: "failed" }); after.evaluations.push({ rule: "pdfua.machine", outcome: "passed" });
	const validator = (failed: number) => ({ name: "veraPDF", profile: "ua1", version: "1.30.2", machineCompliant: failed === 0, coverage: { status: "complete", failedChecks: failed, retainedChecks: failed, omittedChecks: 0, rules: failed ? [{ rule, failedChecks: failed, retainedChecks: failed, omittedChecks: 0 }] : [] } });
	assert.equal(comparePdfReports({ ...before, pdfuaValidation: validator(1) }, { ...after, pdfuaValidation: validator(0) }).groups[0]!.status, "resolved");
	assert.equal(comparePdfReports(before, after).groups[0]!.status, "unverified");
	assert.throws(() => comparePdfReports({ ...before, pdfuaValidation: { ...validator(1), profile: ["ua1"] } }, after));
	assert.throws(() => comparePdfReports({ ...before, pdfuaValidation: { ...validator(1), machineCompliant: true } }, after));
	assert.throws(() => comparePdfReports({ ...before, findings: [], pdfuaValidation: validator(1) }, after));
	assert.throws(() => comparePdfReports({ ...before, pdfuaValidation: validator(1) }, { ...after, evaluations: [{ rule: "pdfua.machine", outcome: "failed" }], pdfuaValidation: validator(0) }));
});

test("malformed consumed JSON fields and contradictory coverage are rejected", () => {
	for (const value of [null, {}, { ...fixture(), schemaVersion: "pdf-2" }, { ...fixture(), machineStatus: ["complete"] }, { ...fixture(), document: { sha256: "bad" } }, { ...fixture(), findings: [{ ...fixture().findings[0], location: { documentSha256: "b".repeat(64) } }] }, { ...fixture(), policy: { nested: {} } }, { ...fixture(), evaluations: [{ rule: "font.embedding", outcome: "fixed" }] }]) assert.throws(() => comparePdfReports(value, repaired()));
});

test("CLI prints JSON without writing files and enforces bounded regular-file input", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-compare-test-"));
	try {
		const before = join(dir, "before.json"), after = join(dir, "after.json");
		const original = JSON.stringify(fixture()); await writeFile(before, original); await writeFile(after, JSON.stringify(repaired()));
		const invoke = (...args: string[]) => spawnSync(process.execPath, ["src/cli.ts", "compare-pdf", ...args], { encoding: "utf8" });
		const result = invoke(before, after, "--json"); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).groups[0].status, "resolved");
		assert.equal(await readFile(before, "utf8"), original);
		assert.equal(invoke(before, after, "--json", before).status, 2);
		assert.equal(invoke(dir, after).status, 2);
		await writeFile(before, " ".repeat(64 * 1024 * 1024 + 1)); assert.equal(invoke(before, after).status, 2);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("page relocation and changed model observations do not match identities", () => {
	const before = fixture(), after = fixture("b");
	before.facts.pages.push({ page: 2 }); after.facts.pages.push({ page: 2 });
	const concern = (sha: string, page: number, observation: string) => ({ id: `${sha[0]}-${page}`, rule: "pdf.visual.inference", message: "Clipped text", location: { documentSha256: sha, page }, evidence: { observation } });
	const report = (base: ReturnType<typeof fixture>, page: number, observation: string) => ({ ...base, inferenceReviews: [{ tier: "visual", documentSha256: base.document.sha256, pagesReviewed: [1, 2], findings: [concern(base.document.sha256, page, observation)] }] });
	for (const [page, observation] of [[2, "right edge"], [1, "bottom edge"]] as const) {
		const groups = comparePdfReports(report(before, 1, "right edge"), report(after, page, observation)).groups.filter((g) => g.kind === "inference");
		assert.deepEqual(groups.map((g) => g.status), ["unverified", "newly-reported"]);
	}
});

test("CLI rejects a FIFO without waiting for a writer", { skip: process.platform === "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-compare-fifo-"));
	try {
		const fifo = join(dir, "before.json"), after = join(dir, "after.json");
		const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
		assert.equal(created.status, 0, created.stderr);
		await writeFile(after, JSON.stringify(repaired()));
		const result = spawnSync(process.execPath, ["src/cli.ts", "compare-pdf", fifo, after], { encoding: "utf8", timeout: 5000 });
		assert.equal(result.error, undefined);
		assert.equal(result.status, 2, result.stderr);
		assert.match(result.stderr, /regular JSON file/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});


test("equivalent effective PDF policies resolve across explicit defaults and legacy reports", () => {
	for (const [beforePolicy, afterPolicy] of [
		[{}, { pdfua: "ua1", checks: "design,accessibility", tier: "deterministic" }],
		[{ checks: "design" }, { checks: "design", tier: "deterministic", pdfua: "ua1" }],
		[{ tier: "deterministic" }, { checks: "accessibility", tier: "deterministic", pdfua: "ua1" }],
		[{ checks: undefined, tier: undefined, pdfua: undefined }, { checks: "accessibility,design", tier: "deterministic", pdfua: "ua1" }],
	]) {
		const result = comparePdfReports({ ...fixture(), policy: beforePolicy }, { ...repaired(), policy: afterPolicy });
		assert.equal(result.comparison.policySame, true);
		assert.equal(result.groups[0]!.status, "resolved");
	}
});

test("effective policy comparison preserves domain, tier, threshold and unknown-field differences", () => {
	for (const policy of [
		{ tier: "deterministic" }, { checks: "design" }, { tier: "inference", checks: "accessibility,design" },
		{ pdfua: "ua2" }, { maxSparseWords: 20 }, { minImagePpi: 150 }, { paperSize: "Letter" },
		{ futureCheck: true }, { veraPdfPath: "/other/verapdf" },
	]) {
		const result = comparePdfReports({ ...fixture(), policy: {} }, { ...repaired(), policy });
		assert.equal(result.comparison.policySame, false, JSON.stringify(policy));
		assert.equal(result.groups[0]!.status, "unverified");
	}
	assert.equal(comparePdfReports({ ...fixture(), policy: { minImagePpi: 150, futureCheck: true } }, { ...repaired(), policy: { minImagePpi: 300, futureCheck: true } }).comparison.policySame, false);
	assert.equal(comparePdfReports({ ...fixture(), policy: { futureCheck: true } }, { ...repaired(), policy: { futureCheck: false } }).comparison.policySame, false);
	for (const policy of [{ maxSparseWords: 0 }, { minImagePpi: -1 }, { pdfua: "invalid" }, { checks: "design,design" }, { tier: "visual" }]) {
		assert.throws(() => comparePdfReports({ ...fixture(), policy }, repaired()));
	}
});
