import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { popplerExecutable } from "./poppler.ts";

const exec = promisify(execFile);
export type PdfToolEvidence = { tool: string; args: string[]; exitCode: number | null; stdout: string; stderr: string; error?: string };
// Both adapters return the subprocess evidence, so failures retain the same diagnostics as successful commands.
export type PopplerExecution = (tool: string, args: string[]) => Promise<PdfToolEvidence>;
type Page = { page: number; width: number; height: number; rotation: number; boxes: Record<string, number[]> };
type ExtractionEvaluation = { rule: string; outcome: "passed" | "untested"; reason: string };
type Warning = { rule: string; message: string; remedy: string; evidence: string };

const run: PopplerExecution = async (tool, args) => {
	try {
		const { stdout, stderr } = await exec(popplerExecutable(tool), args, { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
		return { tool, args, exitCode: 0, stdout, stderr };
	} catch (error) {
		const e = error as Error & { code?: number | string; stdout?: string; stderr?: string };
		return { tool, args, exitCode: typeof e.code === "number" ? e.code : null, stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: e.message };
	}
};

export function parsePages(raw: string, count: number): Page[] {
	const pages: Page[] = [];
	for (let page = 1; page <= count; page++) {
		const prefix = `^Page\\s+${page}\\s+`;
		const size = raw.match(new RegExp(`${prefix}size:\\s+([\\d.]+) x ([\\d.]+) pts`, "m"));
		const rotation = raw.match(new RegExp(`${prefix}rot:\\s+(-?\\d+)`, "m"));
		if (!size || !rotation) throw new Error(`Missing page ${page} geometry`);
		const boxes: Record<string, number[]> = {};
		for (const name of ["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"]) {
			const match = raw.match(new RegExp(`${prefix}${name}:\\s+([^\\r\\n]+)`, "m"));
			const values = match?.[1]?.trim().split(/\s+/).map(Number);
			if (!values || values.length !== 4 || values.some((n) => !Number.isFinite(n))) throw new Error(`Missing page ${page} ${name}`);
			boxes[name] = values;
		}
		pages.push({ page, width: Number(size[1]), height: Number(size[2]), rotation: Number(rotation[1]), boxes });
	}
	return pages;
}

function tableRows(raw: string, header: RegExp): string[] {
	const lines = raw.trim().split(/\r?\n/);
	if (!header.test(lines[0] ?? "") || !/^-+(?:\s+-+)*$/.test(lines[1] ?? "")) throw new Error("Unrecognized Poppler table header");
	return lines.slice(2).filter((line) => line.trim());
}
export function parseFonts(raw: string) {
	return tableRows(raw, /^name\s+type\s+encoding\s+emb\s+sub\s+uni\s+object ID$/).map((line) => {
		const m = line.match(/^(\S+)\s+(.+?)\s+(\S+)\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+(\d+)\s+(\d+)\s*$/);
		if (!m) throw new Error(`Unrecognized font row: ${line}`);
		return { name: m[1]!, type: m[2]!, encoding: m[3]!, embedded: m[4] === "yes", subset: m[5] === "yes", unicodeMap: m[6] === "yes", object: `${m[7]} ${m[8]}`, raw: line };
	});
}
export function parseImages(raw: string) {
	return tableRows(raw, /^page\s+num\s+type\s+width height/).map((line) => {
		const cells = line.trim().split(/\s+/);
		// Inline images replace the two object-ID columns with one [inline] column.
		const inline = cells[10] === "[inline]";
		const x = Number(cells[inline ? 11 : 12]), y = Number(cells[inline ? 12 : 13]);
		const page = Number(cells[0]), width = Number(cells[3]), height = Number(cells[4]);
		if (cells.length !== (inline ? 15 : 16) || ![page, width, height, x, y].every(Number.isFinite) || page < 1) throw new Error(`Unrecognized image row: ${line}`);
		return { page, number: Number(cells[1]), type: cells[2]!, width, height, color: cells[5]!, object: inline ? "inline" : `${cells[10]} ${cells[11]}`, xPpi: x, yPpi: y, raw: line };
	});
}
export function parseText(raw: string) {
	const lines = raw.trimEnd().split(/\r?\n/);
	if (lines.shift() !== "level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext") throw new Error("Unrecognized Poppler TSV header");
	for (const line of lines) {
		// Poppler can emit an extra newline after word text; empty records carry no facts.
		if (line === "") continue;
		const cells = line.split("\t");
		if (cells.length < 12 || ![1, 3, 4, 5].includes(Number(cells[0])) || !cells.slice(0, 11).every((cell) => cell.trim() !== "" && Number.isFinite(Number(cell)))) throw new Error("Invalid Poppler TSV row");
	}
	return lines.filter((line) => line.startsWith("5\t")).map((line) => {
		const c = line.split("\t"), values = [c[1], c[6], c[7], c[8], c[9]].map(Number);
		if (c.length < 12 || !values.every(Number.isFinite)) throw new Error("Invalid text rectangle");
		return { page: values[0]!, rect: values.slice(1), text: c.slice(11).join("\t") };
	});
}

/** The caller owns this existing snapshot and may reuse it for validation or rendering after extraction. */
export async function extractPdfFacts(snapshot: string, execute: PopplerExecution = run) {
	const bytes = await readFile(snapshot);
	const result = {
		document: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length },
		machineStatus: "complete" as "complete" | "incomplete", evidence: [] as PdfToolEvidence[],
		facts: { metadata: {} as Record<string, string>, pages: [] as Page[], fonts: [] as ReturnType<typeof parseFonts>, images: [] as ReturnType<typeof parseImages>, words: [] as ReturnType<typeof parseText>,
			coordinates: { boxes: "PDF default user space, bottom-left origin; UserUnit not extracted", text: "Poppler TSV page presentation, top-left origin, points; not normalized to unrotated CropBox" } },
		evaluations: [] as ExtractionEvaluation[], needsReview: [] as Warning[],
	};
	const evaluate = (rule: string, outcome: ExtractionEvaluation["outcome"], reason: string) => result.evaluations.push({ rule, outcome, reason });
	const tools = ["pdfinfo", "pdffonts", "pdfimages", "pdftotext"];
	result.evidence.push(...await Promise.all(tools.map((tool) => execute(tool, ["-v"]))));
	const extract = async <T>(rule: string, tool: string, args: string[], parse: (raw: string) => T): Promise<T | undefined> => {
		const evidence = await execute(tool, [...args, snapshot, ...(tool === "pdftotext" ? ["-"] : [])]);
		result.evidence.push(evidence);
		try {
			if (evidence.exitCode !== 0) throw new Error(evidence.error ?? evidence.stderr);
			const facts = parse(evidence.stdout);
			evaluate(rule, "passed", "Extraction completed; this is not a quality or conformance verdict.");
			// Assessment assigns report occurrence IDs, as it does for print and PDF/UA issues.
			if (evidence.stderr.trim()) result.needsReview.push({ rule, message: "Poppler reported warnings while reading the PDF. See the evidence.", remedy: "Review the diagnostic and regenerate from source if needed.", evidence: evidence.stderr });
			return facts;
		} catch (error) {
			result.machineStatus = "incomplete";
			evaluate(rule, "untested", error instanceof Error ? error.message : String(error));
			return undefined;
		}
	};
	if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
		result.machineStatus = "incomplete";
		evaluate("pdf.open", "untested", "Input has no PDF header in its first 1024 bytes.");
	} else {
		const count = await extract("pdf.open", "pdfinfo", [], (raw) => {
			for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([^:]+):\s*(.*)$/); if (m) result.facts.metadata[m[1]!] = m[2]!; }
			const count = Number(result.facts.metadata.Pages);
			if (!Number.isInteger(count) || count < 1) throw new Error("Missing or invalid page count");
			if (result.facts.metadata.Encrypted?.startsWith("yes")) throw new Error("Encrypted PDFs are not supported in this slice.");
			return count;
		});
		if (count !== undefined) {
			result.facts.pages = await extract("page.facts", "pdfinfo", ["-box", "-f", "1", "-l", String(count)], (raw) => parsePages(raw, count)) ?? [];
			result.facts.fonts = await extract("font.facts", "pdffonts", [], parseFonts) ?? [];
			result.facts.images = await extract("image.facts", "pdfimages", ["-list"], parseImages) ?? [];
			result.facts.words = await extract("text.facts", "pdftotext", ["-tsv"], parseText) ?? [];
		}
	}
	for (const rule of ["page.facts", "font.facts", "image.facts", "text.facts"]) {
		if (!result.evaluations.some((e) => e.rule === rule)) evaluate(rule, "untested", "PDF could not be opened; extraction did not run.");
	}
	return result;
}
