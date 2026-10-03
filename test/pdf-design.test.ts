import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { measurePdfDesignPage, preparePdfDesignEvidence } from "../src/pdf-design.ts";

function pdf(width = 200, height = 300) {
	const streams = ["BT /F1 12 Tf 30 170 Td (Normal) Tj ET BT /F1 4 Tf 30 130 Td (Tiny instruction) Tj ET q 1 0 0 rg 32 120 6 6 re f Q", "BT /F1 12 Tf 30 270 Td (Landscape) Tj ET", "BT /F1 12 Tf 30 170 Td (Rotated) Tj ET", "BT /F1 12 Tf 30 170 Td (Offset) Tj ET", ""];
	const boxes = [`/MediaBox [0 0 ${width} ${height}]`, "/MediaBox [0 0 300 200]", "/MediaBox [0 0 200 300] /Rotate 90", "/MediaBox [0 0 200 300] /CropBox [10 10 190 290]", "/MediaBox [0 0 200 300]"];
	const objects = ["<< /Type /Catalog /Pages 2 0 R /Outlines 15 0 R >>", "<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R 10 0 R 12 0 R] /Count 5 >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	streams.forEach((stream, i) => objects.push(`<< /Type /Page /Parent 2 0 R ${boxes[i]} ${i === 0 ? "/Annots [14 0 R]" : ""} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
	objects.push("<< /Type /Annot /Subtype /Link /Rect [30 165 80 185] /Border [0 0 0] /Dest [6 0 R /Fit] >>");
	objects.push("<< /Type /Outlines /First 16 0 R /Last 16 0 R /Count 2 >>",
		"<< /Title (Bookmark & parent) /Parent 15 0 R /Dest [4 0 R /Fit] /First 17 0 R /Last 17 0 R /Count 1 >>",
		"<< /Title (Nested bookmark) /Parent 16 0 R /Dest [6 0 R /Fit] >>");
	let result = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
	const xref = Buffer.byteLength(result);
	return result + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
// Decode RGB PNG scanlines to assert a known source mark lands inside the crop.
function rgb(png: Buffer) {
 const width = png.readUInt32BE(16), height = png.readUInt32BE(20), chunks: Buffer[] = [];
 assert.equal(png[24], 8); assert.equal(png[25], 2);
 for (let at = 8; at < png.length;) {
  const size = png.readUInt32BE(at);
  if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + size));
  at += size + 12;
 }
 const raw = inflateSync(Buffer.concat(chunks)), stride = width * 3, pixels = Buffer.alloc(width * height * 3);
 const paeth = (a: number, b: number, c: number) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
 for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)]!; assert.ok(filter <= 4);
  for (let x = 0; x < stride; x++) {
   const i = y * stride + x, left = x >= 3 ? pixels[i - 3]! : 0, up = y ? pixels[i - stride]! : 0, diagonal = y && x >= 3 ? pixels[i - stride - 3]! : 0;
   const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, diagonal)][filter]!;
   pixels[i] = (raw[y * (stride + 1) + x + 1]! + predictor) & 255;
  }
 }
 return (x: number, y: number) => [...pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
}

test("real PDF design evidence preserves intentional whitespace and unsupported mapping, hashes rendered crops", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-design-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const input = join(dir, "input.pdf"); await writeFile(input, pdf());
	const pages = [1, 2, 3, 4, 5].map((page) => ({ page, width: page === 2 || page === 3 ? 300 : page === 4 ? 180 : 200, height: page === 2 || page === 3 ? 200 : page === 4 ? 280 : 300, rotation: page === 3 ? 90 : 0, boxes: { MediaBox: page === 2 ? [0, 0, 300, 200] : [0, 0, 200, 300], CropBox: page === 4 ? [10, 10, 190, 290] : page === 2 ? [0, 0, 300, 200] : [0, 0, 200, 300] } }));
 const result = await preparePdfDesignEvidence(input, dir, pages, { minTextSizePt: 10 });
 assert.equal(result.pages[0]?.spans.length, 2);
 assert.ok(result.pages[0]?.spans.some((span) => span.text.includes("Normal")));
	assert.equal(result.pages[0]?.fonts.find((f) => f.sizePt === 4)?.family, "Helvetica");
	assert.deepEqual(result.pages[0]?.measurements.requirement?.belowMinimumSpanIndexes, [1]);
	assert.ok(result.pages[0]!.measurements.textBoxGaps[0]!.verticalGapPt > 20);
	assert.ok(result.pages[0]!.crops.length > 0);
	assert.equal(result.pages[1]?.mappingSupported, true);
	for (const page of result.pages.slice(2, 4)) { assert.equal(page.mappingSupported, true); assert.ok(page.crops.length > 0); }
	assert.equal(result.pages[4]?.measurements.extractedTextEnvelope, null);
	assert.equal(result.pages[4]?.crops.length, 0);
	assert.match(result.uncertainty, /Intentional whitespace/);
	for (const artifact of result.artifacts) assert.equal(createHash("sha256").update(await readFile(join(dir, artifact.path))).digest("hex"), artifact.sha256);
	const crop = result.pages[0]!.crops[0]!;
	assert.equal(crop.selectedSpan, 1);
	const png = await readFile(join(dir, crop.image));
 assert.equal(png.readUInt32BE(16), crop.pixels.width);
 // Source marker centre is (35,123) in bottom-left PDF points, (70,354) in top-left 144-DPI pixels.
 assert.deepEqual(rgb(png)(70 - crop.pixels.x, 354 - crop.pixels.y), [255, 0, 0]);
	await assert.rejects(preparePdfDesignEvidence(input, dir, pages, { minTextSizePt: -1 }));
	await assert.rejects(preparePdfDesignEvidence(input, dir, []));
});

test("fractional PDF page dimensions retain exact crop coordinates", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-design-fractional-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const input = join(dir, "input.pdf"), width = 200.75, height = 300.875;
	await writeFile(input, pdf(width, height));
	const geometry = { page: 1, width, height, rotation: 0, boxes: { MediaBox: [0, 0, width, height], CropBox: [0, 0, width, height] } };
	const result = await preparePdfDesignEvidence(input, dir, [geometry]);
	const page = result.pages[0]!, crop = page.crops[0]!;
	assert.equal(page.mappingSupported, true);
	assert.equal(page.width, width); assert.equal(page.height, height);
	assert.equal(crop.selectedSpan, 1);
	assert.equal(crop.rect.left + crop.rect.width, width);
	assert.equal(crop.pixels.x + crop.pixels.width, Math.ceil(width * 2));
	const pixels = rgb(await readFile(join(dir, crop.image)));
	// The red mark covers y=120..126 in PDF points. The fractional page height puts
	// pixel row 349 above it and row 351 inside it; using the truncated height shifts both.
	assert.deepEqual(pixels(70 - crop.pixels.x, 349 - crop.pixels.y), [255, 255, 255]);
	assert.deepEqual(pixels(70 - crop.pixels.x, 351 - crop.pixels.y), [255, 0, 0]);
	for (const boxes of [
		{ MediaBox: [0, 0, width + 1, height], CropBox: [0, 0, width + 1, height] },
		{ MediaBox: [1, 0, width + 1, height], CropBox: [1, 0, width + 1, height] },
	]) {
		const output = await mkdtemp(join(dir, "unsupported-"));
		const unsupported = await preparePdfDesignEvidence(input, output, [{ ...geometry, boxes }]);
		assert.equal(unsupported.pages[0]?.mappingSupported, false);
		assert.deepEqual(unsupported.pages[0]?.crops, []);
	}
});
