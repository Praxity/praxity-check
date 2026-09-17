import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseImages, parsePages, parseText } from "../src/pdf.ts";
import { evaluatePdfPrint } from "../src/pdf-print.ts";

function pdf(streams: string[]) {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${streams.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	streams.forEach((stream, i) => objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${i % 2 ? "/Rotate 90 /CropBox [10 20 602 772]" : ""} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
	let output = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
	const xref = Buffer.byteLength(output);
	return output + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("real PDF sparse and empty candidates retain intentional artwork and cover uncertainty", async (t) => {
	try { execFileSync("pdfinfo", ["-v"], { stdio: "ignore" }); } catch { t.skip("Poppler unavailable"); return; }
	const dir = await mkdtemp(join(tmpdir(), "pdf-print-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "controls.pdf");
	await writeFile(path, pdf([
		"BT /F1 12 Tf 50 600 Td (Normal body contains enough words to exceed requested sparse threshold) Tj ET",
		"BT /F1 12 Tf 50 600 Td (https://example.invalid) Tj ET",
		"",
		"0 0 0 RG 50 50 450 600 re S",
		"BT /F1 24 Tf 50 600 Td (Intentional cover) Tj ET",
	]));
	const extract = (tool: string, args: string[]) => execFileSync(tool, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
	const facts = {
		pages: parsePages(extract("pdfinfo", ["-box", "-f", "1", "-l", "5", path]), 5),
		words: parseText(extract("pdftotext", ["-tsv", path, "-"])),
		images: parseImages(extract("pdfimages", ["-list", path])),
	};
	const result = evaluatePdfPrint(facts, { maxSparseWords: 3 });
	assert.deepEqual(result.findings, []);
	assert.deepEqual(result.needsReview.filter((i) => i.rule === "page.sparse-content").map((i) => i.location.page), [2, 5]);
	assert.deepEqual(result.needsReview.filter((i) => i.rule === "text.extractable").map((i) => i.location.page), [3, 4]);
	assert.ok(result.evaluations.every((e) => e.outcome === "cantTell"));
	assert.match(result.needsReview.find((i) => i.location.page === 4)!.message, /vector artwork/);
	assert.equal(evaluatePdfPrint(facts).evaluations.find((e) => e.rule === "page.sparse-content")?.outcome, "untested");
});

test("unavailable facts cannot masquerade as blank pages; raster pages and policy boundaries", () => {
	assert.ok(evaluatePdfPrint({ pages: [{ page: 1 }] }, { maxSparseWords: 3 }).evaluations.every((e) => e.outcome === "untested"));
	const raster = evaluatePdfPrint({ pages: [{ page: 1 }], words: [], images: [{ page: 1, type: "image" }] }, { maxSparseWords: 3 });
	assert.match(raster.needsReview[0]!.message, /raster images/);
	assert.equal(raster.needsReview.length, 1);
	const labelledImage = evaluatePdfPrint({ pages: [{ page: 1 }], words: [{ page: 1, text: "Diagram" }], images: [{ page: 1, type: "image" }] }, { maxSparseWords: 3 });
	assert.deepEqual(labelledImage.needsReview, []);
	for (const maxSparseWords of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => evaluatePdfPrint({}, { maxSparseWords }), /positive safe integer/);
});
