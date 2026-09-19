import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkPdf, pdfHumanSummary, parseFonts, parseImages, parsePages, parseText } from "../src/pdf.ts";

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
	try { execFileSync("pdfinfo", ["-v"], { stdio: "ignore" }); } catch { t.skip("Poppler pdfinfo unavailable; install poppler to run integration coverage"); return; }
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

test("missing tools remain untested, with JSON and exit 2 and no browser import", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-missing-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "extensionless"), output = join(dir, "report.json");
	await writeFile(path, fixture());
	await copyFile(resolve("src/cli.ts"), join(dir, "cli.ts"));
	await copyFile(resolve("src/pdf.ts"), join(dir, "pdf.ts"));
	await copyFile(resolve("src/feedback.ts"), join(dir, "feedback.ts"));
	await copyFile(resolve("src/pdf-accessibility.ts"), join(dir, "pdf-accessibility.ts"));
	await copyFile(resolve("src/pdf-print.ts"), join(dir, "pdf-print.ts"));
	await copyFile(resolve("src/pdf-review.ts"), join(dir, "pdf-review.ts"));
	await copyFile(resolve("src/review-runner.ts"), join(dir, "review-runner.ts"));
	await copyFile(resolve("src/selection.ts"), join(dir, "selection.ts"));
	await copyFile(resolve("src/pdf-design.ts"), join(dir, "pdf-design.ts"));
	const result = spawnSync(process.execPath, [join(dir, "cli.ts"), "check", path, "--json", output], { encoding: "utf8", env: { ...process.env, PATH: dir } });
	assert.equal(result.status, 2);
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.equal(report.machineStatus, "incomplete");
	assert.equal(report.feedback.schemaVersion, "feedback-1");
	assert.equal(report.feedback.coverage.find((entry: { rule: string }) => entry.rule === "font.embedding").outcome, "untested");
	assert.equal(report.evaluations.find((e: { rule: string }) => e.rule === "font.embedding").outcome, "untested");
	assert.ok(report.evidence.some((e: { error?: string }) => e.error?.includes("ENOENT")));
});

test("Poppler parser variants reject unknown output rather than report empty inventories", () => {
	assert.equal(parseFonts("name type encoding emb sub uni object ID\r\n---- ---- ---- --- --- --- ----\r\nArial Bold Type 1 WinAnsi no yes no 3 0\r\n")[0]?.type, "Bold Type 1");
	const header = "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------------------\n";
	assert.equal(parseImages(header + "1 0 image 10 10 gray 1 8 image no [inline] 25 25 100B 1%\n")[0]?.xPpi, 25);
	assert.throws(() => parseImages(header + "unrecognized row"));
	assert.throws(() => parseFonts("new output format"));
	assert.throws(() => parsePages("Pages: 2", 2));
	assert.throws(() => parseText("new TSV format"));
});


test("human feedback groups repeated problems without losing machine evidence or uncertainty", () => {
	const issue = { id: "first", rule: "font.embedding", severity: "serious" as const, confidence: "high" as const, location: { documentSha256: "hash", page: 2 }, message: "A font is not embedded.", remedy: "Embed the font when exporting.", evidence: { font: "Example" } };
	const report = { document: { path: "example.pdf", sha256: "hash", bytes: 123, kind: "pdf" as const }, machineStatus: "incomplete" as const,
		findings: [issue, { ...issue, id: "second", location: { documentSha256: "hash", page: 4 } }],
		needsReview: [{ ...issue, id: "review", rule: "image.resolution", location: { documentSha256: "hash" }, message: "An image may print poorly.", remedy: "Inspect a print at its intended size." }],
		evaluations: [{ rule: "pdfua.machine", outcome: "untested" as const, reason: "The validator could not run." }] };
	const before = structuredClone(report);
	const summary = pdfHumanSummary(report, "report.json");
	assert.match(summary, /Some automated checks could not complete/);
	assert.match(summary, /2 findings to fix; 1 item to review/);
	assert.equal(summary.split("Fix: A font is not embedded.").length - 1, 1);
	assert.match(summary, /First location: page 2. 2 occurrences/);
	assert.match(summary, /Review: An image may print poorly/);
	assert.match(summary, /Location: document level/);
	assert.match(summary, /Next step: Embed the font when exporting/);
	assert.match(summary, /Not checked:\n  pdfua.machine: The validator could not run/);
	assert.match(summary, /Full findings, locations and evidence: report.json/);
	assert.deepEqual(report, before);
	const clean = pdfHumanSummary({ ...report, machineStatus: "complete", findings: [], needsReview: [] });
	assert.match(clean, /Automated checks completed/);
	assert.match(clean, /Not checked:/);
	assert.doesNotMatch(clean, /After changing the source/);
});


test("Poppler TSV blank records preserve words and still reject malformed nonempty rows", () => {
	const header = "level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
	const first = "5\t1\t0\t0\t0\t0\t10\t20\t30\t12\t100\tSynthetic";
	const next = "5\t2\t0\t0\t0\t0\t11\t21\t31\t13\t100\tExample";
	for (const newline of ["\n", "\r\n"]) {
		assert.deepEqual(parseText([header, first, "", next, ""].join(newline)), [
			{ page: 1, rect: [10, 20, 30, 12], text: "Synthetic" },
			{ page: 2, rect: [11, 21, 31, 13], text: "Example" },
		]);
		for (const malformed of [" ", "\t", "5\t1", first.replace("\t10\t", "\tinvalid\t"), first.replace("5\t", "2\t")]) {
			assert.throws(() => parseText([header, first, "", malformed, next].join(newline)), /Invalid Poppler TSV row/);
		}
	}
});
