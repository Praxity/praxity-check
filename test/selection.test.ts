import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseChecks, parseTier, selectChecks, validateHtmlSelection } from "../src/selection.ts";
import { checkPdf } from "../src/pdf.ts";
import { normalizePdfReview, preparePdfReview, validatePdfReview, validateReviewSelection } from "../src/pdf-review.ts";
import { comparePdfReports, validateComparisonReport } from "../src/pdf-compare.ts";

const cli = resolve("src/cli.ts");
const fixture = resolve("test/fixtures/pdf-first.zip");

test("shared axes validate selection and reject unsupported HTML paths before launching browsers", () => {
	assert.deepEqual(selectChecks({}), { checks: ["accessibility"], tier: "deterministic" });
	assert.deepEqual(parseChecks("design,accessibility"), ["accessibility", "design"]);
	for (const checks of ["", "design,design", "accessibility,", "visual"]) assert.throws(() => parseChecks(checks));
	assert.throws(() => parseTier("visual"));
	assert.deepEqual(validateHtmlSelection("prepare-review", {}), { checks: ["accessibility"], tier: "inference" });
	for (const target of [".", fixture]) {
		for (const args of [["--checks", "design"], ["--checks", "accessibility,design"], ["--tier", "inference"]]) {
			const result = spawnSync(process.execPath, [cli, "check", target, ...args], { encoding: "utf8" });
			assert.equal(result.status, 2);
			assert.match(result.stderr, /not supported|inference requires --review/);
		}
	}
});

const hash = "a".repeat(64);
const modern = { schemaVersion: "pdf-review-3", documentSha256: hash, tier: "inference", focus: "visual", checks: ["design"], pagesReviewed: [1], reviewer: { model: "synthetic-test" }, findings: [{ page: 1, check: "design", category: "observed-defect", confidence: "high", message: "Visible instruction is clipped.", action: "Increase the source box height.", consequence: "The reader misses a required step.", origin: "Model inference from the page image.", verification: "Inspect the regenerated page.", evidence: { observation: "The last instruction line crosses the bottom boundary." } }] };

test("v3 domain coverage is enforced while legacy review schemas remain compatible", () => {
	const review = validatePdfReview(modern, hash, 1);
	validateReviewSelection(review, "design");
	assert.throws(() => validateReviewSelection(review, "accessibility"), /unselected/);
	assert.throws(() => validatePdfReview({ ...modern, findings: [{ ...modern.findings[0], check: "accessibility" }] }, hash, 1), /outside selected/);
	assert.throws(() => validatePdfReview({ ...modern, checks: [] }, hash, 1));
	for (const checks of [["accessibility,design"], ["design,accessibility"], ["design", "design"], [""], []]) {
		for (const findings of [[], [{ ...modern.findings[0], check: checks[0] }]]) {
			assert.throws(() => validatePdfReview({ ...modern, checks, findings }, hash, 1));
			const normalized = normalizePdfReview(validatePdfReview(modern, hash, 1));
			const malformedReview = { ...normalized, checks, findings: findings.length ? normalized.findings.map((finding) => ({ ...finding, check: checks[0] })) : [] };
			assert.throws(() => validateComparisonReport({ schemaVersion: "pdf-1", document: { sha256: hash }, machineStatus: "complete", policy: {}, facts: { pages: [{ page: 1 }] }, evaluations: [], evidence: [], findings: [], needsReview: [], inferenceReviews: [malformedReview] }));
		}
	}
	const { focus, checks, ...legacy } = modern;
	const old = validatePdfReview({ ...legacy, schemaVersion: "pdf-review-2", tier: "visual", findings: modern.findings.map(({ check, ...finding }) => finding) }, hash, 1);
	validateReviewSelection(old);
	assert.throws(() => validateReviewSelection(old, "design"), /Legacy PDF reviews/);
	const normalized = normalizePdfReview(review);
	assert.equal(normalized.findings[0]?.provenance.tier, "inference");
	assert.equal(normalized.findings[0]?.rule, "pdf.visual.inference");
	assert.equal(normalized.findings[0]?.check, "design");
});

// A blank page is enough to expose accidental font/print validation or a veraPDF launch.
function pdf(withText = false) {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>"];
	if (withText) {
		objects[2] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
		const content = "BT /F1 8 Tf 20 100 Td (Synthetic small text) Tj ET";
		objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	}
	let result = "%PDF-1.4\n";
	const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(result); result += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
	const xref = Buffer.byteLength(result);
	return result + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("PDF domain and tier selection changes executed checks and keeps inference outside machine findings", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "check-selection-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "synthetic.pdf");
	await writeFile(path, pdf());
	const design = await checkPdf(path, { checks: "design", tier: "deterministic", veraPdfPath: join(dir, "missing-validator"), paperSize: "A4" });
	assert.equal(design.machineStatus, "complete");
	assert.ok(design.findings.some((finding) => finding.rule === "page.geometry"));
	assert.ok(!design.evidence.some((evidence) => evidence.tool.includes("validator")));
	assert.ok(!design.evaluations.some((evaluation) => evaluation.rule.startsWith("pdfua")));
	const accessibility = await checkPdf(path, { checks: "accessibility", tier: "deterministic", pdfua: "off", paperSize: "A4" });
	assert.equal(accessibility.findings.length, 0);
	assert.ok(accessibility.evaluations.some((evaluation) => evaluation.rule === "font.embedding"));
	assert.ok(accessibility.needsReview.some((finding) => finding.rule === "text.extractable"));
	assert.ok(!accessibility.evaluations.some((evaluation) => evaluation.rule === "page.geometry" || evaluation.rule === "image.resolution" || evaluation.rule === "page.sparse-content"));
	const canonicalDefault = await checkPdf(path, { tier: "deterministic", pdfua: "off" });
	assert.deepEqual(canonicalDefault.selection.checks, ["accessibility"]);
	assert.deepEqual(canonicalDefault.policy, { checks: "accessibility", tier: "deterministic", pdfua: "off" });
	const legacy = await checkPdf(path, { pdfua: "off" });
	assert.deepEqual(legacy.selection, { checks: ["accessibility", "design"], tier: "deterministic" });
	const explicit = await checkPdf(path, { checks: "design,accessibility", tier: "deterministic", pdfua: "off" });
	assert.deepEqual(legacy.policy, explicit.policy);
	const undefinedOptions = await checkPdf(path, { checks: undefined, tier: undefined, minImagePpi: undefined, pdfua: "off" });
	assert.equal(comparePdfReports(undefinedOptions, legacy).comparison.policySame, true);
	assert.deepEqual(legacy.evaluations, explicit.evaluations);
	const cliOutput = join(dir, "effective-policy.json");
	const checked = spawnSync(process.execPath, [cli, "check", path, "--pdfua", "off", "--json", cliOutput], { encoding: "utf8" });
	assert.equal(checked.status, 0, checked.stderr);
	assert.deepEqual(JSON.parse(await readFile(cliOutput, "utf8")).policy, legacy.policy);
	const imported = join(dir, "review.json"), output = join(dir, "report.json");
	await writeFile(imported, JSON.stringify({ ...modern, documentSha256: design.document.sha256 }));
	const result = spawnSync(process.execPath, [cli, "check", path, "--checks", "design", "--tier", "inference", "--review", imported, "--json", output, "--verapdf", join(dir, "missing-validator")], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Supporting evidence extracted; deterministic checks were not selected/);
	const wrongDefault = spawnSync(process.execPath, [cli, "check", path, "--tier", "inference", "--review", imported], { encoding: "utf8" });
	assert.equal(wrongDefault.status, 2);
	assert.match(wrongDefault.stderr, /unselected check domain/);
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.equal(report.findings.length, 0);
	assert.equal(report.inferenceReviews[0].findings.length, 1);
	assert.ok(!report.evaluations.some((e: { rule: string }) => e.rule === "font.embedding" || e.rule === "pdfua.machine"));
	const comparison = comparePdfReports(report, report);
	assert.equal(comparison.groups[0]?.status, "reported-again");
	assert.equal(spawnSync(process.execPath, [cli, "check", path, "--tier", "deterministic", "--review", imported]).status, 2);
	await assert.rejects(preparePdfReview(path, { tier: "inference", designEvidence: true }), /requires --checks design/);
	const bundle = await preparePdfReview(path, { tier: "inference", checks: "design", pages: [1], output: join(dir, "bundle") });
	assert.equal(bundle.manifest.tier, "inference");
	assert.deepEqual(bundle.manifest.checks, ["design"]);
	assert.equal(JSON.parse(await readFile(join(bundle.directory, "review.schema.json"), "utf8")).properties.schemaVersion.const, "pdf-review-4");
	await writeFile(path, pdf(true));
	const fonts = await checkPdf(path, { checks: "accessibility", tier: "deterministic", pdfua: "off" });
	assert.ok(fonts.findings.some((finding) => finding.rule === "font.embedding"));
	const enriched = await preparePdfReview(path, { tier: "inference", checks: "design", designEvidence: true, minTextSizePt: 10, output: join(dir, "enriched") });
	assert.ok(enriched.manifest.designEvidence);
	assert.equal(enriched.manifest.designEvidence.requirements.minTextSizePt, 10);
});
