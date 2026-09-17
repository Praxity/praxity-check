import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pdfFeedback, type Feedback } from "./feedback.ts";
import { evaluatePdfPrint } from "./pdf-print.ts";
import { checkPdfAccessibility } from "./pdf-accessibility.ts";

import { normalizePdfPolicy, parseChecks, parseTier, selectChecks, type PdfOptions } from "./selection.ts";

const exec = promisify(execFile);
type Outcome = "passed" | "failed" | "cantTell" | "inapplicable" | "untested";
type Evidence = { tool: string; args: string[]; exitCode: number | null; stdout: string; stderr: string; error?: string };
type Issue = { id: string; rule: string; severity: "serious" | "moderate"; confidence: "high" | "medium"; location: { documentSha256: string; page?: number }; message: string; remedy: string; evidence: unknown };
type Page = { page: number; width: number; height: number; rotation: number; boxes: Record<string, number[]> };
export type { PdfOptions } from "./selection.ts";

async function run(tool: string, args: string[]): Promise<Evidence> {
	try {
		const { stdout, stderr } = await exec(tool, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
		return { tool, args, exitCode: 0, stdout, stderr };
	} catch (error) {
		const e = error as Error & { code?: number | string; stdout?: string; stderr?: string };
		return { tool, args, exitCode: typeof e.code === "number" ? e.code : null, stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: e.message };
	}
}

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

/** Check a read-only private snapshot. The report retains all subprocess evidence before cleanup. */
export async function checkPdf(path: string, options: PdfOptions = {}) {
	const policy = normalizePdfPolicy(options);
	const selection = selectChecks(policy);
	const design = selection.tier === "deterministic" && selection.checks.includes("design");
	const accessibility = selection.tier === "deterministic" && selection.checks.includes("accessibility");
	const bytes = await readFile(path);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const report = {
		get feedback(): Feedback { return pdfFeedback(report); },
		schemaVersion: "pdf-1" as const, run: { id: randomUUID(), startedAt: new Date().toISOString(), runtime: process.version },
		document: { kind: "pdf" as const, path: resolve(path), sha256, bytes: bytes.length }, policy, selection,
		machineStatus: "complete" as "complete" | "incomplete", evidence: [] as Evidence[],
		pdfuaValidation: undefined as Awaited<ReturnType<typeof checkPdfAccessibility>>["validator"] | undefined,
		facts: { metadata: {} as Record<string, string>, pages: [] as Page[], fonts: [] as ReturnType<typeof parseFonts>, images: [] as ReturnType<typeof parseImages>, words: [] as ReturnType<typeof parseText>,
			coordinates: { boxes: "PDF default user space, bottom-left origin; UserUnit not extracted", text: "Poppler TSV page presentation, top-left origin, points; not normalized to unrotated CropBox" } },
		evaluations: [] as { rule: string; outcome: Outcome; reason: string }[], findings: [] as Issue[], needsReview: [] as Issue[],
	};
	const evaluate = (rule: string, outcome: Outcome, reason: string) => report.evaluations.push({ rule, outcome, reason });
	const issue = (rule: string, message: string, remedy: string, evidence: unknown, page?: number, review = false) => {
		const list = review ? report.needsReview : report.findings;
		list.push({ id: createHash("sha256").update(JSON.stringify([sha256, rule, page, evidence])).digest("hex"), rule, severity: review ? "moderate" : "serious", confidence: review ? "medium" : "high", location: { documentSha256: sha256, ...(page ? { page } : {}) }, message, remedy, evidence });
	};
	const dir = await mkdtemp(join(tmpdir(), "praxity-pdf-"));
	const snapshot = join(dir, "input.pdf");
	try {
		await writeFile(snapshot, bytes, { mode: 0o400 });
		await chmod(snapshot, 0o400);
		const tools = ["pdfinfo", "pdffonts", "pdfimages", "pdftotext"];
		report.evidence.push(...await Promise.all(tools.map((tool) => run(tool, ["-v"]))));
		const extract = async <T>(rule: string, tool: string, args: string[], parse: (raw: string) => T): Promise<T | undefined> => {
			const evidence = await run(tool, [...args, snapshot, ...(tool === "pdftotext" ? ["-"] : [])]);
			report.evidence.push(evidence);
			try {
				if (evidence.exitCode !== 0) throw new Error(evidence.error ?? evidence.stderr);
				const facts = parse(evidence.stdout);
				evaluate(rule, "passed", "Extraction completed; this is not a quality or conformance verdict.");
				if (evidence.stderr.trim()) issue(rule, "Poppler emitted diagnostics; inspect the raw evidence.", "Review the diagnostic and regenerate from source if needed.", evidence.stderr, undefined, true);
				return facts;
			} catch (error) {
				report.machineStatus = "incomplete";
				evaluate(rule, "untested", error instanceof Error ? error.message : String(error));
				return undefined;
			}
		};
		if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
			report.machineStatus = "incomplete";
			evaluate("pdf.open", "untested", "Input has no PDF header in its first 1024 bytes.");
		} else {
			const count = await extract("pdf.open", "pdfinfo", [], (raw) => {
				for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([^:]+):\s*(.*)$/); if (m) report.facts.metadata[m[1]!] = m[2]!; }
				const count = Number(report.facts.metadata.Pages);
				if (!Number.isInteger(count) || count < 1) throw new Error("Missing or invalid page count");
				if (report.facts.metadata.Encrypted?.startsWith("yes")) throw new Error("Encrypted PDFs are not supported in this slice.");
				return count;
			});
			if (count !== undefined) {
				report.facts.pages = await extract("page.facts", "pdfinfo", ["-box", "-f", "1", "-l", String(count)], (raw) => parsePages(raw, count)) ?? [];
				report.facts.fonts = await extract("font.facts", "pdffonts", [], parseFonts) ?? [];
				report.facts.images = await extract("image.facts", "pdfimages", ["-list"], parseImages) ?? [];
				report.facts.words = await extract("text.facts", "pdftotext", ["-tsv"], parseText) ?? [];
			}
		}
		for (const rule of ["page.facts", "font.facts", "image.facts", "text.facts"]) {
			if (!report.evaluations.some((e) => e.rule === rule)) evaluate(rule, "untested", "PDF could not be opened; extraction did not run.");
		}
		const extracted = (rule: string) => report.evaluations.some((e) => e.rule === rule && e.outcome === "passed");
		if (design || accessibility) {
			if (extracted("font.facts")) {
				for (const font of report.facts.fonts.filter((f) => !f.embedded)) issue("font.embedding", `Font ${font.name} is not embedded.`, "Embed this font when exporting, or replace it with an embeddable font in the source.", font);
				evaluate("font.embedding", report.facts.fonts.some((f) => !f.embedded) ? "failed" : report.facts.fonts.length ? "passed" : "inapplicable", "Checks font embedding only; Unicode maps and reading order require separate review.");
			} else evaluate("font.embedding", "untested", "Font inventory unavailable.");
		}
		if (design) {
			if (extracted("image.facts") && policy.minImagePpi !== undefined) {
				const images = report.facts.images.filter((i) => i.type === "image");
				for (const image of images.filter((i) => Math.min(i.xPpi, i.yPpi) < policy.minImagePpi!)) issue("image.resolution", `Image is ${image.xPpi} × ${image.yPpi} PPI, below the requested ${policy.minImagePpi} PPI.`, "Inspect labels and image purpose at intended print size; replace the source image if needed.", image, image.page, true);
				evaluate("image.resolution", !images.length ? "inapplicable" : report.needsReview.some((i) => i.rule === "image.resolution") ? "cantTell" : "passed", "Explicit PPI threshold; masks excluded. PPI does not establish visual quality.");
			} else evaluate("image.resolution", "untested", policy.minImagePpi === undefined ? "No image PPI threshold requested." : "Image inventory unavailable.");
			if (extracted("page.facts") && policy.paperSize) {
				const expected = policy.paperSize === "A4" ? [595.276, 841.89] : [612, 792];
				for (const page of report.facts.pages) {
					const b = page.boxes.MediaBox!;
					const actual = [b[2]! - b[0]!, b[3]! - b[1]!].sort((a, b) => a - b);
					if (actual.some((n, i) => Math.abs(n - expected[i]!) > 1)) issue("page.geometry", `Page MediaBox differs from ${policy.paperSize}.`, "Set the intended paper size in the source and export again.", { actual, expected, tolerancePoints: 1 }, page.page);
				}
				evaluate("page.geometry", report.findings.some((i) => i.rule === "page.geometry") ? "failed" : "passed", "MediaBox dimensions in default user space, either orientation, 1 point tolerance; UserUnit scaling is not validated.");
			} else evaluate("page.geometry", "untested", policy.paperSize ? "Page geometry unavailable." : "No expected paper size requested.");
		}
		if (design || accessibility) {
			const print = evaluatePdfPrint({
				pages: extracted("page.facts") ? report.facts.pages : undefined,
				words: extracted("text.facts") ? report.facts.words : undefined,
				images: extracted("image.facts") ? report.facts.images : undefined,
			}, { maxSparseWords: design ? policy.maxSparseWords : undefined, includeSparse: design });
			report.evaluations.push(...print.evaluations);
			for (const item of print.needsReview) issue(item.rule, item.message, item.remedy, item.evidence, item.location.page, true);
		}
		if (accessibility && policy.pdfua !== "off") {
			const validation = await checkPdfAccessibility(snapshot, { profile: policy.pdfua === "ua2" ? "ua2" : "ua1", executable: policy.veraPdfPath });
			report.pdfuaValidation = validation.validator;
			report.evidence.push(...validation.evidence);
			report.evaluations.push(...validation.evaluations);
			if (validation.machineStatus === "incomplete") report.machineStatus = "incomplete";
			for (const finding of validation.findings) issue(finding.rule, finding.message, finding.remedy, finding.evidence, finding.location.page);
			for (const finding of validation.needsReview) issue(finding.rule, finding.message, finding.remedy, finding.evidence, finding.location.page, true);
		} else if (accessibility) evaluate("pdfua.machine", "untested", "PDF/UA machine validation was explicitly disabled.");
		for (const rule of [...(selection.checks.includes("accessibility") ? ["pdfua.conformance", "assistive.technology"] : []), ...(selection.checks.includes("design") ? ["visual.review", "physical.print"] : [])]) evaluate(rule, "untested", "Human review was not performed. Machine profile validation alone does not establish this result.");
		if (selection.tier === "inference") evaluate("deterministic.checks", "untested", "Only supporting facts were extracted; deterministic quality and conformance checks were not selected.");
		return report;
	} finally { await rm(dir, { recursive: true, force: true }); }
}

/** Human summary of the same findings retained in JSON. Repeated occurrences share one explanation. */
export function pdfHumanSummary(report: Pick<Awaited<ReturnType<typeof checkPdf>>, "document" | "machineStatus" | "findings" | "needsReview" | "evaluations"> & { selection?: ReturnType<typeof selectChecks> }, jsonPath?: string): string {
	const lines = [
		`PDF: ${report.document.path}`,
		report.selection?.tier === "inference" ? (report.machineStatus === "complete" ? "Supporting evidence extracted; deterministic checks were not selected." : "Some supporting evidence could not be extracted; deterministic checks were not selected.") : report.machineStatus === "complete" ? "Automated checks completed." : "Some automated checks could not complete. See the unchecked items below.",
		`${report.findings.length} ${report.findings.length === 1 ? "finding" : "findings"} to fix; ${report.needsReview.length} ${report.needsReview.length === 1 ? "item" : "items"} to review.`,
	];
	for (const [label, issues] of [["Fix", report.findings], ["Review", report.needsReview]] as const) {
		const groups = new Map<string, Issue[]>();
		for (const item of issues) {
			const key = JSON.stringify([item.rule, item.message, item.remedy]);
			const group = groups.get(key) ?? [];
			group.push(item);
			groups.set(key, group);
		}
		for (const group of groups.values()) {
			const item = group[0]!;
			const where = item.location.page ? `page ${item.location.page}` : "document level";
			lines.push("", `${label}: ${item.message}`, `  ${group.length > 1 ? "First location" : "Location"}: ${where}${group.length > 1 ? `. ${group.length} occurrences.` : "."}`, `  Next step: ${item.remedy}`, `  Rule: ${item.rule}`);
		}
	}
	const unchecked = report.evaluations.filter((e) => e.outcome === "untested");
	if (unchecked.length) {
		lines.push("", "Not checked:");
		const reasons = new Map<string, string[]>();
		for (const item of unchecked) {
			const rules = reasons.get(item.reason) ?? [];
			rules.push(item.rule);
			reasons.set(item.reason, rules);
		}
		for (const [reason, rules] of reasons) lines.push(`  ${rules.join(", ")}: ${reason}`);
	}
	if (report.findings.length || report.needsReview.length) lines.push("", "After changing the source, regenerate the PDF and rerun Check. Review remaining questions against that new PDF.");
	lines.push(`PDF SHA-256: ${report.document.sha256}`);
	if (jsonPath) lines.push(`Full findings, locations and evidence: ${jsonPath}`);
	return lines.join("\n");
}

export async function pdfCli(args: string[]): Promise<number> {
	const options: PdfOptions = {};
	let json: string | undefined;
	let reviewBundle: string | undefined;
	const reviewPaths: string[] = [];
	for (let i = 2; i < args.length; i++) {
		const arg = args[i], value = args[i + 1];
		if (arg === "--checks" && value) { options.checks = parseChecks(value).join(","); i++; }
		else if (arg === "--tier" && value) { options.tier = parseTier(value); i++; }
		else if (arg === "--json" && value && !value.startsWith("--")) { json = resolve(value); i++; }
		else if (arg === "--review-bundle" && value && !value.startsWith("--")) { if (reviewBundle) throw new Error("Use one --review-bundle per check invocation"); reviewBundle = resolve(value); i++; }
		else if (arg === "--review" && value && !value.startsWith("--")) { reviewPaths.push(resolve(value)); i++; }
		else if (arg === "--max-sparse-words" && value && Number.isSafeInteger(Number(value)) && Number(value) > 0) { options.maxSparseWords = Number(value); i++; }
		else if (arg === "--min-image-ppi" && value && Number.isFinite(Number(value)) && Number(value) > 0) { options.minImagePpi = Number(value); i++; }
		else if (arg === "--paper-size" && (value === "A4" || value === "Letter")) { options.paperSize = value; i++; }
		else if (arg === "--pdfua" && (value === "ua1" || value === "ua2" || value === "off")) { options.pdfua = value; i++; }
		else if (arg === "--verapdf" && value && !value.startsWith("--")) { options.veraPdfPath = value; i++; }
		else if (arg === "--min-confidence" && /^(high|medium|low)$/.test(value ?? "")) { i++; }
		else throw new Error(`Unsupported or incomplete PDF option: ${arg}. PDF options: --max-sparse-words, --review, --review-bundle, --json, --min-image-ppi, --paper-size, --pdfua, --verapdf, --min-confidence.`);
	}
	if (reviewBundle && !reviewPaths.length) throw new Error("--review-bundle requires --review");
	if (options.tier === "inference" && !reviewPaths.length) throw new Error("--tier inference requires --review; prepare a review first with prepare-review --tier inference.");
	if (options.tier === "deterministic" && reviewPaths.length) throw new Error("--review requires --tier inference, or omit --tier to retain the legacy combined report.");
	const target = resolve(args[1]!);
	// Compare inode identity as well as paths, protecting symlink and hardlink aliases.
	if (json) {
		const source = await stat(target);
		const output = await stat(json).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
		if (json === target || (output && output.dev === source.dev && output.ino === source.ino)) throw new Error("JSON output must not overwrite the input PDF.");
		for (const reviewPath of reviewPaths) {
			const review = await stat(reviewPath);
			if (json === reviewPath || (output && output.dev === review.dev && output.ino === review.ino)) throw new Error("JSON output must not overwrite an imported review.");
		}
	}
	const report = { ...await checkPdf(target, options), inferenceReviews: [] as ReturnType<typeof import("./pdf-review.ts").normalizePdfReview>[] };
	const { validatePdfReview, normalizePdfReview, validateReviewSelection, validatePdfReviewBundle, validatePdfReviewBundleSelection } = await import("./pdf-review.ts");
	const bundle = reviewBundle ? await validatePdfReviewBundle(reviewBundle, report.document.sha256, report.facts.pages.length) : undefined;
	if (json && bundle) {
		const output = await stat(json).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; });
		for (const path of bundle.paths) {
			const evidence = await stat(path);
			if (json === path || output && output.dev === evidence.dev && output.ino === evidence.ino) throw new Error("JSON output must not overwrite review bundle evidence.");
		}
	}
	for (const reviewPath of reviewPaths) {
		if ((await stat(reviewPath)).size > 4 * 1024 * 1024) throw new Error("PDF review exceeds 4 MiB");
		const review = validatePdfReview(JSON.parse(await readFile(reviewPath, "utf8")), report.document.sha256, report.facts.pages.length);
		if (review.schemaVersion === "pdf-review-4" && !bundle) throw new Error("PDF review v4 requires --review-bundle manifest.json");
		if (bundle) validatePdfReviewBundleSelection(review, bundle);
		validateReviewSelection(review, options.checks ?? (options.tier !== undefined ? report.selection.checks.join(",") : undefined));
		report.inferenceReviews.push(normalizePdfReview(review));
	}
	report.feedback = pdfFeedback(report);
	if (json) {
		const staging = await mkdtemp(join(dirname(json), ".praxity-report-"));
		try {
			const pending = join(staging, "report.json");
			await writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
			// Replacing the directory entry never writes through a symlink or hardlink.
			await rename(pending, json);
		} finally { await rm(staging, { recursive: true, force: true }); }
	}
	console.log(pdfHumanSummary(report, json));
	for (const review of report.inferenceReviews) {
		console.log(`\nInferred ${"focus" in review ? review.focus : review.tier} review by ${review.reviewer.model}: ${review.findings.length} concerns. Pages reviewed: ${review.pagesReviewed.join(", ")} of ${report.facts.pages.length}. ${review.pagesReviewed.length < report.facts.pages.length ? "Other pages were not reviewed in this batch. " : ""}This is not a conformance result.`);
		console.log(review.evidenceBinding === "bundle" ? "Bundle hashes verified. They do not prove that the reviewer inspected the images." : "Legacy import: bound to PDF bytes only; prepared evidence and context are not bound to this review.");
		for (const item of review.findings) console.log(`Page ${item.location.page} [${item.category}]: ${item.message}\n  Consequence: ${item.consequence}\n  Next step: ${item.remedy}\n  Origin: ${item.provenance.method}, ${item.provenance.tier}, ${item.provenance.model}\n  Verify: ${item.verification}\n  Evidence: ${item.evidence.observation}\n  Confidence: ${item.confidence}`);
	}
	return report.machineStatus === "incomplete" ? 2 : report.findings.length ? 1 : 0;
}
