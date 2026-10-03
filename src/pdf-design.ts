import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openPdf, pdfCoordinates, pdfEngineVersion, type PdfPage, type PdfPageSpans } from "./pdf-engine.ts";

export type PdfDesignRequirements = { minTextSizePt?: number };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function measurePdfDesignPage(data: PdfPageSpans, requirements: PdfDesignRequirements) {
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

/** Enrich an existing private review bundle using its immutable PDF snapshot. Failures reject. */
export async function preparePdfDesignEvidence(path: string, outputDirectory: string, pages: PdfPage[], requirements: PdfDesignRequirements = {}) {
	if (Object.keys(requirements).some(key => key !== "minTextSizePt") || (requirements.minTextSizePt !== undefined && (!Number.isFinite(requirements.minTextSizePt) || requirements.minTextSizePt <= 0))) throw new Error("Invalid explicit design requirements");
	if (!pages.length || pages.length > 24 || new Set(pages.map(p => p.page)).size !== pages.length || pages.some(p => !Number.isSafeInteger(p.page) || p.page < 1)) throw new Error("Select 1-24 unique pages for design evidence");
	const input = await readFile(resolve(path)), directory = resolve(outputDirectory), engine = await openPdf(input);
	const documentSha256 = hash(input);
	try {
		const geometries = await engine.facts("pages"), artifacts = [];
		for (const geometry of pages) {
			const data = await engine.pageSpans(geometry.page), actual = geometries[geometry.page - 1]!;
			const extractionDiagnostics = engine.diagnostics.splice(0);
			const source = "page-" + geometry.page + "-design.json", sourceBytes = JSON.stringify(data, null, 2);
			await writeFile(join(directory, source), sourceBytes, { mode: 0o600, flag: "wx" });
			const mappingSupported = geometry.width === actual.width && geometry.height === actual.height && geometry.rotation === actual.rotation && JSON.stringify(geometry.boxes.CropBox) === JSON.stringify(actual.boxes.CropBox);
			const measurements = measurePdfDesignPage(data, requirements), crops = [];
			if (mappingSupported) {
				const width = data.width, height = data.height;
				const candidates = data.spans.map((span, index) => ({ span, index, size: data.fonts.find(f => f.id === span.font)!.sizePt }))
					.filter(({ span }) => span.text.trim() && span.width > 0 && span.height > 0 && span.left < width && span.top < height && span.left + span.width > 0 && span.top + span.height > 0)
					.sort((a, b) => a.size - b.size || a.index - b.index).slice(0, 1);
				const widestGap = [...measurements.textBoxGaps].sort((a, b) => b.verticalGapPt - a.verticalGapPt)[0];
				const second = widestGap && data.spans[widestGap.secondSpan];
				if (second && !candidates.some(c => c.span === second)) candidates.push({ span: second, index: widestGap!.secondSpan, size: data.fonts.find(f => f.id === second.font)!.sizePt });
				for (const candidate of candidates) {
					const span = candidate.span;
					const left = Math.max(0, Math.min(span.left - 24, width - 1)), top = Math.max(0, Math.min(span.top - 36, height - 1));
					const rect = { left, top, width: Math.min(432, Math.max(216, span.width + 48), width - left), height: Math.min(216, Math.max(108, span.height + 72), height - top) };
					const pixels = { x: Math.floor(left * 2), y: Math.floor(top * 2), width: Math.ceil((left + rect.width) * 2) - Math.floor(left * 2), height: Math.ceil((top + rect.height) * 2) - Math.floor(top * 2) };
					const image: string = "page-" + geometry.page + "-detail-" + (crops.length + 1) + ".png";
					const bytes = await engine.renderPage(geometry.page, { dpi: 144, rect });
					if (bytes.length > 8 * 1024 * 1024 || bytes.readUInt32BE(16) !== pixels.width || bytes.readUInt32BE(20) !== pixels.height) throw new Error("Unexpected design crop dimensions or format");
					await writeFile(join(directory, image), bytes, { mode: 0o600, flag: "wx" });
					crops.push({ image, imageSha256: hash(bytes), rect, pixels, selectedSpan: candidate.index, reason: crops.length === 0 ? "Smallest extracted font size on page" : "Text following largest measured adjacent text-box gap",
						render: { engine: pdfEngineVersion, operation: "render", page: geometry.page, dpi: 144, rect, diagnostics: engine.diagnostics.splice(0) } });
				}
			}
			artifacts.push({ source, sourceSha256: hash(sourceBytes), extraction: { engine: pdfEngineVersion, operation: "spans", diagnostics: extractionDiagnostics },
				coordinates: pdfCoordinates.text, mappingSupported, mappingLimitation: mappingSupported ? null : "Supplied geometry does not match this PDF's rotated CropBox. Use the overview.",
				...data, measurements, crops });
		}
		const evidence = { schemaVersion: "pdf-design-evidence-2", documentSha256, engine: pdfEngineVersion, requirements, pages: artifacts,
			artifacts: artifacts.flatMap(page => [{ path: page.source, sha256: page.sourceSha256 }, ...page.crops.map(crop => ({ path: crop.image, sha256: crop.imageSha256 }))]),
			uncertainty: "PDFium character boxes, transformed font sizes and foreground colors are source evidence, not guaranteed visible glyphs. UserUnit scaling is not independently validated. Text extraction includes visible annotation appearance streams flattened in a separate copy. Text boxes exclude drawn rules, images and clipping. No contrast ratio, blank-space, design-quality or accessibility verdict is inferred. Render crops include supported annotation appearances at 144 DPI using the rotated CropBox clipped to the MediaBox; inspect page overviews for context. Intentional whitespace and mixed orientation are not defects." };
		const summary = JSON.stringify(evidence, null, 2);
		await writeFile(join(directory, "design-evidence.json"), summary, { mode: 0o600, flag: "wx" });
		return { ...evidence, artifacts: [...evidence.artifacts, { path: "design-evidence.json", sha256: hash(summary) }] };
	} finally { await engine.close(); }
}
