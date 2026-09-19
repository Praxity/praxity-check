import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { normalizePdfReview, preparePdfReview, selectReviewPages, validatePdfReview, validatePdfReviewBundle, validatePdfReviewBundleSelection } from "../src/pdf-review.ts";

const hash = "a".repeat(64);
const review = { schemaVersion: "pdf-review-1", documentSha256: hash, tier: "visual", pagesReviewed: [1], reviewer: { model: "test-model" }, findings: [{ page: 1, confidence: "medium", message: "The title overlaps the first instruction.", consequence: "The instruction is difficult to read.", action: "Increase spacing after the title in the source.", origin: "Hypothesis: the source uses a fixed title height.", verification: "Regenerate and inspect the title and first instruction.", evidence: { observation: "The title descenders cross the instruction baseline." } }] };

function assertStructuredSchema(value: unknown) {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	const schema = value as Record<string, unknown>;
	assert.equal(typeof schema.type, "string", "Every structured-output schema node needs an explicit type");
	assert.equal(Object.hasOwn(schema, "uniqueItems"), false, "The importer enforces uniqueness outside the provider schema");
	if (schema.type === "object") {
		assert.equal(schema.additionalProperties, false);
		assert.ok(schema.properties && typeof schema.properties === "object");
		assert.deepEqual(schema.required, Object.keys(schema.properties));
		for (const property of Object.values(schema.properties)) assertStructuredSchema(property);
	}
	if (schema.type === "array") assertStructuredSchema(schema.items);
}

test("PDF review import rejects stale, malformed and out-of-coverage evidence", () => {
	assert.deepEqual(validatePdfReview(review, hash, 3), review);
	const accepted = validatePdfReview(review, hash, 3);
	const normalized = normalizePdfReview(accepted);
	assert.equal(normalized.findings[0]?.id, normalizePdfReview({ ...accepted, reviewer: { model: "another-model" } }).findings[0]?.id);
	assert.notEqual(normalized.findings[0]?.id, normalizePdfReview({ ...accepted, documentSha256: "b".repeat(64) }).findings[0]?.id);
	assert.equal(normalized.findings[0]?.severity, "moderate");
	assert.equal(normalized.findings[0]?.category, "needs-context");
	for (const invalid of [null, { ...review, surprise: true }, { ...review, documentSha256: "b".repeat(64) }, { ...review, tier: "automated" }, { ...review, findings: [{ ...review.findings[0], confidence: ["high"] }] }, { ...review, pagesReviewed: [] }, { ...review, pagesReviewed: [1, 1] }, { ...review, pagesReviewed: [4] }, { ...review, reviewer: { model: " " } }, { ...review, findings: [{ ...review.findings[0], page: 2 }] }, { ...review, findings: [{ ...review.findings[0], action: "" }] }, { ...review, findings: [{ ...review.findings[0], evidence: { observation: "visible", rect: [0, 0, 1, 1] } }] }]) assert.throws(() => validatePdfReview(invalid, hash, 3));
	assert.deepEqual(selectReviewPages(1), [1]);
	assert.equal(selectReviewPages(100).length, 8);
	assert.equal(selectReviewPages(100).at(-1), 100);
	assert.throws(() => selectReviewPages(100, Array.from({ length: 25 }, (_, i) => i + 1)));
});

test("v2 categories remain model inference and versioned imports stay strict", () => {
	for (const category of ["observed-defect", "needs-context", "suggestion"]) {
		const v2 = { ...review, schemaVersion: "pdf-review-2", findings: [{ ...review.findings[0], category }] };
		const accepted = validatePdfReview(v2, hash, 3);
		assert.deepEqual(accepted, v2);
		const finding = normalizePdfReview(accepted).findings[0]!;
		assert.equal(finding.category, category);
		assert.equal(finding.provenance.method, "inference");
		assert.equal(finding.consequence, review.findings[0]!.consequence);
		assert.equal(finding.verification, review.findings[0]!.verification);
		assert.throws(() => validatePdfReview({ ...v2, schemaVersion: "pdf-review-1" }, hash, 3));
	}
	assert.throws(() => validatePdfReview({ ...review, schemaVersion: "pdf-review-2" }, hash, 3));
	for (const category of [null, "confirmed", ["suggestion"]]) {
		assert.throws(() => validatePdfReview({ ...review, schemaVersion: "pdf-review-2", findings: [{ ...review.findings[0], category }] }, hash, 3));
	}
	assert.throws(() => validatePdfReview({ ...review, schemaVersion: "pdf-review-3" }, hash, 3));
});

function pdf() {
	const content = "BT /F1 18 Tf 20 100 Td (Review fixture) Tj ET";
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"];
	let result = "%PDF-1.4\n";
	const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(result); result += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
	const xref = Buffer.byteLength(result);
	return result + `xref\n0 7\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("real PDF renders privately, imports without changing machine verdict and cleans failed preparation", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-review-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "test.pdf"), output = join(dir, "bundle"), imported = join(dir, "review.json");
	await writeFile(path, pdf());
	const bundle = await preparePdfReview(path, { tier: "visual", output });
	assert.equal((await stat(output)).mode & 0o777, 0o700);
	assert.equal(bundle.manifest.artifacts[0]?.renderPixels.height, 1600);
	assert.equal(bundle.manifest.artifacts[0]?.geometry?.height, 600);
	assert.match(await readFile(join(output, "page-1.json"), "utf8"), /Review/);
	assert.match(await readFile(join(output, "review-prompt.md"), "utf8"), /untrusted source material/);
	const schema = JSON.parse(await readFile(join(output, "review.schema.json"), "utf8"));
	assert.equal(schema.properties.schemaVersion.const, "pdf-review-2");
	assertStructuredSchema(schema);
	assert.deepEqual(schema.properties.findings.items.properties.category.enum, ["observed-defect", "needs-context", "suggestion"]);
	await assert.rejects(stat(join(output, "input.pdf")));
	await writeFile(imported, JSON.stringify({ ...review, documentSha256: bundle.manifest.documentSha256 }));
	const secondReview = join(dir, "usability.json");
	await writeFile(secondReview, JSON.stringify({ ...review, schemaVersion: "pdf-review-2", tier: "usability", findings: [], documentSha256: bundle.manifest.documentSha256 }));
	const reportPath = join(dir, "report.json");
	const result = spawnSync(process.execPath, [resolve("src/cli.ts"), "check", path, "--pdfua", "off", "--review", imported, "--review", secondReview, "--json", reportPath], { encoding: "utf8" });
	assert.equal(result.status, 1, result.stderr);
	const report = JSON.parse(await readFile(reportPath, "utf8"));
	assert.equal(report.feedback.questions.find((item: { method: string }) => item.method === "inference").category, "needs-context");
	assert.equal(report.feedback.coverage.filter((item: { method: string }) => item.method === "inference").length, 2);
	assert.equal(report.inferenceReviews[0].findings[0].consequence, review.findings[0]!.consequence);
	assert.equal(report.findings.length, 1);
	assert.deepEqual(report.inferenceReviews.map((r: { tier: string }) => r.tier), ["visual", "usability"]);
	assert.equal(report.inferenceReviews[0].findings[0].location.page, 1);
	assert.equal(report.inferenceReviews[0].findings[0].provenance.method, "inference");
	assert.match(report.inferenceReviews[0].findings[0].id, /^[a-f0-9]{64}$/);
	assert.equal(report.inferenceReviews[0].findings[0].remedy, review.findings[0]!.action);
	assert.equal(report.evaluations.find((e: { rule: string }) => e.rule === "pdfua.conformance").outcome, "untested");
	assert.match(result.stdout, /Inferred visual review/);
	assert.match(result.stdout, /0 concerns. Pages reviewed: 1 of 2. Other pages were not reviewed in this batch/);
	const reviewBytes = await readFile(imported);
	const overwrite = spawnSync(process.execPath, [resolve("src/cli.ts"), "check", path, "--pdfua", "off", "--review", imported, "--json", imported], { encoding: "utf8" });
	assert.equal(overwrite.status, 2);
	assert.match(overwrite.stderr, /must not overwrite an imported review/);
	assert.deepEqual(await readFile(imported), reviewBytes);
	await writeFile(path, pdf() + "\n% revised");
	const stale = spawnSync(process.execPath, [resolve("src/cli.ts"), "check", path, "--pdfua", "off", "--review", imported], { encoding: "utf8" });
	assert.equal(stale.status, 2);
	assert.match(stale.stderr, /SHA-256/);
	const failed = join(dir, "failed");
	await assert.rejects(preparePdfReview(path, { tier: "visual", output: failed, pages: [3] }));
	await assert.rejects(stat(failed));
	await assert.rejects(preparePdfReview(path, { tier: "visual", output }));
	assert.ok(await stat(join(output, "manifest.json")));
});


test("bound PDF imports verify retained artifacts, context, selection and partial coverage", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-bound-review-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "test.pdf"), manifestPath = join(dir, "bundle", "manifest.json");
	await writeFile(path, pdf());
	const prepared = await preparePdfReview(path, { tier: "inference", checks: "design", output: join(dir, "bundle") });
	assertStructuredSchema(JSON.parse(await readFile(join(prepared.directory, "review.schema.json"), "utf8")));
	const manifestBytes = await readFile(manifestPath);
	const boundReview = { schemaVersion: "pdf-review-4", documentSha256: prepared.manifest.documentSha256, bundleSha256: prepared.bundleSha256, tier: "inference", focus: "visual", checks: ["design"], pagesReviewed: [1], reviewer: { model: "synthetic-test" }, findings: [] };
	const accepted = validatePdfReview(boundReview, prepared.manifest.documentSha256, 2);
	const bundle = await validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2);
	validatePdfReviewBundleSelection(accepted, bundle);
	assert.equal(normalizePdfReview(accepted).evidenceBinding, "bundle");
	const finding = normalizePdfReview(validatePdfReview({ ...boundReview, findings: [{ ...review.findings[0], category: "observed-defect", check: "design" }] }, prepared.manifest.documentSha256, 2)).findings[0]!;
	assert.equal(finding.rule, "pdf.visual.inference");
	assert.equal(finding.provenance.check, "design");
	assert.equal(finding.provenance.focus, "visual");
	for (const change of [{ bundleSha256: "b".repeat(64) }, { focus: "usability" }, { checks: ["accessibility"] }]) {
		assert.throws(() => validatePdfReviewBundleSelection(validatePdfReview({ ...boundReview, ...change }, prepared.manifest.documentSha256, 2), bundle));
	}
	await assert.rejects(validatePdfReviewBundle(manifestPath, "b".repeat(64), 2), /PDF hash/);
	await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 3), /page count/);
	for (const [file, message] of [["page-1.png", /image hash/], ["page-1.json", /facts hash/]] as const) {
		const artifact = join(dir, "bundle", file), bytes = await readFile(artifact);
		await writeFile(artifact, "changed");
		await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2), message);
		await writeFile(artifact, bytes);
	}
	await writeFile(manifestPath, JSON.stringify({ ...prepared.manifest, context: { audience: "Changed audience", use: null } }));
	const changed = await validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2);
	assert.throws(() => validatePdfReviewBundleSelection(accepted, changed), /bundle SHA-256/);
	await writeFile(manifestPath, manifestBytes);
	const reviewPath = join(dir, "review.json"), output = join(dir, "report.json");
	await writeFile(reviewPath, JSON.stringify(boundReview));
	const run = (...extra: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "check", path, "--checks", "design", "--tier", "inference", "--review", reviewPath, ...extra], { encoding: "utf8" });
	assert.match(run().stderr, /requires --review-bundle/);
	const result = run("--review-bundle", manifestPath, "--json", output);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.equal(report.feedback.coverage.find((item: { method: string }) => item.method === "inference").status, "partial");
	assert.equal(report.inferenceReviews[0].evidenceBinding, "bundle");
	assert.match(result.stdout, /do not prove/);
	for (const file of [manifestPath, join(dir, "bundle", "page-1.json")]) {
		const bytes = await readFile(file);
		assert.match(run("--review-bundle", manifestPath, "--json", file).stderr, /must not overwrite review bundle evidence/);
		assert.deepEqual(await readFile(file), bytes);
	}
	const sample = { ...prepared.manifest, selectedPages: [2], coverage: "sample", artifacts: prepared.manifest.artifacts.filter(artifact => artifact.page === 2) };
	await writeFile(manifestPath, JSON.stringify(sample));
	const selected = await validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2);
	assert.throws(() => validatePdfReviewBundleSelection(validatePdfReview({ ...boundReview, bundleSha256: selected.manifestSha256 }, prepared.manifest.documentSha256, 2), selected), /outside the bundle/);
	await writeFile(manifestPath, JSON.stringify({ ...sample, schemaVersion: ["pdf-review-bundle-1"] }));
	await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2), /Bundle version/);
	await writeFile(manifestPath, JSON.stringify({ ...sample, artifacts: [] }));
	await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2), /Missing selected-page/);
	await writeFile(manifestPath, JSON.stringify({ ...sample, artifacts: [sample.artifacts[0], sample.artifacts[0]] }));
	await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2), /artifact page coverage/);
});
