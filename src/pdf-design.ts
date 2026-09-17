import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const maxXmlBytes = 4 * 1024 * 1024;
type Geometry = { page: number; width: number; height: number; rotation: number; boxes: Record<string, number[]> };
type Rect = { left: number; top: number; width: number; height: number };
type Span = Rect & { text: string; font: string; bold: boolean; italic: boolean };
export type PdfDesignRequirements = { minTextSizePt?: number };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function decode(value: string) {
	if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) throw new Error("Unsupported XML entity");
	return value.replace(/&([^;]+);/g, (_, entity: string) => {
		const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
		if (named[entity]) return named[entity]!;
		const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
		if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("Invalid XML character");
		return String.fromCodePoint(code);
	});
}

/** Parses only Poppler's bounded XML dialect. No DTD/entity loading or recovery. */
export function parsePdfDesignXml(xml: string) {
	if (Buffer.byteLength(xml) > maxXmlBytes) throw new Error("Design XML exceeds 4 MiB limit");
	xml = xml.replace(/^\s*<\?xml version="1\.0" encoding="UTF-8"\?>\s*/, "")
		.replace(/^<!DOCTYPE pdf2xml SYSTEM "pdf2xml.dtd">\s*/, "");
	const stack: string[] = [];
	const fonts: { id: string; sizePt: number; family: string; color: string }[] = [];
	const spans: Span[] = [];
	let page: { page: number; width: number; height: number } | undefined;
	let span: Span | undefined, cursor = 0, roots = 0, chars = 0;
	const number = (value: string | undefined, positive = false) => {
		if (!value || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid design XML number");
		const n = Number(value);
		if (!Number.isFinite(n) || Math.abs(n) > 100_000 || (positive && n <= 0)) throw new Error("Design XML number out of bounds");
		return n;
	};
	for (const match of xml.matchAll(/<[^>]*>|[^<]+/g)) {
		if (match.index !== cursor) throw new Error("Malformed design XML");
		const token = match[0]; cursor += token.length;
		if (!token.startsWith("<")) {
			if (span || stack.at(-1) === "item") {
				const text = decode(token);
				if (span) span.text += text;
				chars += token.length; if (chars > 200_000) throw new Error("Too much extracted text");
			}
			else if (token.trim()) throw new Error("Unexpected XML text");
			continue;
		}
		const tag = token.match(/^<(\/)?([a-z0-9]+)([\s\S]*?)(\/?)>$/);
		if (!tag) throw new Error("Unsupported design XML markup");
		const [, close, name, raw, self] = tag;
		if (close) {
			if (raw!.trim() || self || stack.pop() !== name) throw new Error("Unbalanced design XML");
			if (name === "text") { spans.push(span!); span = undefined; }
			continue;
		}
		const attrs: Record<string, string> = {};
		let rest = raw!;
		while (rest.trim()) {
			const attr = rest.match(/^\s+([a-zA-Z][\w-]*)="([^"<>]*)"/);
			if (!attr || Object.hasOwn(attrs, attr[1]!)) throw new Error("Malformed XML attribute");
			attrs[attr[1]!] = decode(attr[2]!); rest = rest.slice(attr[0].length);
		}
		const parent = stack.at(-1);
		if (name === "pdf2xml" && !parent && roots++ === 0 && !self) { /* document root */ }
		else if (name === "outline" && ["pdf2xml", "outline"].includes(parent ?? "") && !self) {
			// Poppler emits document bookmarks after the page, with nested sibling outlines.
		} else if (name === "item" && parent === "outline" && !self) {
			if (attrs.page !== undefined && !Number.isSafeInteger(number(attrs.page, true))) throw new Error("Invalid outline page");
		} else if (name === "page" && parent === "pdf2xml" && !page && !self) {
			page = { page: number(attrs.number, true), width: number(attrs.width, true), height: number(attrs.height, true) };
			if (!Number.isSafeInteger(page.page) || Math.max(page.width, page.height) > 20_000) throw new Error("Invalid XML page geometry");
		} else if (name === "fontspec" && parent === "page" && self) {
			if (!attrs.id || fonts.some((f) => f.id === attrs.id) || !attrs.family || !/^#[\da-fA-F]{6}$/.test(attrs.color ?? "") || fonts.length >= 1000) throw new Error("Invalid font specification");
			fonts.push({ id: attrs.id, sizePt: number(attrs.size, true), family: attrs.family, color: attrs.color! });
		} else if (name === "text" && parent === "page" && !self && spans.length < 5000) {
			if (!fonts.some((f) => f.id === attrs.font)) throw new Error("Unknown text font");
			span = { left: number(attrs.left), top: number(attrs.top), width: number(attrs.width), height: number(attrs.height), font: attrs.font!, text: "", bold: false, italic: false };
			if (span.width < 0 || span.height < 0) throw new Error("Negative text dimensions");
		} else if (["b", "i", "a"].includes(name!) && span && ["text", "b", "i", "a"].includes(parent ?? "") && !self) {
			if (name === "b") span.bold = true;
			if (name === "i") span.italic = true;
		} else throw new Error(`Unsupported design XML element: ${name}`);
		if (!self) stack.push(name!);
		if (stack.length > 8) throw new Error("Design XML nesting limit exceeded");
	}
	if (cursor !== xml.length || stack.length || roots !== 1 || !page) throw new Error("Incomplete design XML");
	return { ...page, fonts, spans };
}

export function measurePdfDesignPage(data: ReturnType<typeof parsePdfDesignXml>, requirements: PdfDesignRequirements) {
	const spans = data.spans.map((span, index) => ({ ...span, index })).filter((s) => s.text.trim() && s.width > 0 && s.height > 0);
	const ordered = [...spans].sort((a, b) => a.top - b.top || a.left - b.left);
	const gaps: { firstSpan: number; secondSpan: number; verticalGapPt: number }[] = [];
	for (let i = 1; i < ordered.length; i++) {
		const a = ordered[i - 1]!, b = ordered[i]!;
		const overlap = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
		const gap = b.top - a.top - a.height;
		if (overlap > 0 && gap >= 0) gaps.push({ firstSpan: a.index, secondSpan: b.index, verticalGapPt: gap });
	}
	const envelope = spans.length ? {
		left: Math.min(...spans.map((s) => s.left)), top: Math.min(...spans.map((s) => s.top)),
		right: Math.max(...spans.map((s) => s.left + s.width)), bottom: Math.max(...spans.map((s) => s.top + s.height)),
	} : null;
	return { extractedTextEnvelope: envelope, textBoxGaps: gaps.slice(0, 100), totalTextBoxGaps: gaps.length,
		textBoxGapMeaning: "Vertical distance between adjacent top-sorted extracted text boxes with horizontal overlap; not baseline leading, visible whitespace or inferred reading order.",
		requirement: requirements.minTextSizePt === undefined ? null : {
			source: "Caller-declared minimum for all extracted text", minTextSizePt: requirements.minTextSizePt,
			belowMinimumSpanIndexes: data.spans.flatMap((span, i) => data.fonts.find((f) => f.id === span.font)!.sizePt < requirements.minTextSizePt! ? [i] : []),
			meaning: "Comparison to the explicit extraction-size requirement only; visibility and actual transformed glyph size require render inspection.",
		},
	};
}

/** Enrich an existing private review bundle. Input must be its immutable PDF snapshot. */
export async function preparePdfDesignEvidence(path: string, outputDirectory: string, pages: Geometry[], requirements: PdfDesignRequirements = {}) {
	if (Object.keys(requirements).some((key) => key !== "minTextSizePt") || (requirements.minTextSizePt !== undefined && (!Number.isFinite(requirements.minTextSizePt) || requirements.minTextSizePt <= 0))) throw new Error("Invalid explicit design requirements");
	if (!pages.length || pages.length > 24 || new Set(pages.map((p) => p.page)).size !== pages.length || pages.some((p) => !Number.isSafeInteger(p.page) || p.page < 1)) throw new Error("Select 1–24 unique pages for design evidence");
	const input = resolve(path), directory = resolve(outputDirectory);
	const run = async (tool: string, args: string[]) => {
		const result = await exec(tool, args, { encoding: "utf8", timeout: 30_000, maxBuffer: maxXmlBytes, env: { ...process.env, LC_ALL: "C" } });
		return { tool, args, ...result };
	};
	const documentSha256 = hash(await readFile(input));
	const versions = await Promise.all(["pdftohtml", "pdftoppm"].map(async (tool) => {
		const result = await run(tool, ["-v"]); return { tool, version: `${result.stdout}${result.stderr}`.trim() };
	}));
	const artifacts = [];
	for (const geometry of pages) {
		// Quiet mode prevents internal-link diagnostics from being interleaved with XML on stdout.
		const result = await run("pdftohtml", ["-q", "-xml", "-i", "-stdout", "-zoom", "1", "-noroundcoord", "-f", String(geometry.page), "-l", String(geometry.page), input]);
		const data = parsePdfDesignXml(result.stdout);
		if (data.page !== geometry.page) throw new Error("Design extraction returned a different page");
		const xml = `page-${geometry.page}-design.xml`;
		await writeFile(join(directory, xml), result.stdout, { mode: 0o600, flag: "wx" });
		const media = geometry.boxes.MediaBox, crop = geometry.boxes.CropBox;
		const mappingSupported = geometry.rotation === 0 && !!media && media.length === 4 && media[0] === 0 && media[1] === 0 && !!crop && crop.length === 4 && crop.every((n, i) => n === media[i])
			// HtmlOutputDev::startPage truncates page dimensions to int even with -noroundcoord.
			&& data.width === Math.trunc(media[2]!) && data.height === Math.trunc(media[3]!);
		const measurements = measurePdfDesignPage(data, requirements);
		const crops = [];
		if (mappingSupported) {
			const width = media![2]!, height = media![3]!;
			// ponytail: two fixed candidates per page; add explicit reviewer regions when review navigation needs them.
			const candidates = data.spans.map((span, index) => ({ span, index, size: data.fonts.find((f) => f.id === span.font)!.sizePt }))
				.filter(({ span }) => span.text.trim() && span.width > 0 && span.height > 0 && span.left < width && span.top < height && span.left + span.width > 0 && span.top + span.height > 0)
				.sort((a, b) => a.size - b.size || a.index - b.index).slice(0, 1);
			const widestGap = [...measurements.textBoxGaps].sort((a, b) => b.verticalGapPt - a.verticalGapPt)[0];
			const second = widestGap && data.spans[widestGap.secondSpan];
			if (second && !candidates.some((c) => c.span === second)) candidates.push({ span: second, index: widestGap!.secondSpan, size: data.fonts.find((f) => f.id === second.font)!.sizePt });
			for (const candidate of candidates) {
				const span = candidate.span;
				const left = Math.max(0, Math.min(span.left - 24, width - 1)), top = Math.max(0, Math.min(span.top - 36, height - 1));
				const rect = { left, top, width: Math.min(432, Math.max(216, span.width + 48), width - left), height: Math.min(216, Math.max(108, span.height + 72), height - top) };
				const pixels = { x: Math.floor(left * 2), y: Math.floor(top * 2), width: Math.ceil((left + rect.width) * 2) - Math.floor(left * 2), height: Math.ceil((top + rect.height) * 2) - Math.floor(top * 2) };
				const image: string = `page-${geometry.page}-detail-${crops.length + 1}.png`;
				const render = await run("pdftoppm", ["-f", String(geometry.page), "-l", String(geometry.page), "-singlefile", "-r", "144", "-x", String(pixels.x), "-y", String(pixels.y), "-W", String(pixels.width), "-H", String(pixels.height), "-png", input, join(directory, image.slice(0, -4))]);
				const bytes = await readFile(join(directory, image)); await chmod(join(directory, image), 0o600);
				if (bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(16) !== pixels.width || bytes.readUInt32BE(20) !== pixels.height) throw new Error("Unexpected design crop dimensions or format");
				crops.push({ image, imageSha256: hash(bytes), rect, pixels, selectedSpan: candidate.index, reason: crops.length === 0 ? "Smallest extracted font size on page" : "Text following largest measured adjacent text-box gap", render });
			}
		}
		artifacts.push({ xml, xmlSha256: hash(result.stdout), extraction: { tool: result.tool, args: result.args, stderr: result.stderr, diagnostics: "Poppler quiet mode suppresses diagnostic messages to keep stdout XML-only; nonzero exits still fail extraction." },
			coordinates: "Poppler pdftohtml -zoom 1 top-left presentation coordinates; nominal points", mappingSupported,
			mappingLimitation: mappingSupported ? null : "Detail crop mapping unsupported for rotated, offset, differing page boxes or mismatched dimensions. Use the page overview; do not map these text boxes onto it.",
			...data, measurements, crops });
	}
	const evidence = { schemaVersion: "pdf-design-evidence-1", documentSha256, tools: versions, requirements, pages: artifacts,
		artifacts: artifacts.flatMap((page) => [{ path: page.xml, sha256: page.xmlSha256 }, ...page.crops.map((crop) => ({ path: crop.image, sha256: crop.imageSha256 }))]),
		uncertainty: "Extracted text, font sizes and foreground colors are source evidence, not guaranteed visible glyphs. Font sizes may be rounded or transformed. UserUnit scaling is not independently validated. Text boxes exclude drawn rules, images and clipping. No contrast ratio, blank-space, design-quality or accessibility verdict is inferred. Render crops include annotations at 144 DPI using the MediaBox; inspect page overviews for context. Intentional whitespace and mixed orientation are not defects." };
	const summary = JSON.stringify(evidence, null, 2);
	await writeFile(join(directory, "design-evidence.json"), summary, { mode: 0o600, flag: "wx" });
	return { ...evidence, artifacts: [...evidence.artifacts, { path: "design-evidence.json", sha256: hash(summary) }] };
}
