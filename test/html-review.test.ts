import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { discover } from "../src/discover.ts";
import { importHtmlReview, validateHtmlReview, type HtmlReview } from "../src/html-review.ts";
import { assertOutputOutside, snapshotInput } from "../src/input.ts";

const cli = resolve("src/cli.ts");
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const run = (args: string[], env = process.env) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
// Stored ZIP entries exercise the real extractor without a system zip dependency.
function zip(entries: Array<[string, string]>) {
	const local: Buffer[] = [], central: Buffer[] = [];
	let offset = 0;
	for (const [path, contents] of entries) {
		const name = Buffer.from(path), data = Buffer.from(contents);
		const header = Buffer.alloc(30), directory = Buffer.alloc(46);
		header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc32(data), 14);
		header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
		directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc32(data), 16);
		directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
		local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

const html = `<!doctype html><html lang="en"><head><title>Synthetic tabs</title><link rel="stylesheet" href="asset.css"></head><body><h1>Sections</h1><div role="tablist" aria-label="Sections"><button role="tab" id="one" aria-selected="true" aria-controls="panel-one">One</button><button role="tab" id="two" tabindex="-1" aria-selected="false" aria-controls="panel-two">Two</button></div><section id="panel-one" role="tabpanel" aria-labelledby="one">First section</section><section id="panel-two" role="tabpanel" aria-labelledby="two" hidden>Second section</section><button></button></body></html>`;
const css = "body { color: black; background: white; }";

test("HTML bundle captures real actions, imports retained evidence without browser/check execution and rejects invalid or stale reviews", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "check-html-review-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const source = join(dir, "source"), bundle = join(dir, "bundle"), archive = join(dir, "course.zip"), output = join(dir, "report.json");
	await mkdir(source);
	await writeFile(join(source, "index.html"), html); await writeFile(join(source, "asset.css"), css);
	await writeFile(archive, zip([["index.html", html], ["asset.css", css]]));
	const prepared = run(["prepare-review", archive, "--tier", "inference", "--checks", "accessibility", "--output", bundle]);
	assert.equal(prepared.status, 0, prepared.stderr);
	assert.match(prepared.stdout, /Prepared interactions/);
	const evidence = JSON.parse(await readFile(join(bundle, "evidence.json"), "utf8"));
	const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
	const schema = JSON.parse(await readFile(join(bundle, "review.schema.json"), "utf8"));
	assert.deepEqual(schema.properties.schemaVersion.enum, ["html-review-2"]);
	assert.deepEqual(schema.properties.contentSha256.enum, [manifest.contentSha256]);
	assert.deepEqual(schema.properties.evidenceSha256.enum, [manifest.evidenceSha256]);
	const candidate = evidence.candidates.find((item: { surface: string }) => item.surface === "tabs");
	assert.ok(candidate, "real browser must collect tabs");
	const trace = candidate.traces.find((item: { action: string }) => item.action === "ArrowRight");
	assert.match(trace.before, /button#one/); assert.match(trace.after, /button#one/, "defective tab retains focus after ArrowRight");
	const finding = { page: "index.html", candidateId: candidate.id, stateId: candidate.stateId, check: "accessibility" as const, category: "observed-defect" as const, claim: "executed-behavior" as const, confidence: "high" as const, message: "ArrowRight leaves focus on the first tab.", action: "Move focus to the next tab on ArrowRight.", consequence: "Keyboard users cannot reach the second tab with the expected arrow key.", verification: "Focus the first tab and press ArrowRight.", evidence: { observation: "The recorded ArrowRight action retains button#one as the active element.", traceIds: [trace.id] } };
	const review: HtmlReview = { schemaVersion: "html-review-1", contentSha256: manifest.contentSha256, evidenceSha256: manifest.evidenceSha256, checks: ["accessibility"], tier: "inference", pagesReviewed: ["index.html"], candidatesReviewed: [candidate.id], reviewer: { model: "synthetic-review-fixture" }, findings: [finding, { ...finding, category: "needs-context" }, { ...finding, category: "suggestion" }] };
	const reviewPath = join(bundle, "review.json");
	await writeFile(reviewPath, JSON.stringify(review));
	const snapshot = await snapshotInput(source);
	t.after(snapshot.cleanup);
	assert.equal(snapshot.contentSha256, manifest.contentSha256, "folder and ZIP revisions hash identical paths and bytes");
	const discovery = await discover(snapshot.root, "http://127.0.0.1:1");
	const imported = await importHtmlReview(reviewPath, snapshot.contentSha256, discovery);
	assert.equal(imported.findings[0]?.location.selector, candidate.selector);
	assert.equal(imported.findings[0]?.provenance.model, "synthetic-review-fixture");
	assert.equal(imported.retainedEvidence.candidates[0]?.traces[0]?.id, trace.id);
	const unavailableBrowser = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dir, "no-browser") };
	const checked = run(["check", source, "--tier", "inference", "--review", reviewPath, "--json", output], unavailableBrowser);
	assert.equal(checked.status, 0, checked.stderr);
	assert.match(checked.stdout, /Deterministic checks were not selected/);
	assert.match(checked.stdout, /ArrowRight leaves focus/); assert.match(checked.stdout, /Move focus to the next tab/);
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.deepEqual(report.findings, []); assert.deepEqual(report.evaluations, []); assert.deepEqual(report.rules, []);
	assert.equal(report.environment.browser, null);
	assert.deepEqual(report.selection, { checks: ["accessibility"], tier: "inference" });
	for (const category of ["findings", "questions", "suggestions"]) {
		assert.equal(report.feedback[category].length, 1);
		assert.equal(report.feedback[category][0].method, "inference");
		assert.equal(report.feedback[category][0].location.contentSha256, snapshot.contentSha256);
		assert.equal(report.feedback[category][0].location.selector, candidate.selector);
		assert.equal(report.feedback[category][0].location.rectangle, undefined);
	}
	assert.ok(report.feedback.coverage.some((item: { method: string; outcome?: string }) => item.method === "deterministic" && item.outcome === "untested"));
	for (const item of [...report.feedback.findings, ...report.feedback.questions, ...report.feedback.suggestions]) {
		for (const pointer of [item.source, item.evidence, ...item.provenance]) assert.ok(pointer.slice(1).split("/").reduce((value: Record<string, unknown>, key: string) => value[key], report));
	}
	const combined = run(["check", source, "--review", reviewPath, "--json", output]);
	assert.equal(combined.status, 1, combined.stderr);
	const mixed = JSON.parse(await readFile(output, "utf8"));
	assert.ok(mixed.findings.length > 0, "omitted tier keeps deterministic checks active");
	assert.ok(mixed.evaluations.length > 0);
	assert.equal(mixed.inferenceReviews.length, 1);
	assert.match(combined.stdout, /tier was omitted/);
	assert.equal(mixed.feedback.findings.filter((item: { method: string }) => item.method === "inference").length, 1);
	for (const change of [
		{ contentSha256: "0".repeat(64) }, { evidenceSha256: "0".repeat(64) }, { pagesReviewed: ["unknown.html"] },
		{ candidatesReviewed: ["0".repeat(64)] }, { candidatesReviewed: [] }, { pagesReviewed: [] }, { checks: ["design"] }, { tier: "deterministic" },
		{ reviewer: { model: "" } }, { unknown: true }, { findings: new Array(201).fill(finding) },
		...["page", "candidateId", "stateId", "confidence", "claim"].map((key) => ({ findings: [{ ...finding, [key]: [finding[key as keyof typeof finding]] }] })),
		...[{ check: "design" }, { page: "missing.html" }, { stateId: "0".repeat(64) }, { candidateId: "0".repeat(64) }, { evidence: { observation: "Static DOM", traceIds: [] } }, { evidence: { observation: "Unknown action", traceIds: ["0".repeat(64)] } }, { evidence: { observation: "Invented geometry", traceIds: [trace.id], rectangle: [1, 2, 3, 4] } }, { message: "x".repeat(4001) }].map((patch) => ({ findings: [{ ...finding, ...patch }] })),
	]) assert.throws(() => validateHtmlReview({ ...review, ...change }, snapshot.contentSha256, manifest.evidenceSha256, evidence));
	assert.doesNotThrow(() => validateHtmlReview({ ...review, findings: [{ ...finding, category: "needs-context", claim: "structure", evidence: { observation: "DOM relationship requires review.", traceIds: [] } }] }, snapshot.contentSha256, manifest.evidenceSha256, evidence));
	const coverage: HtmlReview = { ...review, schemaVersion: "html-review-2", findings: [{ ...finding, category: "needs-context", claim: "coverage", action: "Record the untested opening path before deciding whether a source change is needed.", evidence: { observation: "The opener was not exercised.", traceIds: [] } }] };
	assert.doesNotThrow(() => validateHtmlReview(coverage, snapshot.contentSha256, manifest.evidenceSha256, evidence));
	assert.throws(() => validateHtmlReview({ ...coverage, schemaVersion: "html-review-1" }, snapshot.contentSha256, manifest.evidenceSha256, evidence), /Coverage/);
	for (const category of ["observed-defect", "suggestion"]) assert.throws(() => validateHtmlReview({ ...coverage, findings: [{ ...coverage.findings[0], category }] }, snapshot.contentSha256, manifest.evidenceSha256, evidence), /Coverage/);
	await writeFile(reviewPath, JSON.stringify(coverage));
	const importedCoverage = run(["check", source, "--tier", "inference", "--review", reviewPath, "--json", output], unavailableBrowser);
	assert.equal(importedCoverage.status, 0, importedCoverage.stderr);
	const coverageReport = JSON.parse(await readFile(output, "utf8"));
	assert.equal(coverageReport.feedback.questions.length, 1);
	assert.equal(coverageReport.feedback.findings.length, 0);
	assert.equal(coverageReport.inferenceReviews[0].findings[0].claim, "coverage");
	await writeFile(reviewPath, JSON.stringify(review));
	assert.equal(run(["check", source, "--tier", "deterministic", "--review", reviewPath]).status, 2);
	assert.equal(run(["check", source, "--tier", "inference"]).status, 2);
	assert.equal(run(["check", source, "--checks", "design", "--tier", "inference", "--review", reviewPath]).status, 2);
	assert.equal(run(["check", source, "--tier", "inference", "--review", reviewPath, "--json", reviewPath]).status, 2);
	assert.equal(run(["check", source, "--tier", "inference", "--review", reviewPath, "--json", join(source, "report.json")]).status, 2);
	assert.equal(run(["check", archive, "--json", archive], unavailableBrowser).status, 2);
	assert.equal(run(["prepare-review", source, "--output", join(source, "bundle")], unavailableBrowser).status, 2);
	const alias = join(dir, "alias"); await symlink(source, alias);
	await assert.rejects(assertOutputOutside(join(alias, "report.json"), [source]), /outside/);
	await assert.rejects(snapshotInput(alias), /symlinks/);
	const hardlink = join(dir, "hardlink.json"); await link(join(source, "index.html"), hardlink);
	assert.equal(run(["check", source, "--tier", "inference", "--review", reviewPath, "--json", hardlink], unavailableBrowser).status, 0);
	assert.equal(await readFile(join(source, "index.html"), "utf8"), html, "atomic output must preserve a hardlinked source");
	await writeFile(join(source, "asset.css"), css + "button { display: none; }");
	const stale = run(["check", source, "--tier", "inference", "--review", reviewPath], unavailableBrowser);
	assert.equal(stale.status, 2); assert.match(stale.stderr, /content revision/);
	assert.equal(await readFile(join(snapshot.root, "asset.css"), "utf8"), css, "private snapshot retains original asset");
	await writeFile(archive, zip([["index.html", html], ["asset.css", "changed"]]));
	assert.match(run(["check", archive, "--tier", "inference", "--review", reviewPath], unavailableBrowser).stderr, /content revision/);
	await writeFile(join(source, "asset.css"), css);
	await writeFile(reviewPath, " ".repeat(2 * 1024 * 1024 + 1));
	await assert.rejects(importHtmlReview(reviewPath, snapshot.contentSha256, discovery), /exceeds/);
	await writeFile(reviewPath, "{"); await assert.rejects(importHtmlReview(reviewPath, snapshot.contentSha256, discovery), SyntaxError);
	await writeFile(reviewPath, JSON.stringify(review));
	await writeFile(join(bundle, "evidence.json"), "{}");
	await assert.rejects(importHtmlReview(reviewPath, snapshot.contentSha256, discovery), /SHA-256/);
	// Even with updated artifact hashes, malformed retained evidence remains invalid.
	candidate.surface = ["tabs"];
	const bytes = JSON.stringify(evidence); await writeFile(join(bundle, "evidence.json"), bytes);
	await writeFile(join(bundle, "manifest.json"), JSON.stringify({ ...manifest, evidenceSha256: digest(bytes) }));
	await assert.rejects(importHtmlReview(reviewPath, snapshot.contentSha256, discovery), /candidate/);
});
