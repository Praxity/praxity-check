import { normalizePdfPolicy, parseChecks, type PdfOptions } from "./selection.ts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const maxBytes = 64 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PDF report object");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Invalid PDF report text");
	return value;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Invalid PDF report array");
	return value;
}
function count(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid PDF report count");
	return value as number;
}
function hash(value: unknown): string {
	const result = text(value);
	if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("Invalid PDF report SHA-256");
	return result;
}
function canonical(value: unknown): string {
	// Policy is flat in pdf-1; unknown future fields prevent silent equivalence.
	const policy = Object.fromEntries(Object.entries(object(value)).filter(([, value]) => value !== undefined));
	if (Object.values(policy).some((v) => !["string", "number", "boolean"].includes(typeof v) || typeof v === "number" && !Number.isFinite(v))) throw new Error("Invalid PDF report policy");
	return JSON.stringify(Object.entries(normalizePdfPolicy(policy as PdfOptions)).sort(([a], [b]) => a.localeCompare(b)));
}

/** Validate every field consumed by comparison; unrelated report evidence stays opaque. */
export function validateComparisonReport(value: unknown) {
	const report = object(value);
	if (report.schemaVersion !== "pdf-1") throw new Error("Expected schemaVersion pdf-1");
	const sha256 = hash(object(report.document).sha256);
	if (report.machineStatus !== "complete" && report.machineStatus !== "incomplete") throw new Error("Invalid machine status");
	const pages = array(object(report.facts).pages).map((p) => count(object(p).page));
	if (pages.some((p, i) => p !== i + 1)) throw new Error("Invalid PDF page sequence");
	const issues = (value: unknown) => array(value).map((v) => {
		const issue = object(v), location = object(issue.location);
		if (hash(location.documentSha256) !== sha256) throw new Error("Finding document hash does not match report");
		const page = location.page === undefined ? undefined : count(location.page);
		if (page !== undefined && (page < 1 || pages.length > 0 && !pages.includes(page) || pages.length === 0 && !evaluations.some((e) => e.rule === "page.facts" && e.outcome === "untested"))) throw new Error("Finding page is outside report coverage");
		return { check: issue.check === undefined ? undefined : text(issue.check), id: text(issue.id), rule: text(issue.rule), message: text(issue.message), page, observation: issue.rule === "pdf.visual.inference" || issue.rule === "pdf.usability.inference" ? text(object(issue.evidence).observation) : undefined };
	});
	const evaluations = array(report.evaluations).map((v) => {
		const e = object(v), outcome = text(e.outcome);
		if (!["passed", "failed", "cantTell", "inapplicable", "untested"].includes(outcome)) throw new Error("Invalid evaluation outcome");
		return { rule: text(e.rule), outcome };
	});
	const versions = array(report.evidence).flatMap((v) => {
		const e = object(v), args = array(e.args).map(text);
		const tool = text(e.tool);
		if (args.length !== 1 || args[0] !== "-v") return [];
		if (e.exitCode !== 0 || e.error !== undefined) return [];
		const stdout = e.stdout, stderr = e.stderr;
		if (typeof stdout !== "string" || typeof stderr !== "string") throw new Error("Invalid version evidence");
		const version = `${stdout}${stderr}`.trim();
		return version ? [[tool, version]] : [];
	}).sort(([a], [b]) => a!.localeCompare(b!));
	const validator = report.pdfuaValidation === undefined ? undefined : (() => {
		const v = object(report.pdfuaValidation);
		if (v.name !== "veraPDF" || v.profile !== "ua1" && v.profile !== "ua2") throw new Error("Invalid PDF/UA validator");
		const version = v.version === undefined ? undefined : text(v.version);
		const coverage = v.coverage === undefined ? undefined : (() => {
			const c = object(v.coverage);
			if (c.status !== "complete" && c.status !== "partial") throw new Error("Invalid PDF/UA coverage status");
			const rules = array(c.rules).map((value) => {
				const r = object(value);
				return { rule: text(r.rule), failedChecks: count(r.failedChecks), retainedChecks: count(r.retainedChecks), omittedChecks: count(r.omittedChecks) };
			});
			const failed = count(c.failedChecks), retained = count(c.retainedChecks), omitted = count(c.omittedChecks);
			if (failed !== retained + omitted || (c.status === "complete") !== (omitted === 0) || new Set(rules.map((r) => r.rule)).size !== rules.length || rules.some((r) => r.failedChecks === 0 || r.failedChecks !== r.retainedChecks + r.omittedChecks) || rules.reduce((n, r) => n + r.failedChecks, 0) !== failed || rules.reduce((n, r) => n + r.retainedChecks, 0) !== retained) throw new Error("Contradictory PDF/UA coverage");
			const retainedFindings = issues(report.findings).filter((finding) => finding.rule.startsWith("pdfua:"));
			if (typeof v.machineCompliant !== "boolean" || v.machineCompliant !== (failed === 0) || retainedFindings.length !== retained || retainedFindings.some((finding) => !rules.some((r) => r.rule === finding.rule)) || rules.some((r) => retainedFindings.filter((finding) => finding.rule === r.rule).length !== r.retainedChecks)) throw new Error("PDF/UA findings contradict coverage");
			const expectedOutcome = c.status === "partial" ? "untested" : failed ? "failed" : "passed";
			const machine = evaluations.filter((e) => e.rule === "pdfua.machine");
			if (machine.length !== 1 || machine[0]!.outcome !== expectedOutcome || c.status === "partial" && report.machineStatus !== "incomplete") throw new Error("PDF/UA evaluation contradicts coverage");
			return { status: c.status, rules };
		})();
		return { profile: v.profile, version, coverage };
	})();
	const inference = (report.inferenceReviews === undefined ? [] : array(report.inferenceReviews)).flatMap((v) => {
		const review = object(v);
		if (hash(review.documentSha256) !== sha256) throw new Error("Inference document hash does not match report");
		const focus = review.tier === "inference" ? review.focus : review.tier;
		if (focus !== "visual" && focus !== "usability") throw new Error("Invalid inference focus");
		const domains = review.tier === "inference" ? (() => {
			const checks = array(review.checks);
			if (checks.some((check) => check !== "accessibility" && check !== "design")) throw new Error("Invalid inference check domain");
			return parseChecks(checks.join(","));
		})() : undefined;
		if (domains) for (const finding of array(review.findings)) {
			if (!domains.includes(text(object(finding).check) as "accessibility" | "design")) throw new Error("Inference finding outside selected checks");
		}
		const reviewed = array(review.pagesReviewed).map(count);
		if (!reviewed.length || new Set(reviewed).size !== reviewed.length || reviewed.some((p) => !pages.includes(p))) throw new Error("Invalid inference coverage");
		return issues(review.findings).map((issue) => {
			if (issue.rule !== `pdf.${focus}.inference` || issue.page === undefined || !reviewed.includes(issue.page)) throw new Error("Inference finding outside review coverage");
			return issue;
		});
	});
	return { sha256, pageCount: pages.length, policy: canonical(report.policy), complete: report.machineStatus === "complete", evaluations, versions, validator,
		findings: issues(report.findings), needsReview: issues(report.needsReview), inference };
}

export function comparePdfReports(beforeValue: unknown, afterValue: unknown) {
	const before = validateComparisonReport(beforeValue), after = validateComparisonReport(afterValue);
	const policySame = before.policy === after.policy;
	const toolsSame = JSON.stringify(before.versions) === JSON.stringify(after.versions);
	const pageCountSame = before.pageCount === after.pageCount;
	const passed = (report: typeof before, rule: string) => report.evaluations.some((e) => e.rule === rule && e.outcome === "passed") && !report.evaluations.some((e) => e.rule === rule && e.outcome !== "passed");
	const completedMachine = (report: typeof before) => report.evaluations.some((e) => e.rule === "pdfua.machine" && ["passed", "failed"].includes(e.outcome)) && !report.evaluations.some((e) => e.rule === "pdfua.machine" && !["passed", "failed"].includes(e.outcome));
	function resolved(rule: string): boolean {
		if (after.findings.some((finding) => finding.rule === rule) || !policySame || !before.complete || !after.complete || !pageCountSame || !toolsSame) return false;
		if (rule.startsWith("pdfua:")) {
			const b = before.validator, a = after.validator;
			return !!(a?.version && b?.version === a.version && a.profile === b.profile && a.coverage?.status === "complete" && b.coverage?.status === "complete" && completedMachine(before) && completedMachine(after) && b.coverage.rules.some((r) => r.rule === rule) && !a.coverage.rules.some((r) => r.rule === rule));
		}
		const required = rule === "font.embedding" ? ["font.facts", "pdffonts"] : rule === "page.geometry" ? ["page.facts", "pdfinfo"] : undefined;
		return !!(required && passed(after, rule) && passed(before, required[0]!) && passed(after, required[0]!) && before.versions.some(([tool]) => tool === required[1]) && after.versions.some(([tool]) => tool === required[1]));
	}
	const groups = [];
	for (const kind of ["findings", "needsReview", "inference"] as const) {
		const entries = new Map<string, { rule: string; message: string; page?: number; beforeIds: string[]; afterIds: string[] }>();
		for (const [revision, report] of [["beforeIds", before], ["afterIds", after]] as const) for (const issue of report[kind]) {
			const key = JSON.stringify([issue.rule, issue.message, issue.page, kind === "inference" ? issue.observation : undefined, issue.check]);
			const group = entries.get(key) ?? { rule: issue.rule, message: issue.message, page: issue.page, beforeIds: [], afterIds: [] };
			group[revision].push(issue.id); entries.set(key, group);
		}
		for (const group of entries.values()) groups.push({ kind, ...group, beforeCount: group.beforeIds.length, afterCount: group.afterIds.length,
			reason: !group.beforeIds.length ? "Reported in the new report; introduction time is unknown." : group.afterIds.length ? "The same reported problem appears in both reports; occurrence identity is not established." : kind !== "findings" ? "Absence of a review observation does not verify a repair." : !policySame ? "Policy changed." : !before.complete || !after.complete ? "At least one report has incomplete extraction or validation." : !pageCountSame ? "Page count changed; no relocation or cross-page identity is inferred." : !toolsSame ? "Recorded tool versions changed." : resolved(group.rule) ? "Comparable completed machine coverage establishes that this rule no longer reports a failure." : "Comparable rule coverage, known tool versions or an explicit passed check is unavailable; the problem may not have been rechecked.",
			status: !group.beforeIds.length ? "newly-reported" : group.afterIds.length ? "reported-again" : kind === "findings" && resolved(group.rule) ? "resolved" : "unverified" });
	}
	return { schemaVersion: "pdf-comparison-1", beforeSha256: before.sha256, afterSha256: after.sha256,
		comparison: { sameDocumentHash: before.sha256 === after.sha256, policySame, toolsSame, beforePolicy: JSON.parse(before.policy), afterPolicy: JSON.parse(after.policy), beforeToolVersions: before.versions, afterToolVersions: after.versions,
			beforePageCount: before.pageCount, afterPageCount: after.pageCount, beforeComplete: before.complete, afterComplete: after.complete, beforePdfuaValidation: before.validator, afterPdfuaValidation: after.validator, pdfuaCoverageKnown: !!(before.validator?.coverage && after.validator?.coverage), pdfuaVersionsComparable: !!(before.validator?.version && before.validator.version === after.validator?.version && before.validator.profile === after.validator?.profile) },
		limits: ["Groups match rule, message and page, not object identity. IDs remain scoped to their document hash.", "Newly reported does not mean newly introduced. Reduced counts do not prove individual repairs.", "Missing review or inference findings remain unverified. Resolution means only that a comparable machine check established absence.", "No cross-page identity matching. Equal page counts do not establish unchanged pagination."], groups };
}

async function readReport(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > maxBytes) throw new Error("PDF comparison input must be a regular JSON file no larger than 64 MiB");
		const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
		let length = 0;
		while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
		if (length > info.size) throw new Error("PDF comparison input changed while reading");
		return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
	} finally { await file.close(); }
}

export async function pdfCompareCli(args: string[]): Promise<number> {
	if (args.length < 3 || args.length > 4 || args[0] !== "compare-pdf" || args.slice(1, 3).some((a) => a.startsWith("--")) || args.length === 4 && args[3] !== "--json") throw new Error("Usage: praxity-check compare-pdf BEFORE.json AFTER.json [--json]");
	const result = comparePdfReports(await readReport(args[1]!), await readReport(args[2]!));
	if (args[3] === "--json") console.log(JSON.stringify(result, null, 2));
	else {
		console.log(`Before SHA-256: ${result.beforeSha256}\nAfter SHA-256:  ${result.afterSha256}`);
		console.log(`Same policy: ${result.comparison.policySame}; same recorded tool versions: ${result.comparison.toolsSame}; extraction complete: ${result.comparison.beforeComplete} → ${result.comparison.afterComplete}; pages: ${result.comparison.beforePageCount} → ${result.comparison.afterPageCount}`);
		console.log(`PDF/UA coverage known: ${result.comparison.pdfuaCoverageKnown}; comparable validator version/profile: ${result.comparison.pdfuaVersionsComparable}. Unknown coverage never establishes resolution.`);
		for (const group of result.groups) console.log(`${group.status} [${group.kind}] ${group.rule}${group.page ? `, page ${group.page}` : ""}: ${group.message} (${group.beforeCount} → ${group.afterCount})\n  ${group.reason}`);
		for (const limit of result.limits) console.log(limit);
	}
	return 0;
}
