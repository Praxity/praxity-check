import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { acceptPdfReview, preparePdfReview, selectReviewPages, validatePdfReviewBundle } from "../src/pdf-review.ts";

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

test("PDF review acceptance rejects stale, malformed and out-of-coverage evidence", async () => {
	const accepted = await acceptPdfReview(review, hash, 3);
	assert.deepEqual(accepted.review, review);
	const normalized = accepted.normalized;
	assert.equal(normalized.evidenceBinding, "document-only");
	assert.equal(normalized.findings[0]?.id, (await acceptPdfReview({ ...review, reviewer: { model: "another-model" } }, hash, 3)).normalized.findings[0]?.id);
	assert.notEqual(normalized.findings[0]?.id, (await acceptPdfReview({ ...review, documentSha256: "b".repeat(64) }, "b".repeat(64), 3)).normalized.findings[0]?.id);
	assert.equal(normalized.findings[0]?.severity, "moderate");
	assert.equal(normalized.findings[0]?.category, "needs-context");
	for (const invalid of [null, { ...review, surprise: true }, { ...review, documentSha256: "b".repeat(64) }, { ...review, tier: "automated" }, { ...review, findings: [{ ...review.findings[0], confidence: ["high"] }] }, { ...review, pagesReviewed: [] }, { ...review, pagesReviewed: [1, 1] }, { ...review, pagesReviewed: [4] }, { ...review, reviewer: { model: " " } }, { ...review, findings: [{ ...review.findings[0], page: 2 }] }, { ...review, findings: [{ ...review.findings[0], action: "" }] }, { ...review, findings: [{ ...review.findings[0], evidence: { observation: "visible", rect: [0, 0, 1, 1] } }] }]) await assert.rejects(acceptPdfReview(invalid, hash, 3));
	assert.deepEqual(selectReviewPages(1), [1]);
	assert.equal(selectReviewPages(100).length, 8);
	assert.equal(selectReviewPages(100).at(-1), 100);
	assert.throws(() => selectReviewPages(100, Array.from({ length: 25 }, (_, i) => i + 1)));
});

test("v2 categories remain model inference and versioned imports stay strict", async () => {
	for (const category of ["observed-defect", "needs-context", "suggestion"]) {
		const v2 = { ...review, schemaVersion: "pdf-review-2", findings: [{ ...review.findings[0], category }] };
		const accepted = await acceptPdfReview(v2, hash, 3);
		assert.deepEqual(accepted.review, v2);
		const finding = accepted.normalized.findings[0]!;
		assert.equal(finding.category, category);
		assert.equal(finding.provenance.method, "inference");
		assert.equal(finding.consequence, review.findings[0]!.consequence);
		assert.equal(finding.verification, review.findings[0]!.verification);
		await assert.rejects(acceptPdfReview({ ...v2, schemaVersion: "pdf-review-1" }, hash, 3));
	}
	await assert.rejects(acceptPdfReview({ ...review, schemaVersion: "pdf-review-2" }, hash, 3));
	for (const category of [null, "confirmed", ["suggestion"]]) {
		await assert.rejects(acceptPdfReview({ ...review, schemaVersion: "pdf-review-2", findings: [{ ...review.findings[0], category }] }, hash, 3));
	}
	await assert.rejects(acceptPdfReview({ ...review, schemaVersion: "pdf-review-3" }, hash, 3));
});

async function retainedBundle() {
	const directory = await mkdtemp(join(tmpdir(), "pdf-acceptance-test-"));
	const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
	const artifacts = [];
	for (const page of [1, 2]) {
		const image = `page-${page}.png`, facts = `page-${page}.json`;
		const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), factsBytes = JSON.stringify({ page, words: [] });
		await writeFile(join(directory, image), imageBytes);
		await writeFile(join(directory, facts), factsBytes);
		artifacts.push({ page, image, imageSha256: sha256(imageBytes), facts, factsSha256: sha256(factsBytes) });
	}
	const manifest = { schemaVersion: "pdf-review-bundle-2", documentSha256: hash, pageCount: 3, selectedPages: [1, 2], tier: "inference", focus: "visual", checks: ["design"], coverage: "sample", context: { audience: "New staff", use: "Read instructions" }, artifacts };
	const manifestBytes = JSON.stringify(manifest), manifestPath = join(directory, "manifest.json");
	await writeFile(manifestPath, manifestBytes);
	const boundReview = { schemaVersion: "pdf-review-4", documentSha256: hash, bundleSha256: sha256(manifestBytes), tier: "inference", focus: "visual", checks: ["design"], pagesReviewed: [1], reviewer: { model: "test-model" }, findings: [] };
	return { directory, manifest, manifestPath, boundReview };
}

test("acceptance requires a verified bundle for v4 and reuses it for two reviews", async (t) => {
	const { directory, manifestPath, boundReview } = await retainedBundle();
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(acceptPdfReview(boundReview, hash, 3), { message: "PDF review v4 requires --review-bundle manifest.json" });
	await assert.rejects(acceptPdfReview({ ...boundReview, bundleSha256: "invalid" }, hash, 3), { message: "Invalid PDF review bundle SHA-256" });
	const bundle = await validatePdfReviewBundle(manifestPath, hash, 3);
	assert.deepEqual(bundle.paths, [manifestPath, join(directory, "page-1.png"), join(directory, "page-1.json"), join(directory, "page-2.png"), join(directory, "page-2.json")]);
	const first = await acceptPdfReview(boundReview, hash, 3, { bundle, checks: "design" });
	const second = await acceptPdfReview({ ...boundReview, pagesReviewed: [2], reviewer: { model: "another-model" } }, hash, 3, { bundle });
	assert.equal(first.normalized.evidenceBinding, "bundle");
	assert.equal(second.normalized.evidenceBinding, "bundle");
	assert.deepEqual(first.normalized.pagesReviewed, [1]);
	assert.deepEqual(second.normalized.pagesReviewed, [2]);
	assert.equal(second.normalized.reviewer.model, "another-model");
	const { bundleSha256, ...unbound } = boundReview;
	assert.equal((await acceptPdfReview({ ...unbound, schemaVersion: "pdf-review-3" }, hash, 3, { bundle })).normalized.evidenceBinding, "document-only");
	await assert.rejects(acceptPdfReview(boundReview, hash, 3, { bundle, checks: "accessibility" }), { message: "Imported PDF review includes an unselected check domain." });
	await assert.rejects(acceptPdfReview({ ...boundReview, documentSha256: "b".repeat(64) }, "b".repeat(64), 3, { bundle }), { message: "Bundle version or PDF hash mismatch" });
	await assert.rejects(acceptPdfReview(boundReview, hash, 4, { bundle }), { message: "Bundle page count mismatch" });
});

test("acceptance rejects tampered retained evidence, changed context and bundle selection", async (t) => {
	const { directory, manifest, manifestPath, boundReview } = await retainedBundle();
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const [file, message] of [["page-1.png", "Artifact image hash mismatch"], ["page-1.json", "Artifact facts hash mismatch"]] as const) {
		const path = join(directory, file), bytes = await readFile(path);
		await writeFile(path, "changed");
		await assert.rejects(acceptPdfReview(boundReview, hash, 3, { bundle: manifestPath }), { message });
		await writeFile(path, bytes);
	}
	await writeFile(manifestPath, JSON.stringify({ ...manifest, context: { audience: "Changed audience", use: "Read instructions" } }));
	await assert.rejects(acceptPdfReview(boundReview, hash, 3, { bundle: manifestPath }), { message: "PDF review bundle SHA-256 does not match; prepare a new review after changing evidence or context" });
	await writeFile(manifestPath, JSON.stringify(manifest));
	const bundle = await validatePdfReviewBundle(manifestPath, hash, 3);
	await assert.rejects(acceptPdfReview({ ...boundReview, pagesReviewed: [3] }, hash, 3, { bundle }), { message: "Review includes a page outside the bundle selected pages" });
	await assert.rejects(acceptPdfReview({ ...boundReview, focus: "usability" }, hash, 3, { bundle, checks: "accessibility" }), { message: "Review focus or check domains mismatch" });
	await assert.rejects(acceptPdfReview({ ...boundReview, checks: ["accessibility"] }, hash, 3, { bundle }), { message: "Review focus or check domains mismatch" });
	await assert.rejects(acceptPdfReview({ ...boundReview, bundleSha256: "b".repeat(64) }, hash, 3, { bundle }), { message: "PDF review bundle SHA-256 does not match; prepare a new review after changing evidence or context" });
	await assert.rejects(acceptPdfReview({ ...boundReview, bundleSha256: "b".repeat(64), tier: "visual" }, hash, 3, { bundle }), { message: "PDF review requires inference tier and visual or usability focus" });
	await assert.rejects(acceptPdfReview(review, hash, 3, { bundle }), { message: "Review tier mismatch" });
	await assert.rejects(acceptPdfReview(review, hash, 3, { checks: "design" }), { message: "Legacy PDF reviews do not declare check domains; omit --checks for a legacy combined report or prepare a new review." });
});

test("acceptance enforces the automated modern-review requirement before bundle reads", async (t) => {
	const { directory, manifest, manifestPath, boundReview } = await retainedBundle();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const { bundleSha256, ...unbound } = boundReview;
	const legacy = { ...unbound, schemaVersion: "pdf-review-3" };
	const options = { bundle: manifestPath, requireBoundReview: manifest.schemaVersion === "pdf-review-bundle-2" };
	await assert.rejects(acceptPdfReview(legacy, hash, 3, options), { message: "Automated PDF review requires pdf-review-4 with exact bundle SHA-256 binding" });
	assert.equal((await acceptPdfReview(boundReview, hash, 3, options)).normalized.evidenceBinding, "bundle");
	await assert.rejects(acceptPdfReview({ ...legacy, documentSha256: "b".repeat(64) }, hash, 3, options), { message: "PDF review version or document SHA-256 does not match this PDF" });
	await writeFile(join(directory, "page-1.png"), "tampered");
	await assert.rejects(acceptPdfReview(legacy, hash, 3, options), { message: "Automated PDF review requires pdf-review-4 with exact bundle SHA-256 binding" });
	await assert.rejects(acceptPdfReview(boundReview, hash, 3, options), { message: "Artifact image hash mismatch" });
});

test("acceptance enforces benchmark model, tier and exact page coverage in order", async (t) => {
	const { directory, manifestPath, boundReview } = await retainedBundle();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const bundle = await validatePdfReviewBundle(manifestPath, hash, 3);
	const options = { bundle, expectedReviewer: { model: "test-model", tier: "inference" as const }, exactPageCoverage: true };
	await assert.rejects(acceptPdfReview(boundReview, hash, 3, options), { message: "Review must cover exactly the bundle selected pages" });
	const fullReview = { ...boundReview, pagesReviewed: [2, 1] };
	const accepted = await acceptPdfReview(fullReview, hash, 3, options);
	assert.deepEqual(accepted.review.pagesReviewed, [2, 1]);
	assert.deepEqual(accepted.normalized.pagesReviewed, [2, 1]);
	assert.equal(accepted.normalized.evidenceBinding, "bundle");
	await assert.rejects(acceptPdfReview({ ...boundReview, reviewer: { model: "wrong-model" }, bundleSha256: "b".repeat(64) }, hash, 3, options), { message: "Review model or tier mismatch" });
	await assert.rejects(acceptPdfReview(review, hash, 3, options), { message: "Review model or tier mismatch" });
	await assert.rejects(acceptPdfReview({ ...boundReview, pagesReviewed: [3] }, hash, 3, options), { message: "Review includes a page outside the bundle selected pages" });
	await assert.rejects(acceptPdfReview(boundReview, hash, 3, { exactPageCoverage: true }), { message: "PDF review v4 requires --review-bundle manifest.json" });
	await assert.rejects(acceptPdfReview(review, hash, 3, { exactPageCoverage: true }), { message: "Review must cover exactly the bundle selected pages" });
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
	const directory = await stat(output);
	assert.ok(directory.isDirectory());
	assert.equal(directory.mode & 0o600, 0o600);
	// Windows stat exposes DOS attributes, not owner-only ACL permissions or
	// Unix directory traversal bits. Path isolation and cleanup are checked below.
	if (process.platform === "win32") assert.equal(directory.mode & 0o111, 0);
	else assert.equal(directory.mode & 0o777, 0o700);
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
	assert.match(result.stdout, /Model review \(visual/);
	assert.match(result.stdout, /0 concerns on page 1 of 2\. The model did not review the other pages/);
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

test("PDF review preparation rejects incomplete extraction with the existing diagnostic and cleans its snapshot", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-review-incomplete-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "broken.pdf"), output = join(dir, "bundle");
	const bytes = "%PDF-1.7\nmalformed";
	await writeFile(path, bytes);
	await assert.rejects(preparePdfReview(path, { tier: "inference", checks: "design", output }), {
		message: "PDF facts could not be extracted; run check for diagnostics",
	});
	await assert.rejects(stat(output), { code: "ENOENT" });
	assert.equal(await readFile(path, "utf8"), bytes);
});


test("bound PDF imports retain normalized findings, partial coverage and overwrite protection", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-bound-review-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "test.pdf"), manifestPath = join(dir, "bundle", "manifest.json");
	await writeFile(path, pdf());
	const prepared = await preparePdfReview(path, { tier: "inference", checks: "design", output: join(dir, "bundle") });
	assertStructuredSchema(JSON.parse(await readFile(join(prepared.directory, "review.schema.json"), "utf8")));
	const boundReview = { schemaVersion: "pdf-review-4", documentSha256: prepared.manifest.documentSha256, bundleSha256: prepared.bundleSha256, tier: "inference", focus: "visual", checks: ["design"], pagesReviewed: [1], reviewer: { model: "synthetic-test" }, findings: [] };
	const bundle = await validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2);
	const finding = (await acceptPdfReview({ ...boundReview, findings: [{ ...review.findings[0], category: "observed-defect", check: "design" }] }, prepared.manifest.documentSha256, 2, { bundle })).normalized.findings[0]!;
	assert.equal(finding.rule, "pdf.visual.inference");
	assert.equal(finding.provenance.check, "design");
	assert.equal(finding.provenance.focus, "visual");
	await assert.rejects(validatePdfReviewBundle(manifestPath, "b".repeat(64), 2), /PDF hash/);
	await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 3), /page count/);
	const reviewPath = join(dir, "review.json"), output = join(dir, "report.json");
	await writeFile(reviewPath, JSON.stringify(boundReview));
	const run = (...extra: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "check", path, "--checks", "design", "--tier", "inference", "--review", reviewPath, ...extra], { encoding: "utf8" });
	assert.match(run().stderr, /requires --review-bundle/);
	const result = run("--review-bundle", manifestPath, "--json", output);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.equal(report.feedback.coverage.find((item: { method: string }) => item.method === "inference").status, "partial");
	assert.equal(report.inferenceReviews[0].evidenceBinding, "bundle");
	assert.match(result.stdout, /does not prove/);
	for (const file of [manifestPath, join(dir, "bundle", "page-1.json")]) {
		const bytes = await readFile(file);
		assert.match(run("--review-bundle", manifestPath, "--json", file).stderr, /must not overwrite review bundle evidence/);
		assert.deepEqual(await readFile(file), bytes);
	}
	const sample = { ...prepared.manifest, selectedPages: [2], coverage: "sample", artifacts: prepared.manifest.artifacts.filter(artifact => artifact.page === 2) };
	await writeFile(manifestPath, JSON.stringify(sample));
	await writeFile(manifestPath, JSON.stringify({ ...sample, schemaVersion: ["pdf-review-bundle-1"] }));
	await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2), /Bundle version/);
	await writeFile(manifestPath, JSON.stringify({ ...sample, artifacts: [] }));
	await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2), /Missing selected-page/);
	await writeFile(manifestPath, JSON.stringify({ ...sample, artifacts: [sample.artifacts[0], sample.artifacts[0]] }));
	await assert.rejects(validatePdfReviewBundle(manifestPath, prepared.manifest.documentSha256, 2), /artifact page coverage/);
});
