import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { extractPdfFacts } from "./pdf-facts.ts";
import { pdfFeedback, type Feedback } from "./feedback.ts";
import { evaluatePdfPrint } from "./pdf-print.ts";
import { checkPdfAccessibility } from "./pdf-accessibility.ts";

import { normalizePdfPolicy, parseChecks, parseTier, selectChecks, type PdfOptions } from "./selection.ts";

type Outcome = "passed" | "failed" | "cantTell" | "inapplicable" | "untested";
type Issue = { id: string; rule: string; severity: "serious" | "moderate"; confidence: "high" | "medium"; location: { documentSha256: string; page?: number }; message: string; remedy: string; evidence: unknown };
export type { PdfOptions } from "./selection.ts";
export { parsePages, parseFonts, parseImages, parseText } from "./pdf-facts.ts";

/** Check a read-only private snapshot. The report retains all subprocess evidence before cleanup. */
export async function checkPdf(path: string, options: PdfOptions = {}) {
	const policy = normalizePdfPolicy(options);
	const selection = selectChecks(policy);
	const design = selection.tier === "deterministic" && selection.checks.includes("design");
	const accessibility = selection.tier === "deterministic" && selection.checks.includes("accessibility");
	const bytes = await readFile(path);
	const run = { id: randomUUID(), startedAt: new Date().toISOString(), runtime: process.version };
	const dir = await mkdtemp(join(tmpdir(), "praxity-pdf-"));
	const snapshot = join(dir, "input.pdf");
	try {
		await writeFile(snapshot, bytes, { mode: 0o400 });
		await chmod(snapshot, 0o400);
		const extraction = await extractPdfFacts(snapshot);
		const sha256 = extraction.document.sha256;
		const report = {
			get feedback(): Feedback { return pdfFeedback(report); },
			schemaVersion: "pdf-1" as const, run,
			document: { kind: "pdf" as const, path: resolve(path), sha256, bytes: extraction.document.bytes }, policy, selection,
			machineStatus: extraction.machineStatus, evidence: extraction.evidence,
			pdfuaValidation: undefined as Awaited<ReturnType<typeof checkPdfAccessibility>>["validator"] | undefined,
			facts: extraction.facts,
			evaluations: [...extraction.evaluations] as { rule: string; outcome: Outcome; reason: string }[], findings: [] as Issue[], needsReview: [] as Issue[],
		};
		const evaluate = (rule: string, outcome: Outcome, reason: string) => report.evaluations.push({ rule, outcome, reason });
		const issue = (rule: string, message: string, remedy: string, evidence: unknown, page?: number, review = false) => {
			const list = review ? report.needsReview : report.findings;
			list.push({ id: createHash("sha256").update(JSON.stringify([sha256, rule, page, evidence])).digest("hex"), rule, severity: review ? "moderate" : "serious", confidence: review ? "medium" : "high", location: { documentSha256: sha256, ...(page ? { page } : {}) }, message, remedy, evidence });
		};
		for (const warning of extraction.needsReview) issue(warning.rule, warning.message, warning.remedy, warning.evidence, undefined, true);
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
			} else evaluate("image.resolution", "untested", policy.minImagePpi === undefined ? "Add --min-image-ppi to check this." : "Could not list the images.");
			if (extracted("page.facts") && policy.paperSize) {
				const expected = policy.paperSize === "A4" ? [595.276, 841.89] : [612, 792];
				for (const page of report.facts.pages) {
					const b = page.boxes.MediaBox!;
					const actual = [b[2]! - b[0]!, b[3]! - b[1]!].sort((a, b) => a - b);
					if (actual.some((n, i) => Math.abs(n - expected[i]!) > 1)) issue("page.geometry", `Page MediaBox differs from ${policy.paperSize}.`, "Set the intended paper size in the source and export again.", { actual, expected, tolerancePoints: 1 }, page.page);
				}
				evaluate("page.geometry", report.findings.some((i) => i.rule === "page.geometry") ? "failed" : "passed", "MediaBox dimensions in default user space, either orientation, 1 point tolerance; UserUnit scaling is not validated.");
			} else evaluate("page.geometry", "untested", policy.paperSize ? "Could not read the page sizes." : "Add --paper-size to check this.");
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
		for (const rule of [...(selection.checks.includes("accessibility") ? ["pdfua.conformance", "assistive.technology"] : []), ...(selection.checks.includes("design") ? ["visual.review", "physical.print"] : [])]) evaluate(rule, "untested", "Needs a person to review. Machine validation alone cannot confirm this.");
		if (selection.tier === "inference") evaluate("deterministic.checks", "untested", "Automated checks did not run because --tier inference was selected.");
		return report;
	} finally { await rm(dir, { recursive: true, force: true }); }
}

/** Human summary of the same findings retained in JSON. Repeated occurrences share one explanation. */
export function pdfHumanSummary(report: Pick<Awaited<ReturnType<typeof checkPdf>>, "document" | "machineStatus" | "findings" | "needsReview" | "evaluations"> & { selection?: ReturnType<typeof selectChecks> }, jsonPath?: string): string {
	const lines = [
		`PDF: ${report.document.path}`,
		report.selection?.tier === "inference" ? `${report.machineStatus === "complete" ? "Extracted the facts for the model review." : "Could not extract some facts for the model review."} Automated checks did not run because --tier inference was selected.` : report.machineStatus === "complete" ? "Automated checks completed." : "Some automated checks could not finish. See \"Not checked\" below.",
		`${report.findings.length} ${report.findings.length === 1 ? "issue" : "issues"} found.${report.needsReview.length ? ` ${report.needsReview.length} possible ${report.needsReview.length === 1 ? "issue" : "issues"} to review.` : ""}`,
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
			const where = item.location.page ? `page ${item.location.page}` : "whole document";
			lines.push("", `${label}: ${item.message}`, `  ${group.length > 1 ? `Found ${group.length} times. First location` : "Location"}: ${where}`, `  Next step: ${item.remedy}`, `  Rule: ${item.rule}`);
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
	if (report.findings.length || report.needsReview.length) lines.push("", "After you fix the source, export the PDF again and rerun Check. Review any remaining possible issues in the new PDF.");
	lines.push(`PDF SHA-256: ${report.document.sha256}`);
	if (jsonPath) lines.push(`Details and evidence: ${jsonPath}`);
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
	const report = { ...await checkPdf(target, options), inferenceReviews: [] as import("./pdf-review.ts").AcceptedPdfReview["normalized"][] };
	const { acceptPdfReview, validatePdfReviewBundle } = await import("./pdf-review.ts");
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
		const accepted = await acceptPdfReview(JSON.parse(await readFile(reviewPath, "utf8")), report.document.sha256, report.facts.pages.length, {
			bundle, checks: options.checks ?? (options.tier !== undefined ? report.selection.checks.join(",") : undefined),
		});
		report.inferenceReviews.push(accepted.normalized);
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
		console.log(`\nModel review (${"focus" in review ? review.focus : review.tier}, ${review.reviewer.model}): ${review.findings.length} ${review.findings.length === 1 ? "concern" : "concerns"} on ${review.pagesReviewed.length === 1 ? "page" : "pages"} ${review.pagesReviewed.join(", ")} of ${report.facts.pages.length}. ${review.pagesReviewed.length < report.facts.pages.length ? "The model did not review the other pages. " : ""}A model review cannot confirm conformance.`);
		console.log(review.evidenceBinding === "bundle" ? "The review matches its evidence bundle. That does not prove the model looked at the images." : "Older review format: it matches this PDF, but Check cannot confirm which evidence and context the model saw.");
		for (const item of review.findings) console.log(`${item.category === "observed-defect" ? "Issue" : item.category === "needs-context" ? "Question" : item.category === "suggestion" ? "Suggestion" : "Concern"} on page ${item.location.page}: ${item.message}\n  Consequence: ${item.consequence}\n  Next step: ${item.remedy}\n  Origin: ${item.provenance.method}, ${item.provenance.tier}, ${item.provenance.model}\n  Verify: ${item.verification}\n  Evidence: ${item.evidence.observation}\n  Confidence: ${item.confidence}`);
	}
	return report.machineStatus === "incomplete" ? 2 : report.findings.length ? 1 : 0;
}
