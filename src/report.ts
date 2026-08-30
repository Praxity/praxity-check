import { createHash } from "node:crypto";
import packageJson from "../package.json" with { type: "json" };
import type {
	CheckResult,
	Finding,
	ReviewItem,
	RuleEvaluation,
	RuleMetadata,
	Triage,
	UntestedEvaluation,
	WcagLevel,
} from "./checks.ts";
import type { DiscoveredPage, Discovery, RedirectStub } from "./discover.ts";
import type { Scenario } from "./scenarios.ts";

export const TOOL_NAME = "Praxity Check";
export const PROJECT_URL = "https://github.com/Praxity/praxity-check";
export const CREDITS_URL = `${PROJECT_URL}/blob/main/NOTICE.md`;

export interface PageAudit extends CheckResult {
	page: DiscoveredPage;
	triage: Triage;
	audited: boolean;
	title?: string;
}

export interface BlockedRequest {
	url: string;
	method: string;
	resourceType: string;
}

interface PageVerdict extends DiscoveredPage {
	triage: Triage;
	audited: boolean;
}

export interface AuditEnvironment {
	runtime: { name: "node"; version: string };
	browser: { engine: "chromium"; version: string };
	viewport: { width: number; height: number };
	colorScheme: "light";
}

export type Comparison = "new" | "existing";
export type Disposition = "unreviewed" | "accepted" | "falsePositive";
const DISPOSITIONS = new Set<Disposition>(["unreviewed", "accepted", "falsePositive"]);

export interface ReviewDecision {
	reason: string;
	owner: string;
	reviewedAt: string;
}

interface OccurrenceStatus {
	occurrenceId: string;
	state: string;
	comparison?: Comparison;
	disposition: Disposition;
	review?: ReviewDecision;
}

export type ReportedFinding = Finding & OccurrenceStatus;

export type ReportedReviewItem = ReviewItem & OccurrenceStatus;

export interface BaselineOccurrence extends OccurrenceStatus {
	result: "finding" | "needsReview";
	rule: string;
	page: string;
	selector?: string;
}

export interface Baseline {
	toolVersion: string;
	target: { path: string; wasZip: boolean };
	occurrences: BaselineOccurrence[];
}

export type Evaluation = RuleEvaluation | UntestedEvaluation;

export interface AuditReport {
	schemaVersion: 4;
	toolName: typeof TOOL_NAME;
	toolVersion: string;
	projectUrl: typeof PROJECT_URL;
	creditsUrl: typeof CREDITS_URL;
	target: {
		path: string;
		wasZip: boolean;
	};
	environment: AuditEnvironment;
	rulesets: Array<{ source: RuleMetadata["source"]; version: string }>;
	rules: RuleMetadata[];
	evaluations: Evaluation[];
	scenarios: Scenario[];
	pages: PageVerdict[];
	redirectStubs: RedirectStub[];
	findings: ReportedFinding[];
	needsReview: ReportedReviewItem[];
	baseline?: Omit<Baseline, "occurrences">;
	changes?: { resolved: BaselineOccurrence[] };
	notes: string[];
	counts: {
		confidence: Record<Finding["confidence"], number>;
		rule: Record<string, number>;
		needsReview: number;
	};
	network: {
		allowed: boolean;
		blockedRequestCount: number;
		blockedRequests: BlockedRequest[];
	};
}

const CONTENT_QUALITY_RULES = new Set([
	"alt-filename",
	"alt-template-variable",
	"link-text-ambiguous",
	"link-text-uninformative",
	"local-resource-missing",
]);

type OccurrenceIdentity = Pick<Finding | ReviewItem, "rule" | "page" | "selector" | "state">;

const GENERATED_ASSESSMENT_ID = /(#rs-(?:choice|match|cat|hs|matrix)-)[a-z0-9]{6}(?=-|$)/g;

function occurrenceIdForSelector(item: OccurrenceIdentity, selector: string | undefined): string {
	const identity = [item.rule, item.page, selector ?? "", item.state ?? "initial"];
	return `occ_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16)}`;
}

function occurrenceId(item: OccurrenceIdentity): string {
	return occurrenceIdForSelector(item, item.selector?.replace(GENERATED_ASSESSMENT_ID, "$1<generated>"));
}

function reportOccurrence<T extends Finding | ReviewItem>(item: T): T & OccurrenceStatus {
	return {
		...item,
		occurrenceId: occurrenceId(item),
		state: item.state ?? "initial",
		disposition: "unreviewed",
	};
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function reviewDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function parseBaselineOccurrence(value: unknown, result: BaselineOccurrence["result"], index: number): BaselineOccurrence {
	const label = `baseline ${result} ${index + 1}`;
	const item = record(value, label);
	const { occurrenceId: id, rule, page, selector, state } = item;
	if (
		typeof id !== "string" ||
		typeof rule !== "string" ||
		typeof page !== "string" ||
		(selector !== undefined && typeof selector !== "string") ||
		typeof state !== "string"
	) throw new Error(`${label} has invalid occurrence identity`);
	const identity = { rule, page, selector, state };
	const normalizedId = occurrenceId(identity);
	if (id !== normalizedId && id !== occurrenceIdForSelector(identity, selector)) {
		throw new Error(`${label} occurrenceId does not match its rule, page, selector, and state`);
	}

	const disposition = item.disposition ?? "unreviewed";
	if (!DISPOSITIONS.has(disposition as Disposition)) {
		throw new Error(`${label} has an invalid disposition`);
	}
	const rawReview = item.review;
	let review: ReviewDecision | undefined;
	if (disposition === "unreviewed") {
		if (rawReview !== undefined) throw new Error(`${label} cannot have review metadata while unreviewed`);
	} else {
		const decision = record(rawReview, `${label}.review`);
		const { reason, owner, reviewedAt } = decision;
		if (
			typeof reason !== "string" || reason.trim() === "" ||
			typeof owner !== "string" || owner.trim() === "" ||
			typeof reviewedAt !== "string" || !reviewDate(reviewedAt)
		) {
			throw new Error(`${label}.review requires a reason, owner, and YYYY-MM-DD reviewedAt date`);
		}
		review = { reason, owner, reviewedAt };
	}
	return {
		result,
		occurrenceId: normalizedId,
		rule,
		page,
		...(selector === undefined ? {} : { selector }),
		state,
		disposition: disposition as Disposition,
		...(review ? { review } : {}),
	};
}

/** Validate a previous schema-v4 report before it influences current evidence. */
export function parseBaseline(value: unknown): Baseline {
	const report = record(value, "baseline");
	if (report.schemaVersion !== 4 || report.toolName !== TOOL_NAME || typeof report.toolVersion !== "string") {
		throw new Error(`baseline must be a ${TOOL_NAME} schema-v4 report`);
	}
	const target = record(report.target, "baseline.target");
	if (typeof target.path !== "string" || typeof target.wasZip !== "boolean") {
		throw new Error("baseline.target is invalid");
	}
	if (!Array.isArray(report.findings) || !Array.isArray(report.needsReview)) {
		throw new Error("baseline findings and needsReview must be arrays");
	}
	const occurrences = [
		...report.findings.map((item, index) => parseBaselineOccurrence(item, "finding", index)),
		...report.needsReview.map((item, index) => parseBaselineOccurrence(item, "needsReview", index)),
	];
	if (new Set(occurrences.map((item) => item.occurrenceId)).size !== occurrences.length) {
		throw new Error("baseline contains duplicate occurrenceIds");
	}
	return {
		toolVersion: report.toolVersion,
		target: { path: target.path, wasZip: target.wasZip },
		occurrences,
	};
}

function requirementsFromBasis(basis: string): { requirements: RuleMetadata["requirements"]; levels: WcagLevel[] } {
	const requirements = [...new Set([...basis.matchAll(/\b\d\.\d\.\d{1,2}\b/g)].map((match) => match[0]))]
		.map((criterion) => ({ standard: "WCAG" as const, criterion }));
	const levels = [...new Set([...basis.matchAll(/\((A{1,3})\)/g)].flatMap((match) =>
		match[1] ? [match[1] as WcagLevel] : []
	))].sort((a, b) => a.length - b.length);
	return { requirements, levels };
}

function fallbackMetadata(item: Finding | ReviewItem): RuleMetadata {
	const { requirements, levels } = requirementsFromBasis(item.basis);
	const axe = item.rule.startsWith("axe:");
	return {
		id: item.rule,
		source: axe ? "axe-core" : "praxity-check",
		rulesetVersion: axe ? "unknown" : packageJson.version,
		kind: item.basis.includes("best practice")
			? "advisory"
			: CONTENT_QUALITY_RULES.has(item.rule)
				? "contentQuality"
				: "conformance",
		confidence: "confidence" in item ? item.confidence : "variable",
		testMode: "automated",
		requirements,
		levels,
		actRuleIds: [],
		tags: [],
		assumptions: [],
	};
}

const OUTCOME_RANK: Record<RuleEvaluation["outcome"], number> = {
	inapplicable: 1,
	passed: 2,
	cantTell: 3,
	failed: 4,
};

function mergeEvaluations(evaluations: Evaluation[]): Evaluation[] {
	const merged = new Map<string, Evaluation>();
	for (const evaluation of evaluations) {
		const key = evaluation.type === "rule"
			? `rule\0${evaluation.rule}\0${evaluation.page}\0${evaluation.state}`
			: `check\0${evaluation.check}\0${evaluation.page}\0${evaluation.state}`;
		const current = merged.get(key);
		if (
			!current ||
			(evaluation.type === "rule" && current.type === "rule" &&
				OUTCOME_RANK[evaluation.outcome] > OUTCOME_RANK[current.outcome])
		) merged.set(key, evaluation);
	}
	return [...merged.values()].sort((a, b) => {
		const left = a.type === "rule" ? `rule\0${a.rule}\0${a.page}\0${a.state}` : `check\0${a.check}\0${a.page}\0${a.state}`;
		const right = b.type === "rule" ? `rule\0${b.rule}\0${b.page}\0${b.state}` : `check\0${b.check}\0${b.page}\0${b.state}`;
		return left.localeCompare(right);
	});
}

export function createReport(
	targetPath: string,
	wasZip: boolean,
	discovery: Discovery,
	pages: PageAudit[],
	blockedRequests: BlockedRequest[],
	allowNetwork: boolean,
	environment: AuditEnvironment,
	scenarios: Scenario[],
	baseline?: Baseline,
): AuditReport {
	const rawFindings = pages.flatMap((page) => page.findings);
	const rawNeedsReview = pages.flatMap((page) => page.needsReview ?? []);
	const notes = pages.flatMap((page) => page.notes);
	const titles = new Map<string, { title: string; pages: string[] }>();
	for (const page of pages) {
		const title = page.audited ? page.title?.replace(/\s+/g, " ").trim() : undefined;
		if (!title) continue;
		const key = title.toLowerCase();
		const group = titles.get(key) ?? { title, pages: [] };
		group.pages.push(page.page.file);
		titles.set(key, group);
	}
	for (const group of titles.values()) {
		if (group.pages.length < 2) continue;
		rawNeedsReview.push({
			what: "Multiple audited pages use the same page title; confirm that each title describes and distinguishes its page.",
			page: group.pages[0] as string,
			evidence: `title ${JSON.stringify(group.title)} is used by ${group.pages.length} pages: ${group.pages.map((page) => JSON.stringify(page)).join(", ")}`,
			lens: "a11y",
			basis: "WCAG 2.4.2 Page Titled (A)",
			rule: "page-title-repeated",
		});
	}
	const prior = new Map(baseline?.occurrences.map((item) => [item.occurrenceId, item]));
	const compare = <T extends Finding | ReviewItem>(item: T, result: BaselineOccurrence["result"]): T & OccurrenceStatus => {
		const occurrence = reportOccurrence(item);
		if (!baseline) return occurrence;
		const previous = prior.get(occurrence.occurrenceId);
		if (!previous || previous.result !== result) {
			return { ...occurrence, comparison: previous ? "existing" : "new" };
		}
		return {
			...occurrence,
			comparison: "existing",
			disposition: previous.disposition,
			...(previous.review ? { review: previous.review } : {}),
		};
	};
	const findings = rawFindings.map((item) => compare(item, "finding"));
	const needsReview = rawNeedsReview.map((item) => compare(item, "needsReview"));
	const metadata = new Map<string, RuleMetadata>();
	for (const rule of pages.flatMap((page) => page.rules ?? [])) {
		metadata.set(rule.id, rule);
	}
	for (const item of [...rawFindings, ...rawNeedsReview]) {
		if (!metadata.has(item.rule)) metadata.set(item.rule, fallbackMetadata(item));
	}
	const rules = [...metadata.values()].sort((a, b) => a.id.localeCompare(b.id));
	const evaluations = mergeEvaluations([
		...pages.flatMap((page) => page.evaluations ?? []),
		...pages.flatMap((page) => page.untested ?? []),
		...findings.map((finding): RuleEvaluation => ({
			type: "rule",
			rule: finding.rule,
			page: finding.page,
			state: finding.state,
			outcome: "failed",
		})),
		...needsReview.map((item): RuleEvaluation => ({
			type: "rule",
			rule: item.rule,
			page: item.page,
			state: item.state,
			outcome: "cantTell",
		})),
	]);
	const rulesets = [...new Map([
		["praxity-check", { source: "praxity-check" as const, version: packageJson.version }],
		...rules.map((rule) => [rule.source, { source: rule.source, version: rule.rulesetVersion }] as const),
	]).values()].sort((a, b) => a.source.localeCompare(b.source));
	const confidence: AuditReport["counts"]["confidence"] = { high: 0, medium: 0, low: 0 };
	const rule: Record<string, number> = {};

	for (const finding of findings) {
		confidence[finding.confidence]++;
		rule[finding.rule] = (rule[finding.rule] ?? 0) + 1;
	}
	const currentIds = new Set([...findings, ...needsReview].map((item) => item.occurrenceId));
	const resolved = baseline?.occurrences.filter((item) => !currentIds.has(item.occurrenceId)) ?? [];

	return {
		schemaVersion: 4,
		toolName: TOOL_NAME,
		toolVersion: packageJson.version,
		projectUrl: PROJECT_URL,
		creditsUrl: CREDITS_URL,
		target: { path: targetPath, wasZip },
		environment,
		rulesets,
		rules,
		evaluations,
		scenarios,
		pages: pages.map(({ page, triage, audited }) => ({ ...page, triage, audited })),
		redirectStubs: discovery.stubs,
		findings,
		needsReview,
		...(baseline ? {
			baseline: { toolVersion: baseline.toolVersion, target: baseline.target },
			changes: { resolved },
		} : {}),
		notes,
		counts: { confidence, rule, needsReview: needsReview.length },
		network: {
			allowed: allowNetwork,
			blockedRequestCount: blockedRequests.length,
			blockedRequests,
		},
	};
}

function count(noun: string, amount: number): string {
	return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

/**
 * Findings at or above `minConfidence` are shown and drive the exit code.
 * Default is `high`: only measured, unambiguous failures stop a build. Loosen it
 * when the caller wants the medium-confidence custom checks -- focus visibility,
 * focus obscured, non-text contrast, reflow, text spacing -- to count too, which
 * is most of what this tool sees that axe does not.
 */
export type Confidence = "high" | "medium" | "low";
const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export function atOrAbove(level: Confidence, floor: Confidence): boolean {
	return RANK[level] >= RANK[floor];
}

export function countAtOrAbove(report: AuditReport, floor: Confidence): number {
	return report.findings.filter((f) => atOrAbove(f.confidence as Confidence, floor)).length;
}

export function humanSummary(report: AuditReport, minConfidence: Confidence = "high"): string {
	const lines = [
		`Generated by ${report.toolName} — created by Ariel Harlap`,
		report.projectUrl,
		"",
		`Checked ${count("page", report.pages.filter((page) => page.audited).length)}.${report.redirectStubs.length > 0 ? ` Skipped ${count("page", report.redirectStubs.length)} that only redirect elsewhere.` : ""}`,
	];
	const visibleByRule = new Map<string, Finding[]>();

	for (const finding of report.findings) {
		if (!atOrAbove(finding.confidence as Confidence, minConfidence)) continue;
		const group = visibleByRule.get(finding.rule) ?? [];
		group.push(finding);
		visibleByRule.set(finding.rule, group);
	}

	if (visibleByRule.size === 0) lines.push(`No findings at ${minConfidence} or higher confidence.`);
	for (const findings of visibleByRule.values()) {
		const first = findings[0];
		if (!first) continue;
		const pageCount = new Set(findings.map((finding) => finding.page)).size;
		lines.push(
			first.what,
			`  Found ${findings.length === 1 ? "once" : `${findings.length} times`} on ${count("page", pageCount)}.`,
			`  ${findings.length === 1 ? "Location" : "First location"}: ${first.page}${first.selector ? ` — ${first.selector}` : ""}`,
			`  Basis: ${first.basis}`,
		);
	}

	const withheld = report.findings.filter((finding) => !atOrAbove(finding.confidence as Confidence, minConfidence));
	const medium = withheld.filter((finding) => finding.confidence === "medium").length;
	const low = withheld.filter((finding) => finding.confidence === "low").length;
	if (medium > 0 || low > 0) {
		const hidden = [
			medium > 0 ? count("medium-confidence finding", medium) : "",
			low > 0 ? count("low-confidence finding", low) : "",
		].filter(Boolean);
		lines.push(`The JSON report includes ${hidden.join(" and ")} below the selected confidence level.`);
	}
	if (report.needsReview.length > 0) {
		lines.push(`The JSON report contains ${count("question", report.needsReview.length)} for a person to review. ${report.needsReview.length === 1 ? "It does not count as a finding" : "They do not count as findings"}.`);
	}
	if (report.changes) {
		const occurrences = [...report.findings, ...report.needsReview];
		lines.push(
			`Baseline comparison: ${count("new occurrence", occurrences.filter((item) => item.comparison === "new").length)}, ` +
			`${count("existing occurrence", occurrences.filter((item) => item.comparison === "existing").length)}, ` +
			`${count("resolved occurrence", report.changes.resolved.length)}.`,
		);
	}

	const failed = report.pages.filter((page) => !page.triage.ok);
	if (failed.length > 0) {
		lines.push("Pages not checked:");
		for (const page of failed) lines.push(`  ${page.file}: ${page.triage.reason ?? "unknown reason"}`);
	}

	if (report.network.blockedRequestCount > 0) {
		lines.push(`Stopped ${count("internet request", report.network.blockedRequestCount)} from the course. The JSON report lists each one.`);
	}
	for (const note of report.notes) lines.push(`Note: ${note}`);

	return lines.join("\n");
}
