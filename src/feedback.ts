import type { AuditReport } from "./report.ts";
import type { checkPdf } from "./pdf.ts";
import type { normalizePdfReview } from "./pdf-review.ts";
import type { CheckDomain, CheckTier } from "./selection.ts";

export type FeedbackLocation =
	| { format: "html"; contentSha256?: string; page: string; state?: string; selector?: string }
	| { format: "pdf"; documentSha256: string; page?: number };
type Method = CheckTier | "human";

export interface FeedbackItem {
	id: string;
	rule: string;
	domains: CheckDomain[];
	method: Method;
	message: string;
	location: FeedbackLocation;
	source: string;
	evidence: string;
	provenance: string[];
	action?: string;
	confidence?: "high" | "medium" | "low";
	basis?: string;
	category?: "observed-defect" | "needs-context" | "suggestion";
	consequence?: string;
	verification?: string;
}

export interface FeedbackCoverage {
	rule: string;
	domains: CheckDomain[];
	method: Method;
	purpose: "check" | "extraction" | "review";
	outcome?: "passed" | "failed" | "cantTell" | "inapplicable" | "untested";
	status?: "complete" | "partial";
	location?: FeedbackLocation;
	pagesReviewed?: number[];
	pageCount?: number;
	reason?: string;
	source: string;
}

/** References are JSON Pointers relative to the containing format-specific report. */
export interface Feedback {
	schemaVersion: "feedback-1";
	findings: FeedbackItem[];
	questions: FeedbackItem[];
	suggestions: FeedbackItem[];
	coverage: FeedbackCoverage[];
	limitations: string[];
}

export function htmlFeedback(report: AuditReport): Feedback {
	const item = (entry: AuditReport["findings"][number] | AuditReport["needsReview"][number], source: string): FeedbackItem => ({
		id: entry.occurrenceId, rule: entry.rule, domains: ["accessibility"], method: "deterministic",
		message: entry.what, location: { format: "html", page: entry.page, state: entry.state, ...(entry.selector ? { selector: entry.selector } : {}) },
		source, evidence: `${source}/evidence`, provenance: ["/toolVersion", "/environment", "/rulesets", "/rules"], basis: entry.basis,
		...("fix" in entry ? { action: entry.fix, confidence: entry.confidence } : {}),
	});
	const feedback: Feedback = {
		schemaVersion: "feedback-1",
		findings: report.findings.map((entry, i) => item(entry, `/findings/${i}`)),
		questions: report.needsReview.map((entry, i) => item(entry, `/needsReview/${i}`)), suggestions: [],
		coverage: report.selection?.tier === "inference" ? [{ rule: "html.deterministic", domains: ["accessibility"], method: "deterministic", purpose: "check", outcome: "untested", source: "/selection", reason: "Deterministic checks were not selected." }] : [
			...report.evaluations.map((entry, i): FeedbackCoverage => ({
				rule: entry.type === "rule" ? entry.rule : entry.check, domains: ["accessibility"], method: "deterministic", purpose: "check",
				outcome: entry.outcome, location: { format: "html", page: entry.page, state: entry.state }, source: `/evaluations/${i}`,
				...("reason" in entry ? { reason: entry.reason } : {}),
			})),
			...report.pages.flatMap((page, i): FeedbackCoverage[] => page.audited ? [] : [{
				rule: "page.audit", domains: ["accessibility"], method: "deterministic", purpose: "check", outcome: "untested",
				location: { format: "html", page: page.file }, reason: page.triage.reason ?? "Page was not audited.", source: `/pages/${i}`,
			}]),
			...report.redirectStubs.map((stub, i): FeedbackCoverage => ({
				rule: "page.audit", domains: ["accessibility"], method: "deterministic", purpose: "check", outcome: "untested",
				location: { format: "html", page: stub.file }, source: `/redirectStubs/${i}`,
				reason: `Redirect-only page excluded from auditing. Target: ${stub.target}. ${stub.resolved ? "Target exists in the package." : "Target is absent from the package."}`,
			})),
		],
		limitations: [...(report.contentSha256 ? [] : ["HTML reports have no content revision hash. Occurrence IDs identify rule, page, selector and state, not the checked revision."]),
			"HTML and SCORM design assessment is not supported.",
			...(report.network.blockedRequestCount ? ["Network requests were blocked. See /network/blockedRequests. Content requiring those requests may be unavailable."] : []), ...report.notes],
	};

	for (const [i, review] of (report.inferenceReviews ?? []).entries()) {
		const source = `/inferenceReviews/${i}`;
		const candidates = review.retainedEvidence.candidates;
		feedback.coverage.push({
			rule: "html.interaction.inference", domains: ["accessibility"], method: "inference", purpose: "review",
			status: review.pagesReviewed.length === review.retainedEvidence.pages.length && review.candidatesReviewed.length === candidates.length && !review.retainedEvidence.omitted && !review.retainedEvidence.perSurfaceCaps.length ? "complete" : "partial",
			source, reason: `${review.candidatesReviewed.length} of ${candidates.length} retained primary candidates reviewed on ${review.pagesReviewed.length} pages. Coverage describes retained evidence, not whole-page accessibility or duplicate occurrences.`,
		});
		for (const [j, entry] of review.findings.entries()) {
			const entrySource = `${source}/findings/${j}`;
			const item: FeedbackItem = {
				id: entry.id, rule: entry.rule, domains: [entry.check], method: "inference", category: entry.category,
				message: entry.message, action: entry.action, confidence: entry.confidence, consequence: entry.consequence, verification: entry.verification,
				location: { format: "html", contentSha256: review.contentSha256, ...entry.location },
				source: entrySource, evidence: `${entrySource}/evidence`, provenance: [`${entrySource}/provenance`, `${source}/retainedEvidence`],
			};
			(entry.category === "observed-defect" ? feedback.findings : entry.category === "suggestion" ? feedback.suggestions : feedback.questions).push(item);
		}
		feedback.limitations.push(`${source} describes retained DOM and action evidence from a previous browser session. Matching local content does not verify current runtime state, network responses, screen-reader speech or unexecuted flows.`);
	}
	return feedback;
}

type PdfSource = Omit<Awaited<ReturnType<typeof checkPdf>>, "feedback"> & { inferenceReviews?: ReturnType<typeof normalizePdfReview>[] };
const HUMAN_RULES = new Set(["pdfua.conformance", "assistive.technology", "visual.review", "physical.print"]);
function pdfDomains(rule: string, selected: CheckDomain[]): CheckDomain[] {
	if (rule.startsWith("pdfua") || rule === "assistive.technology") return ["accessibility"];
	if (["image.resolution", "page.geometry", "page.sparse-content", "visual.review", "physical.print"].includes(rule)) return ["design"];
	return selected;
}

export function pdfFeedback(report: PdfSource): Feedback {
	const location = { format: "pdf" as const, documentSha256: report.document.sha256 };
	const item = (entry: PdfSource["findings"][number], source: string): FeedbackItem => ({
		id: entry.id, rule: entry.rule, domains: pdfDomains(entry.rule, report.selection.checks), method: "deterministic",
		message: entry.message, action: entry.remedy, confidence: entry.confidence, location: { format: "pdf", ...entry.location },
		source, evidence: `${source}/evidence`, provenance: ["/run", "/policy", "/evidence"],
	});
	const feedback: Feedback = {
		schemaVersion: "feedback-1", findings: report.findings.map((entry, i) => item(entry, `/findings/${i}`)),
		questions: report.needsReview.map((entry, i) => item(entry, `/needsReview/${i}`)), suggestions: [],
		coverage: report.evaluations.map((entry, i) => ({
			...entry, domains: pdfDomains(entry.rule, report.selection.checks), method: HUMAN_RULES.has(entry.rule) ? "human" : "deterministic",
			purpose: entry.rule === "pdf.open" || entry.rule.endsWith(".facts") ? "extraction" : HUMAN_RULES.has(entry.rule) ? "review" : "check",
			location, source: `/evaluations/${i}`,
		})),
		limitations: ["Extraction outcomes describe available facts. Machine checks and model reviews do not establish whole-document accessibility, design quality or PDF/UA conformance."],
	};
	if (report.pdfuaValidation?.coverage) feedback.coverage.push({
		rule: "pdfua.machine.evidence", domains: ["accessibility"], method: "deterministic", purpose: "check",
		status: report.pdfuaValidation.coverage.status, location, source: "/pdfuaValidation/coverage",
		reason: `${report.pdfuaValidation.coverage.retainedChecks} failed checks retained; ${report.pdfuaValidation.coverage.omittedChecks} omitted. This status describes retained evidence only.`,
	});
	for (const [i, review] of (report.inferenceReviews ?? []).entries()) {
		const source = `/inferenceReviews/${i}`;
		const domains = "checks" in review ? review.checks : [];
		feedback.limitations.push(review.evidenceBinding === "bundle" ? `${source} is bound to retained bundle hashes. Hashes do not prove image inspection or model claims.` : `${source} is a legacy document-only import; prepared evidence and context are not bound to this review.`);
		if (!("checks" in review)) feedback.limitations.push(`${source} is a legacy review without declared domains. Its domains are left empty.`);
		feedback.coverage.push({
			rule: `pdf.${"focus" in review ? review.focus : review.tier}.inference`, domains, method: "inference", purpose: "review",
			status: review.pagesReviewed.length === report.facts.pages.length ? "complete" : "partial", pagesReviewed: review.pagesReviewed,
			pageCount: report.facts.pages.length, location, source,
			reason: "Coverage records pages reviewed for this focus, not a quality or conformance outcome.",
		});
		for (const [j, entry] of review.findings.entries()) {
			const entrySource = `${source}/findings/${j}`;
			const projected: FeedbackItem = {
				id: entry.id, rule: entry.rule, domains: entry.check ? [entry.check] : domains, method: "inference", category: entry.category,
				message: entry.message, action: entry.remedy, confidence: entry.confidence, consequence: entry.consequence, verification: entry.verification,
				location: { format: "pdf", ...entry.location }, source: entrySource, evidence: `${entrySource}/evidence`, provenance: [`${entrySource}/provenance`],
			};
			(entry.category === "observed-defect" ? feedback.findings : entry.category === "suggestion" ? feedback.suggestions : feedback.questions).push(projected);
		}
	}
	return feedback;
}
