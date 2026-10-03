import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openPdf, pdfCoordinates, pdfEngineVersion, type PdfEngine, type PdfEngineLimits, type PdfInventories } from "./pdf-engine.ts";

export type PdfToolEvidence = { tool: string; args: string[]; exitCode: number | null; stdout: string; stderr: string; error?: string };
export type PdfEngineEvidence = { engine: typeof pdfEngineVersion; operation: string; outcome: "passed" | "untested"; diagnostics: string[]; error?: string };
type ExtractionEvaluation = { rule: string; outcome: "passed" | "untested"; reason: string };
type Warning = { rule: string; message: string; remedy: string; evidence: string };

/** Read the caller's immutable snapshot. Each inventory fails independently and retains its diagnostic. */
export async function extractPdfFacts(snapshot: string, limits: PdfEngineLimits = {}) {
	const bytes = await readFile(snapshot);
	const result = {
		document: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }, engine: pdfEngineVersion,
		machineStatus: "complete" as "complete" | "incomplete", evidence: [] as (PdfToolEvidence | PdfEngineEvidence)[],
		facts: { metadata: {} as Record<string, string>, pages: [], fonts: [], images: [], words: [], coordinates: pdfCoordinates } as PdfInventories & { metadata: Record<string, string>; coordinates: typeof pdfCoordinates },
		evaluations: [] as ExtractionEvaluation[], needsReview: [] as Warning[],
	};
	let engine: PdfEngine | undefined;
	const warn = (rule: string, diagnostics: string[]) => {
		if (diagnostics.length) result.needsReview.push({ rule, message: "PDFium reported warnings while reading the PDF. See the evidence.", remedy: "Review the diagnostic and regenerate from source if needed.", evidence: diagnostics.join("\n") });
	};
	const extract = async <T>(rule: string, operation: string, read: () => Promise<T>): Promise<T | undefined> => {
		try {
			const value = await read(), diagnostics = engine?.diagnostics.splice(0) ?? [];
			result.evidence.push({ engine: pdfEngineVersion, operation, outcome: "passed", diagnostics });
			result.evaluations.push({ rule, outcome: "passed", reason: "Extraction completed; this is not a quality or conformance verdict." });
			warn(rule, diagnostics);
			return value;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			result.machineStatus = "incomplete";
			const retained = error instanceof Error && "diagnostics" in error && Array.isArray(error.diagnostics) && error.diagnostics.every(d => typeof d === "string") ? error.diagnostics as string[] : [];
			const diagnostics = engine?.diagnostics.splice(0) ?? retained;
			result.evidence.push({ engine: pdfEngineVersion, operation, outcome: "untested", diagnostics, error: reason });
			warn(rule, diagnostics);
			result.evaluations.push({ rule, outcome: "untested", reason });
			return undefined;
		}
	};
	try {
		const metadata = await extract("pdf.open", "open", async () => { engine = await openPdf(bytes, limits); return engine.metadata; });
		if (metadata) {
			result.facts.metadata = metadata;
			for (const [kind, rule] of [["pages", "page.facts"], ["fonts", "font.facts"], ["images", "image.facts"], ["words", "text.facts"]] as const) {
				const value = await extract(rule, kind, () => engine!.facts(kind));
				if (value) Object.assign(result.facts, { [kind]: value });
			}
		}
		for (const rule of ["page.facts", "font.facts", "image.facts", "text.facts"]) {
			if (!result.evaluations.some(e => e.rule === rule)) result.evaluations.push({ rule, outcome: "untested", reason: "PDF could not be opened; extraction did not run." });
		}
		return result;
	} finally { await engine?.close(); }
}
