import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { init } from "@embedpdf/pdfium";
import type { PdfFont, PdfImage, PdfPage, PdfPageSpans, PdfRender, PdfWord } from "./pdf-engine.ts";

const { bytes, maxWasmBytes, wasmPath } = workerData as { bytes: Uint8Array; maxWasmBytes: number; wasmPath: string };
let fatal = false;
const diagnostics: string[] = [];
const native = await init({ wasmBinary: await readFile(wasmPath), printErr: (message: string) => diagnostics.push(message) });
// Emscripten exports HEAPU8 at runtime; the package omits it from its declarations.
const memory = native.pdfium as typeof native.pdfium & { HEAPU8: Uint8Array };
function ceiling() {
	if (memory.HEAPU8.buffer.byteLength > maxWasmBytes) {
		fatal = true;
		throw new Error(`PDFium wasm memory ceiling exceeded (${memory.HEAPU8.buffer.byteLength} > ${maxWasmBytes} bytes)`);
	}
}
// Check after each PDFium call, including calls made inside page and object loops.
const p = new Proxy(native, { get(target, key, receiver) {
	const value: unknown = Reflect.get(target, key, receiver);
	return typeof value === "function" ? (...args: unknown[]) => { const result: unknown = value.apply(target, args); ceiling(); return result; } : value;
} });
function alloc(length: number) {
	if (!Number.isSafeInteger(length) || length < 1 || length > maxWasmBytes) throw new Error("PDFium allocation exceeds memory ceiling");
	const ptr = memory.wasmExports.malloc(length); ceiling();
	if (!ptr) throw new Error("PDFium allocation failed");
	return ptr;
}
const free = (ptr: number) => memory.wasmExports.free(ptr);
function utf8(get: (buffer: number, size: number) => number) {
	const size = get(0, 0); if (!size) return "";
	const ptr = alloc(size);
	try { get(ptr, size); return memory.UTF8ToString(ptr); } finally { free(ptr); }
}
function utf16(get: (buffer: number, size: number) => number) {
	const size = get(0, 0); if (!size) return "";
	const ptr = alloc(size);
	try { get(ptr, size); return Buffer.from(memory.HEAPU8.subarray(ptr, ptr + size)).toString("utf16le").replace(/\0+$/, ""); } finally { free(ptr); }
}
function checked(ok: boolean | number, what: string) { if (!ok) throw new Error(`PDFium could not read ${what}`); }
let document = 0, analysisDocument = 0, sourceBuffer = 0;
const formEnvironments = new Map<number, number>();
function formEnvironment(doc: number) {
	if (p.FPDF_GetFormType(doc) !== 1) return 0;
	let environment = formEnvironments.get(doc);
	if (!environment) {
		const info = p.PDFiumExt_OpenFormFillInfo(); checked(info, "form appearance information");
		environment = p.PDFiumExt_InitFormFillEnvironment(doc, info); checked(environment, "form appearance environment");
		formEnvironments.set(doc, environment);
	}
	return environment;
}
function extractionDocument() {
	if (analysisDocument) return analysisDocument;
	analysisDocument = p.FPDF_LoadMemDocument(sourceBuffer, bytes.length, ""); checked(analysisDocument, "extraction copy");
	// Flatten only the extraction copy: appearance streams become ordinary form objects.
	// Reopening each page reparses the generated content; the original retains annotations for rendering.
	for (let i = 0; i < p.FPDF_GetPageCount(analysisDocument); i++) {
		const page = p.FPDF_LoadPage(analysisDocument, i); checked(page, "extraction page");
		try {
			const environment = formEnvironment(analysisDocument);
			// Loading the form view creates missing normal appearances, including button captions.
			// No document, page or JavaScript action is invoked.
			if (environment) { p.FORM_OnAfterLoadPage(page, environment); p.FORM_OnBeforeClosePage(page, environment); }
			if (p.FPDFPage_GetAnnotCount(page)) checked(p.FPDFPage_Flatten(page, 0), "visible annotation appearances");
		}
		finally { p.FPDF_ClosePage(page); }
	}
	return analysisDocument;
}
function open() {
	ceiling(); p.PDFiumExt_Init();
	if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new Error("Input has no PDF header in its first 1024 bytes.");
	const buffer = alloc(bytes.length); sourceBuffer = buffer; memory.HEAPU8.set(bytes, buffer);
	document = p.FPDF_LoadMemDocument(buffer, bytes.length, "");
	if (!document) throw new Error(p.FPDF_GetLastError() === 4 ? "Encrypted PDFs are not supported." : `PDFium could not open PDF (error ${p.FPDF_GetLastError()})`);
	if (p.FPDF_GetSecurityHandlerRevision(document) !== -1) throw new Error("Encrypted PDFs are not supported.");
	const count = p.FPDF_GetPageCount(document);
	if (count < 1) throw new Error("Missing or invalid page count");
	const metadata: Record<string, string> = { Pages: String(count), Encrypted: "no", Tagged: p.FPDFCatalog_IsTagged(document) ? "yes" : "no" };
	for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) {
		const value = utf16((ptr, size) => p.FPDF_GetMetaText(document, key, ptr, size)); if (value) metadata[key] = value;
	}
	return metadata;
}
function withPage<T>(number: number, run: (page: number) => T, extraction = false) {
	if (!Number.isSafeInteger(number) || number < 1 || number > p.FPDF_GetPageCount(document)) throw new Error("PDF page outside document");
	const doc = extraction ? extractionDocument() : document, environment = formEnvironment(doc);
	const page = p.FPDF_LoadPage(doc, number - 1); checked(page, `page ${number}`);
	try { if (environment) p.FORM_OnAfterLoadPage(page, environment); return run(page); }
	finally { if (environment) p.FORM_OnBeforeClosePage(page, environment); p.FPDF_ClosePage(page); }
}
function geometry(page: number, number: number): PdfPage {
	const boxes: Record<string, number[]> = {}, buffer = alloc(16);
	try {
		for (const [name, get] of [["MediaBox", p.FPDFPage_GetMediaBox], ["CropBox", p.FPDFPage_GetCropBox], ["BleedBox", p.FPDFPage_GetBleedBox], ["TrimBox", p.FPDFPage_GetTrimBox], ["ArtBox", p.FPDFPage_GetArtBox]] as const) {
			if (get(page, buffer, buffer + 4, buffer + 8, buffer + 12)) {
				const [l, b, r, t] = Array.from(new Float32Array(memory.HEAPU8.buffer, buffer, 4)) as [number, number, number, number];
				boxes[name] = [Math.min(l, r), Math.min(b, t), Math.max(l, r), Math.max(b, t)];
			}
			else if (name === "MediaBox") throw new Error("PDFium could not read MediaBox");
			else boxes[name] = [...(boxes.CropBox ?? boxes.MediaBox)!];
		}
	} finally { free(buffer); }
	const width = p.FPDF_GetPageWidthF(page), height = p.FPDF_GetPageHeightF(page);
	if (![width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error("Invalid PDF page geometry");
	return { page: number, width, height, rotation: p.FPDFPage_GetRotation(page) * 90, boxes };
}
type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function matrix(object: number): Matrix {
	const ptr = alloc(24);
	try { checked(p.FPDFPageObj_GetMatrix(object, ptr), "object matrix"); return Array.from(new Float32Array(memory.HEAPU8.buffer, ptr, 6)) as Matrix; } finally { free(ptr); }
}
function multiply(a: Matrix, b: Matrix): Matrix {
	return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
function objects(page: number, visit: (object: number, transform: Matrix) => void, annotations: boolean) {
	let visited = 0;
	const walk = (object: number, parent: Matrix, depth = 0) => {
		if (++visited > 100_000 || depth > 64) throw new Error("PDF object traversal limit exceeded");
		checked(object, "page object");
		if (p.FPDFPageObj_GetType(object) === 5) {
			const transform = multiply(parent, matrix(object));
			for (let i = 0; i < p.FPDFFormObj_CountObjects(object); i++) walk(p.FPDFFormObj_GetObject(object, i), transform, depth + 1);
		} else visit(object, parent);
	};
	for (let i = 0; i < p.FPDFPage_CountObjects(page); i++) walk(p.FPDFPage_GetObject(page, i), identity);
	if (annotations) for (let i = 0; i < p.FPDFPage_GetAnnotCount(page); i++) {
		const annot = p.FPDFPage_GetAnnot(page, i); checked(annot, "annotation");
		try {
			if (p.FPDFAnnot_IsObjectSupportedSubtype(p.FPDFAnnot_GetSubtype(annot))) {
				for (let j = 0; j < p.FPDFAnnot_GetObjectCount(annot); j++) walk(p.FPDFAnnot_GetObject(annot, j), identity);
			}
		} finally { p.FPDFPage_CloseAnnot(annot); }
	}
}
function fonts() {
	const inventory = new Map<string, PdfFont>();
	for (let number = 1; number <= p.FPDF_GetPageCount(document); number++) withPage(number, page => objects(page, object => {
		if (p.FPDFPageObj_GetType(object) !== 1) return;
		const font = p.FPDFTextObj_GetFont(object); checked(font, "text font");
		const name = utf8((ptr, size) => p.FPDFFont_GetBaseFontName(font, ptr, size)) || "Unnamed font";
		const embedded = p.FPDFFont_GetIsEmbedded(font);
		if (embedded < 0) throw new Error("PDFium could not determine font embedding");
		const key = JSON.stringify([name, embedded]);
		const fact: PdfFont = inventory.get(key) ?? { name, embedded: !!embedded, pages: [] };
		if (!fact.pages.includes(number)) fact.pages.push(number);
		inventory.set(key, fact);
	}, false), true);
	return [...inventory.values()];
}
function images(): PdfImage[] {
	const inventory: PdfImage[] = [];
	const ptr = alloc(28);
	try {
		for (let number = 1; number <= p.FPDF_GetPageCount(document); number++) withPage(number, page => objects(page, (object, parent) => {
			if (p.FPDFPageObj_GetType(object) !== 3) return;
			checked(p.FPDFImageObj_GetImageMetadata(object, page, ptr), "image metadata");
			const values = new Uint32Array(memory.HEAPU8.buffer, ptr, 7);
			const width = values[0]!, height = values[1]!, bitsPerPixel = values[4]!, colorSpace = values[5]!;
			const transform = multiply(parent, matrix(object));
			const xPpi = width * 72 / Math.hypot(transform[0], transform[1]), yPpi = height * 72 / Math.hypot(transform[2], transform[3]);
			if (![xPpi, yPpi].every(n => Number.isFinite(n) && n > 0)) throw new Error("Invalid image resolution");
			inventory.push({ page: number, number: inventory.length, width, height, bitsPerPixel, colorSpace, colorSpaceKnown: colorSpace !== 0, xPpi, yPpi });
		}, false), true);
	} finally { free(ptr); }
	return inventory;
}
function presentation(box: number[], page: PdfPage) {
	const crop = page.boxes.CropBox!, media = page.boxes.MediaBox!;
	// Native display geometry clips the CropBox to the MediaBox. Keep raw boxes in facts.
	const left = Math.max(crop[0]!, media[0]!), bottom = Math.max(crop[1]!, media[1]!), right = Math.min(crop[2]!, media[2]!), top = Math.min(crop[3]!, media[3]!);
	const point = (x: number, y: number): [number, number] => page.rotation === 90 ? [y-bottom, x-left] : page.rotation === 180 ? [right-x, y-bottom] : page.rotation === 270 ? [top-y, right-x] : [x-left, top-y];
	const a = point(box[0]!, box[2]!), b = point(box[1]!, box[3]!);
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0]-a[0]), Math.abs(b[1]-a[1])];
}
type Character = { text: string; rect: number[]; start: number; end: number; size: number; angle: number; x: number; y: number; family: string; color: string; bold: boolean; italic: boolean; object: number };
function characters(page: number, number: number) {
	const g = geometry(page, number), textPage = p.FPDFText_LoadPage(page); checked(textPage, "text page");
	const ptr = alloc(96), chars: Character[] = [];
	let recovered = 0;
	try {
		const count = p.FPDFText_CountChars(textPage);
		if (count < 0 || count > 200_000) throw new Error("Too much extracted text");
		for (let i = 0; i < count; i++) {
			const unicode = p.FPDFText_GetUnicode(textPage, i);
			// Missing mappings and replacement glyphs supply no trustworthy extractable word.
			// Record the loss explicitly rather than counting PDFium's character-code fallback.
			if (p.FPDFText_HasUnicodeMapError(textPage, i) === 1) { recovered++; continue; }
			if (!unicode || unicode === 0xfffd) { recovered++; continue; }
			if (unicode < 32 && ![9,10,13].includes(unicode)) { recovered++; continue; }
			const text = String.fromCodePoint(unicode);
			checked(p.FPDFText_GetCharBox(textPage, i, ptr, ptr+8, ptr+16, ptr+24), "character box");
			const box = Array.from(new Float64Array(memory.HEAPU8.buffer, ptr, 4));
			checked(p.FPDFText_GetCharOrigin(textPage, i, ptr+32, ptr+40), "character origin");
			const origins = new Float64Array(memory.HEAPU8.buffer, ptr+32, 2);
			const x = origins[0]!, y = origins[1]!;
			const family = utf8((buffer, size) => p.FPDFText_GetFontInfo(textPage, i, buffer, size, ptr+48));
			const flags = new Uint32Array(memory.HEAPU8.buffer, ptr+48, 1)[0]!;
			let color = "#000000";
			if (p.FPDFText_GetFillColor(textPage, i, ptr+48, ptr+52, ptr+56, ptr+60)) color = "#" + Array.from(new Uint32Array(memory.HEAPU8.buffer, ptr+48, 3)).map(c => c.toString(16).padStart(2, "0")).join("");
			let angle = p.FPDFText_GetCharAngle(textPage, i);
			let size = p.FPDFText_GetFontSize(textPage, i);
			if (p.FPDFText_GetMatrix(textPage, i, ptr + 64)) {
				const m = new Float32Array(memory.HEAPU8.buffer, ptr + 64, 6);
				size *= Math.hypot(m[2]!, m[3]!);
				angle = Math.atan2(m[1]!, m[0]!);
			}
			// Loose boxes include advance widths; tight glyph bearings must not split digits or italic text.
			let loose = box;
			if (p.FPDFText_GetLooseCharBox(textPage, i, ptr+64)) {
				const b = new Float32Array(memory.HEAPU8.buffer, ptr+64, 4);
				loose = [b[0]!, b[2]!, b[3]!, b[1]!];
			}
			const along = [loose[0]!*Math.cos(angle)+loose[2]!*Math.sin(angle), loose[1]!*Math.cos(angle)+loose[3]!*Math.sin(angle)];
			chars.push({ text, rect: presentation(box, g), start: Math.min(...along), end: Math.max(...along), size, angle, x, y, object: p.FPDFText_GetTextObject(textPage, i),
				family, color, bold: p.FPDFText_GetFontWeight(textPage, i) >= 700 || /bold/i.test(family), italic: !!(flags & 64) || /italic|oblique/i.test(family) });
		}
		if (recovered) diagnostics.push("PDFium omitted " + recovered + " characters without reliable Unicode mappings. Verify extracted text against the render; omitted glyphs are not counted as extractable words.");
		return { geometry: g, chars };
	} finally { free(ptr); p.FPDFText_ClosePage(textPage); }
}
function union(a: number[], b: number[]) {
	const left = Math.min(a[0]!, b[0]!), top = Math.min(a[1]!, b[1]!);
	return [left, top, Math.max(a[0]!+a[2]!, b[0]!+b[2]!)-left, Math.max(a[1]!+a[3]!, b[1]!+b[3]!)-top];
}
function newLine(a: Character, b: Character) {
	const dx = b.x-a.x, dy = b.y-a.y;
	return Math.abs(a.angle-b.angle) > 0.1 || Math.abs(-dx*Math.sin(a.angle)+dy*Math.cos(a.angle)) > Math.max(a.size, b.size)*0.5;
}
function wordBreak(a: Character, b: Character) {
	if (newLine(a, b)) return true;
	if (Math.min(a.size, b.size) > 0 && Math.max(a.size, b.size)/Math.min(a.size, b.size) > 1.25) return true;
	const dx = b.x-a.x, dy = b.y-a.y, advance = dx*Math.cos(a.angle)+dy*Math.sin(a.angle);
	return advance < -Math.max(a.size, b.size)*0.25 || b.start-a.end > Math.max(a.size, b.size)*0.2;
}
function replacements(page: number, geometry: PdfPage) {
	const groups = new Map<number, { text: string; rect: number[]; objects: number[] }>();
	const ptr = alloc(20);
	try {
		objects(page, (object, parent) => {
			for (let i = 0; i < p.FPDFPageObj_CountMarks(object); i++) {
				const mark = p.FPDFPageObj_GetMark(object, i);
				if (p.FPDFPageObjMark_GetParamValueType(mark, "ActualText") !== 3) continue;
				checked(p.FPDFPageObjMark_GetParamStringValue(mark, "ActualText", 0, 0, ptr+16), "ActualText length");
				const length = new Uint32Array(memory.HEAPU8.buffer, ptr+16, 1)[0]!, buffer = alloc(length);
				let text: string;
				try {
					checked(p.FPDFPageObjMark_GetParamStringValue(mark, "ActualText", buffer, length, ptr+16), "ActualText");
					text = Buffer.from(memory.HEAPU8.subarray(buffer, buffer+length)).toString("utf16le").replace(/\0/g, "");
				} finally { free(buffer); }
				checked(p.FPDFPageObj_GetBounds(object, ptr, ptr+4, ptr+8, ptr+12), "ActualText bounds");
				const [l,b,r,t] = Array.from(new Float32Array(memory.HEAPU8.buffer, ptr, 4)) as [number,number,number,number];
				const corners = [[l,b],[r,b],[l,t],[r,t]].map(([x,y]) => [parent[0]*x!+parent[2]*y!+parent[4], parent[1]*x!+parent[3]*y!+parent[5]]);
				const rect = presentation([Math.min(...corners.map(c=>c[0]!)), Math.max(...corners.map(c=>c[0]!)), Math.min(...corners.map(c=>c[1]!)), Math.max(...corners.map(c=>c[1]!))], geometry);
				const group = groups.get(mark);
				if (group) { group.rect = union(group.rect, rect); group.objects.push(object); }
				else groups.set(mark, { text, rect, objects: [object] });
				// The outer replacement owns the enclosed marked content.
				break;
			}
		}, false);
	} finally { free(ptr); }
	return [...groups.values()];
}
function words(): PdfWord[] {
	const inventory: PdfWord[] = [];
	for (let number = 1; number <= p.FPDF_GetPageCount(document); number++) withPage(number, page => {
		let current: PdfWord | undefined, previous: Character | undefined;
		const { geometry, chars } = characters(page, number), actual = replacements(page, geometry), emitted = new Set<unknown>();
		const emit = (replacement: typeof actual[number]) => {
			if (emitted.has(replacement)) return;
			for (const text of replacement.text.split(/\s+/u).filter(Boolean)) inventory.push({ page: number, text, rect: replacement.rect });
			emitted.add(replacement); current = undefined; previous = undefined;
		};
		for (const char of chars) {
			const replacement = actual.find(r => r.objects.includes(char.object));
			if (replacement) { emit(replacement); continue; }
			if (/\s/u.test(char.text)) { current = undefined; previous = undefined; continue; }
			if (!current || !previous || wordBreak(previous, char)) { current = { page: number, text: char.text, rect: char.rect }; inventory.push(current); }
			else { current.text += char.text; current.rect = union(current.rect, char.rect); }
			previous = char;
		}
		for (const replacement of actual) emit(replacement);
	}, true);
	return inventory;
}
function spans(number: number): PdfPageSpans {
	return withPage(number, page => {
		const { geometry: g, chars } = characters(page, number);
		const data: PdfPageSpans = { page: number, width: g.width, height: g.height, fonts: [], spans: [] };
		let current: PdfPageSpans["spans"][number] | undefined, previous: Character | undefined;
		for (const char of chars) {
			if (/[\r\n]/u.test(char.text)) { current = undefined; previous = undefined; continue; }
			const key = JSON.stringify([char.family, char.size, char.color]);
			let font = data.fonts.find(f => JSON.stringify([f.family, f.sizePt, f.color]) === key);
			if (!font) { font = { id: String(data.fonts.length), family: char.family, sizePt: char.size, color: char.color }; data.fonts.push(font); }
			if (!current || !previous || current.font !== font.id || current.bold !== char.bold || current.italic !== char.italic || newLine(previous, char)) {
				current = { left: char.rect[0]!, top: char.rect[1]!, width: char.rect[2]!, height: char.rect[3]!, text: char.text, font: font.id, bold: char.bold, italic: char.italic }; data.spans.push(current);
			} else {
				const rect = union([current.left, current.top, current.width, current.height], char.rect);
				[current.left, current.top, current.width, current.height] = rect as [number, number, number, number]; current.text += char.text;
			}
			previous = char;
		}
		data.spans = data.spans.filter(s => s.text.trim());
		if (data.spans.length > 5000 || data.fonts.length > 1000) throw new Error("Design span limit exceeded");
		return data;
	}, true);
}
function png(width: number, height: number, bitmap: number) {
	const ptr = p.FPDFBitmap_GetBuffer(bitmap), stride = p.FPDFBitmap_GetStride(bitmap);
	const pixels = memory.HEAPU8.subarray(ptr, ptr + stride*height), raw = Buffer.alloc((width*3+1)*height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const from = y*stride+x*4, to = y*(width*3+1)+1+x*3;
		raw[to] = pixels[from+2]!; raw[to+1] = pixels[from+1]!; raw[to+2] = pixels[from]!;
	}
	const crc = (data: Buffer) => { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
	const chunk = (type: string, data: Buffer) => { const size = Buffer.alloc(4), content = Buffer.concat([Buffer.from(type), data]), sum = Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE(crc(content)); return Buffer.concat([size, content, sum]); };
	const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
	return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function render(number: number, options: PdfRender) {
	return withPage(number, page => {
		const g = geometry(page, number);
		let width: number, height: number, fullWidth: number, fullHeight: number, x = 0, y = 0;
		if ("height" in options) {
			if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("Invalid PDF overview height");
			height = options.height; width = Math.round(height*g.width/g.height); fullWidth = width; fullHeight = height;
		} else {
			const r = options.rect, scale = options.dpi/72;
			if (!Number.isFinite(options.dpi) || options.dpi <= 0 || ![r.left, r.top, r.width, r.height].every(Number.isFinite) || r.left < 0 || r.top < 0 || r.width <= 0 || r.height <= 0 || r.left+r.width > g.width+0.001 || r.top+r.height > g.height+0.001) throw new Error("Invalid PDF crop");
			x = Math.floor(r.left*scale); y = Math.floor(r.top*scale);
			width = Math.ceil((r.left+r.width)*scale)-x; height = Math.ceil((r.top+r.height)*scale)-y;
			fullWidth = Math.ceil(g.width*scale); fullHeight = Math.ceil(g.height*scale);
		}
		if (width < 1 || height < 1 || width*height > 16_000_000) throw new Error("PDF render exceeds 16 million pixel limit");
		const bitmap = p.FPDFBitmap_Create(width, height, 0); checked(bitmap, "render bitmap");
		try {
			p.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
			// FPDF_ANNOT renders annotation appearances; LCD text changes pixels and is deliberately disabled.
			const ptr = alloc(40);
			try {
				const scaleX = "height" in options ? fullWidth/g.width : options.dpi/72;
				const scaleY = "height" in options ? fullHeight/g.height : options.dpi/72;
				new Float32Array(memory.HEAPU8.buffer, ptr, 10).set([scaleX, 0, 0, scaleY, -x, -y, 0, 0, width, height]);
				// The native display matrix already accounts for CropBox and page rotation.
				// An explicit scale preserves fractional dimensions instead of rounding the page viewport.
				p.FPDF_RenderPageBitmapWithMatrix(bitmap, page, ptr, ptr+24, 1);
				// FPDF_ANNOT omits widgets. Render their normal appearances with the same matrix.
				for (let i = 0; i < p.FPDFPage_GetAnnotCount(page); i++) {
					const annot = p.FPDFPage_GetAnnot(page, i); checked(annot, "render annotation");
					try {
						if (p.FPDFAnnot_GetSubtype(annot) !== 20 || p.FPDFAnnot_GetFlags(annot) & (1|2|32)) continue;
						if (p.EPDFAnnot_HasAppearanceStream(annot, 0)) checked(p.EPDF_RenderAnnotBitmap(bitmap, page, annot, 0, ptr, 1), "widget appearance render");
						else diagnostics.push("Widget has no normal appearance stream; verify its field state in a PDF viewer.");
					} finally { p.FPDFPage_CloseAnnot(annot); }
				}
			} finally { free(ptr); }
			return png(width, height, bitmap);
		} finally { p.FPDFBitmap_Destroy(bitmap); }
	});
}
parentPort!.on("message", ({ operation, data }: { operation: string; data: unknown }) => {
	try {
		const result: unknown = operation === "open" ? open() : operation === "facts" ? data === "pages" ? Array.from({ length: p.FPDF_GetPageCount(document) }, (_, i) => withPage(i+1, page => geometry(page, i+1))) : data === "fonts" ? fonts() : data === "images" ? images() : data === "words" ? words() : (() => { throw new Error("Unknown PDF fact inventory"); })()
			: operation === "spans" ? spans(data as number) : operation === "render" ? render((data as { page: number }).page, (data as { options: PdfRender }).options) : (() => { throw new Error("Unknown PDF engine operation"); })();
		ceiling();
		if (!(result instanceof Uint8Array) && Buffer.byteLength(JSON.stringify(result)) > 32*1024*1024) throw new Error("PDF facts exceed 32 MiB limit");
		parentPort!.postMessage({ result, diagnostics: diagnostics.splice(0) });
	} catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error), fatal, diagnostics: diagnostics.splice(0) }); }
});
