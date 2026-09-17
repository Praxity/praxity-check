import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { measurePdfDesignPage, parsePdfDesignXml, preparePdfDesignEvidence } from "../src/pdf-design.ts";

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
// Decode Poppler RGB PNG scanlines to assert a known source mark lands inside the crop.
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

const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE pdf2xml SYSTEM "pdf2xml.dtd">\n<pdf2xml producer="poppler" version="26"><page number="1" width="200" height="300"><fontspec id="0" size="4" family="Helvetica" color="#000000"/><text left="30" top="50" width="20" height="4" font="0"><b>A &amp; B</b></text></page></pdf2xml>';

test("strict bounded Poppler style parsing rejects malformed or unsupported XML", () => {
	assert.equal(parsePdfDesignXml(xml).spans[0]?.text, "A & B");
	assert.equal(parsePdfDesignXml(xml).spans[0]?.bold, true);
 const data = parsePdfDesignXml(xml), span = data.spans[0]!;
 const measured = measurePdfDesignPage({ ...data, spans: [{ ...span, width: 0, text: "" }, span, { ...span, top: 100 }] }, {});
 assert.deepEqual(measured.textBoxGaps, [{ firstSpan: 1, secondSpan: 2, verticalGapPt: 46 }]);
 assert.equal(measured.requirement, null);
	for (const bad of [xml.replace('size="4"', 'size="NaN"'), xml.replace('width="20"', 'width="-2"'), xml.replace('font="0"', 'font="missing"'), xml.replace("</text>", "</b>"), xml.replace("&amp;", "&external;"), xml.replace('<pdf2xml', '<!ENTITY external SYSTEM "file:///etc/passwd"><pdf2xml'), xml + '<pdf2xml></pdf2xml>', xml.repeat(20_000), xml.replace('left="30"', 'left="30" left="40"')]) assert.throws(() => parsePdfDesignXml(bad));
});

test("bookmark metadata is validated and excluded from page measurements", () => {
	const withOutline = (outline: string) => xml.replace("</pdf2xml>", `${outline}</pdf2xml>`);
	const outline = '<outline><item page="1">Bookmark &amp; parent</item><outline><item page="2">Nested bookmark</item><item>No destination</item></outline></outline>';
	assert.deepEqual(parsePdfDesignXml(withOutline(outline)), parsePdfDesignXml(xml));
	for (const bad of [
		outline.replace("&amp;", "&external;"), outline.replace("Nested bookmark", "x".repeat(200_001)),
		outline.replace('<item page="2">', '<unknown>'), outline.replace('page="2"', 'page="NaN"'),
		outline.replace('page="2"', 'page="1.5"'), outline.replace("</item>", "</outline>"),
		"<outline>unexpected text</outline>", "<item>outside outline</item>",
		"<outline>".repeat(8) + "</outline>".repeat(8),
	]) assert.throws(() => parsePdfDesignXml(withOutline(bad)));
});

test("real PDF design evidence preserves intentional whitespace and unsupported mapping, hashes rendered crops", async (t) => {
	for (const tool of ["pdftohtml", "pdftoppm"]) try { execFileSync(tool, ["-v"], { stdio: "ignore" }); } catch { t.skip(`${tool} unavailable`); return; }
	const dir = await mkdtemp(join(tmpdir(), "pdf-design-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const input = join(dir, "input.pdf"); await writeFile(input, pdf());
	const pages = [1, 2, 3, 4, 5].map((page) => ({ page, width: page === 2 ? 300 : 200, height: page === 2 ? 200 : 300, rotation: page === 3 ? 90 : 0, boxes: { MediaBox: page === 2 ? [0, 0, 300, 200] : [0, 0, 200, 300], CropBox: page === 4 ? [10, 10, 190, 290] : page === 2 ? [0, 0, 300, 200] : [0, 0, 200, 300] } }));
	// Poppler otherwise writes internal-link chatter into its XML stdout, outside any text span.
 const noisyXml = execFileSync("pdftohtml", ["-xml", "-i", "-stdout", "-zoom", "1", "-noroundcoord", "-f", "1", "-l", "1", input], { encoding: "utf8" });
 assert.match(noisyXml, /link to page 2/);
 assert.throws(() => parsePdfDesignXml(noisyXml), /Unexpected XML text/);
 const result = await preparePdfDesignEvidence(input, dir, pages, { minTextSizePt: 10 });
 const designXml = await readFile(join(dir, "page-1-design.xml"), "utf8");
 assert.match(designXml, /<outline>\s*<item page="1">Bookmark &amp; parent<\/item>\s*<outline>\s*<item page="2">Nested bookmark<\/item>/);
 assert.equal(result.pages[0]?.spans.length, 2);
 assert.ok(result.pages[0]?.spans.some((span) => span.text.includes("Normal")));
	assert.equal(result.pages[0]?.fonts.find((f) => f.sizePt === 4)?.family, "Helvetica");
	assert.deepEqual(result.pages[0]?.measurements.requirement?.belowMinimumSpanIndexes, [1]);
	assert.ok(result.pages[0]!.measurements.textBoxGaps[0]!.verticalGapPt > 20);
	assert.ok(result.pages[0]!.crops.length > 0);
	assert.equal(result.pages[1]?.mappingSupported, true);
	for (const page of result.pages.slice(2, 4)) { assert.equal(page.mappingSupported, false); assert.equal(page.crops.length, 0); assert.match(page.mappingLimitation!, /unsupported/); }
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

test("fractional PDF page dimensions retain exact crop coordinates despite truncated XML dimensions", async (t) => {
	for (const tool of ["pdftohtml", "pdftoppm"]) try { execFileSync(tool, ["-v"], { stdio: "ignore" }); } catch { t.skip(`${tool} unavailable`); return; }
	const dir = await mkdtemp(join(tmpdir(), "pdf-design-fractional-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const input = join(dir, "input.pdf"), width = 200.75, height = 300.875;
	await writeFile(input, pdf(width, height));
	const geometry = { page: 1, width, height, rotation: 0, boxes: { MediaBox: [0, 0, width, height], CropBox: [0, 0, width, height] } };
	const result = await preparePdfDesignEvidence(input, dir, [geometry]);
	const page = result.pages[0]!, crop = page.crops[0]!;
	assert.equal(page.mappingSupported, true);
	assert.equal(page.width, 200); assert.equal(page.height, 300);
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
