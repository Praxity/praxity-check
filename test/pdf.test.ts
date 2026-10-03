import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkPdf, pdfHumanSummary } from "../src/pdf.ts";

// Synthetic objects with a real xref, one unembedded font and a 1-pixel raster at 72 points.
function fixture() {
	const stream = "BT /F1 12 Tf 20 100 Td (Synthetic PDF) Tj ET q 72 0 0 72 20 20 cm /Im1 Do Q";
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [10 10 602 782] /Rotate 90 /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream"];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return pdf;
}

test("real PDF facts, policy review, revision identity and safe CLI output", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "synthetic.pdf");
	await writeFile(path, fixture());
	const report = await checkPdf(path, { minImagePpi: 150, paperSize: "Letter", pdfua: "off" });
	assert.equal(report.machineStatus, "complete");
	assert.equal(report.feedback.schemaVersion, "feedback-1");
	assert.deepEqual(report.feedback.findings[0]?.domains, ["accessibility", "design"]);
	assert.equal(report.facts.pages[0]?.rotation, 90);
	assert.deepEqual(report.facts.pages[0]?.boxes.CropBox, [10, 10, 602, 782]);
	assert.equal(report.findings[0]?.rule, "font.embedding");
	assert.equal(report.needsReview.find((i) => i.rule === "image.resolution")?.location.page, 1);
	assert.ok(report.facts.words.some((word) => word.text === "Synthetic"));
	assert.equal(report.evaluations.find((e) => e.rule === "pdfua.conformance")?.outcome, "untested");
	const noPolicy = await checkPdf(path);
	assert.ok(!noPolicy.needsReview.some((i) => i.rule === "image.resolution"));
	await writeFile(path, fixture().replace("Synthetic PDF", "Different PDF"));
	const changed = await checkPdf(path);
	assert.notEqual(changed.document.sha256, report.document.sha256);
	assert.notEqual(changed.findings[0]?.id, report.findings[0]?.id);
	const original = await readFile(path);
	for (const alias of [path, join(dir, "hardlink.json"), join(dir, "symlink.json")]) {
		if (alias.includes("hardlink")) await link(path, alias);
		if (alias.includes("symlink")) await symlink(path, alias);
		const result = spawnSync(process.execPath, [resolve("src/cli.ts"), "check", path, "--json", alias], { encoding: "utf8" });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /must not overwrite/);
		assert.deepEqual(await readFile(path), original);
	}
	await writeFile(path, "%PDF-1.7\nmalformed");
	const malformed = await checkPdf(path);
	assert.equal(malformed.machineStatus, "incomplete");
	assert.equal(malformed.evaluations.find((e) => e.rule === "pdf.open")?.outcome, "untested");
});


test("human feedback groups repeated problems without losing machine evidence or uncertainty", () => {
	const issue = { id: "first", rule: "font.embedding", severity: "serious" as const, confidence: "high" as const, location: { documentSha256: "hash", page: 2 }, message: "A font is not embedded.", remedy: "Embed the font when exporting.", evidence: { font: "Example" } };
	const report = { document: { path: "example.pdf", sha256: "hash", bytes: 123, kind: "pdf" as const }, machineStatus: "incomplete" as const,
		findings: [issue, { ...issue, id: "second", location: { documentSha256: "hash", page: 4 } }],
		needsReview: [{ ...issue, id: "review", rule: "image.resolution", location: { documentSha256: "hash" }, message: "An image may print poorly.", remedy: "Inspect a print at its intended size." }],
		evaluations: [{ rule: "pdfua.machine", outcome: "untested" as const, reason: "The validator could not run." }] };
	const before = structuredClone(report);
	const summary = pdfHumanSummary(report, "report.json");
	assert.match(summary, /Some automated checks could not finish/);
	assert.match(summary, /2 issues found\. 1 possible issue to review\./);
	assert.equal(summary.split("Fix: A font is not embedded.").length - 1, 1);
	assert.match(summary, /Found 2 times\. First location: page 2/);
	assert.match(summary, /Review: An image may print poorly/);
	assert.match(summary, /Location: whole document/);
	assert.match(summary, /Next step: Embed the font when exporting/);
	assert.match(summary, /Not checked:\n  pdfua.machine: The validator could not run/);
	assert.match(summary, /Details and evidence: report.json/);
	assert.deepEqual(report, before);
	const clean = pdfHumanSummary({ ...report, machineStatus: "complete", findings: [], needsReview: [] });
	assert.match(clean, /Automated checks completed/);
	assert.match(clean, /Not checked:/);
	assert.doesNotMatch(clean, /After changing the source/);
});
