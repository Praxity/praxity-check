import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Profile = "ua1" | "ua2";
type Evidence = { tool: string; args: string[]; stdout: string; stderr: string; exitCode: number | null; error?: string };
type Finding = { rule: string; message: string; remedy: string; evidence: unknown; location: { page?: number }; severity: "serious" | "moderate"; confidence: "high" | "medium" };

// Source-level guidance for verified ISO 14289-1:2014 rules. Other versions keep validator wording.
const feedback: Record<string, { message: string; remedy: string }> = {
	"ISO 14289-1:2014:7.21.4.1:1": { message: "A font used in this content is not embedded.", remedy: "Embed the font in the PDF export, or replace it in the source with an embeddable font." },
	"ISO 14289-1:2014:7.1:10": { message: "The PDF is not set to display its document title.", remedy: "Set the export's initial view to show the document title. Check that the title metadata describes the document." },
	"ISO 14289-1:2014:7.2:34": { message: "This text has no identifiable language for a screen reader.", remedy: "Set the document language in the source and mark passages in other languages before exporting." },
	"ISO 14289-1:2014:7.1:8": { message: "The PDF's document metadata stream is missing or malformed.", remedy: "Export with XMP document metadata enabled. If it is already enabled, inspect the metadata stream described in the evidence." },
	"ISO 14289-1:2014:6.2:1": { message: "The PDF does not declare itself as tagged.", remedy: "Export with accessibility tags enabled, then check that the export contains a structure tree with meaningful tags." },
	"ISO 14289-1:2014:7.1:3": { message: "This content has no tag or artifact designation.", remedy: "Give meaningful content a semantic tag in the source. Mark it as an artifact only after confirming it is decorative or incidental." },
	"ISO 14289-1:2014:7.1:11": { message: "The PDF has no structure tree for assistive technology to follow.", remedy: "Add semantic structure in the source and export with accessibility tags enabled." },
	"ISO 14289-1:2014:7.9:1": { message: "A Note tag is missing its identifier.", remedy: "Use the source tool's footnote or endnote feature and check that the exported Note tag has an ID." },
	"ISO 14289-1:2014:7.3:1": { message: "A figure has no alternative description or replacement text.", remedy: "Add alternative text to the figure in the source that conveys the figure's purpose and information. If the figure is purely decorative, mark it as decorative after reviewing its purpose." },
	"ISO 14289-1:2014:7.1:1": { message: "Content marked as an artifact is nested inside tagged content.", remedy: "Review the identified content's purpose and correct its grouping in the source or export so artifacts sit outside tagged content." },
	"ISO 14289-1:2014:7.1:2": { message: "Tagged content is nested inside an artifact.", remedy: "Move meaningful content out of the decorative group in the source and preserve its semantic tags in the export." },
};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unrecognized veraPDF object");
	return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Unrecognized veraPDF array");
	return value;
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid veraPDF count");
	return value;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Missing veraPDF text");
	return value;
}

/** Validate a completed single-document job, preserving retained checks and evidence coverage. */
export function parseVeraPdf(raw: string, profile: Profile) {
	const report = object(object(JSON.parse(raw)).report), summary = object(report.batchSummary);
	if (count(summary.totalJobs) !== 1) throw new Error("Expected one veraPDF job");
	for (const key of ["failedParsingJobs", "failedEncryptedJobs", "outOfMemory", "veraExceptions"]) {
		if (count(summary[key]) !== 0) throw new Error(`veraPDF reported ${key}`);
	}
	const validationSummary = object(summary.validationSummary);
	if (count(validationSummary.failedJobCount) !== 0 || count(validationSummary.totalJobCount) !== 1 || count(validationSummary.successfulJobCount) !== 1) throw new Error("Incomplete veraPDF validation job");
	const jobs = array(report.jobs);
	if (jobs.length !== 1) throw new Error("Expected one veraPDF result");
	const results = array(object(jobs[0]).validationResult);
	if (results.length !== 1) throw new Error("Expected one veraPDF profile result");
	const result = object(results[0]);
	const profileNames = profile === "ua1" ? ["PDF/UA-1 validation profile"] : ["PDF/UA-2 validation profile", "PDF/UA-2 + Tagged PDF validation profile"];
	if (typeof result.profileName !== "string" || !profileNames.includes(result.profileName) || result.jobEndStatus !== "normal" || typeof result.compliant !== "boolean") throw new Error("Unexpected or incomplete veraPDF profile");
	const details = object(result.details), failedRules = count(details.failedRules), failedChecks = count(details.failedChecks);
	const passedRules = count(details.passedRules), passedChecks = count(details.passedChecks);
	if (passedRules + failedRules === 0 || result.compliant !== (failedRules === 0 && failedChecks === 0) || (failedRules === 0) !== (failedChecks === 0)) throw new Error("Contradictory veraPDF counts");
	if (count(validationSummary.compliantPdfaCount) !== Number(result.compliant) || count(validationSummary.nonCompliantPdfaCount) !== Number(!result.compliant)) throw new Error("Contradictory veraPDF summary");
	const rules = details.ruleSummaries === undefined && failedRules === 0 ? [] : array(details.ruleSummaries);
	const findings: Finding[] = [];
	let reportedChecks = 0;
	const ruleCoverage: { rule: string; failedChecks: number; retainedChecks: number; omittedChecks: number }[] = [];
	const seenRules = new Set<string>();
	for (const value of rules) {
		const rule = object(value);
		if (rule.status !== "failed" || rule.ruleStatus !== "FAILED") throw new Error("Unexpected veraPDF rule status");
		const specification = text(rule.specification), clause = text(rule.clause), testNumber = count(rule.testNumber), description = text(rule.description);
		if (!testNumber) throw new Error("Invalid veraPDF test number");
		const checks = array(rule.checks);
		const expectedChecks = count(rule.failedChecks);
		const ruleId = `pdfua:${specification}:${clause}:${testNumber}`;
		if (seenRules.has(ruleId)) throw new Error("Duplicate veraPDF rule evidence");
		seenRules.add(ruleId);
		if (expectedChecks === 0 || checks.length > expectedChecks) throw new Error("Contradictory veraPDF rule counts");
		reportedChecks += expectedChecks;
		// veraPDF caps stored assertions globally, even with --maxfailuresdisplayed -1.
		ruleCoverage.push({ rule: ruleId, failedChecks: expectedChecks, retainedChecks: checks.length, omittedChecks: expectedChecks - checks.length });
		for (const value of checks) {
			const check = object(value);
			if (check.status !== "failed") throw new Error("Unexpected veraPDF check status");
			const context = text(check.context), message = text(check.errorMessage);
			const pageMatch = context.match(/\/pages\[(\d+)\]\(\d+ \d+ obj PDPage\)(?:\/|$)/);
			const page = pageMatch ? Number(pageMatch[1]) + 1 : undefined;
			const guidance = feedback[`${specification}:${clause}:${testNumber}`];
			findings.push({ rule: ruleId, message: guidance?.message ?? message,
				remedy: guidance?.remedy ?? "Review the identified object against the requirement in the evidence, then correct the source or export settings.",
				location: page !== undefined && Number.isSafeInteger(page) ? { page } : {}, severity: "serious", confidence: "high",
				evidence: { specification, clause, testNumber, description, object: rule.object, test: rule.test, check } });
		}
	}
	if (rules.length !== failedRules || !Number.isSafeInteger(reportedChecks) || reportedChecks !== failedChecks) throw new Error("Incomplete or contradictory veraPDF rule evidence");
	const coverage = { status: findings.length === failedChecks ? "complete" as const : "partial" as const, failedChecks, retainedChecks: findings.length, omittedChecks: failedChecks - findings.length, rules: ruleCoverage };
	const builds = array(object(report.buildInformation).releaseDetails).map(object);
	const version = text(builds.find((entry) => entry.id === "core")?.version);
	return { findings, coverage, machineCompliant: result.compliant, version, passedRules, failedRules, passedChecks, failedChecks };
}

async function run(tool: string, args: string[]): Promise<Evidence> {
	try {
		const { stdout, stderr } = await exec(tool, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
		return { tool, args, stdout, stderr, exitCode: 0 };
	} catch (error) {
		const e = error as Error & { code?: string | number; stdout?: string; stderr?: string };
		return { tool, args, stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: typeof e.code === "number" ? e.code : null, error: e.message };
	}
}

export async function checkPdfAccessibility(snapshot: string, options: { profile: Profile; executable?: string }) {
	const profile = options.profile;
	if (profile !== "ua1" && profile !== "ua2") throw new Error("PDF/UA profile must be ua1 or ua2");
	const executable = options.executable ?? process.env.VERAPDF ?? "verapdf";
	if (!executable.trim()) throw new Error("veraPDF executable must not be empty");
	const evidence = await run(executable, ["--flavour", profile, "--format", "json", "--maxfailuresdisplayed", "-1", snapshot]);
	const output = { evidence: [evidence], machineStatus: "complete" as "complete" | "incomplete",
		validator: { name: "veraPDF", profile, version: undefined as string | undefined, machineCompliant: undefined as boolean | undefined, coverage: undefined as ReturnType<typeof parseVeraPdf>["coverage"] | undefined },
		evaluations: [] as { rule: string; outcome: "passed" | "failed" | "untested"; reason: string }[], findings: [] as Finding[], needsReview: [] as Finding[] };
	try {
		if (evidence.exitCode !== 0 && evidence.exitCode !== 1) throw new Error(evidence.error ?? "veraPDF did not complete");
		const result = parseVeraPdf(evidence.stdout, profile);
		if (evidence.exitCode !== Number(!result.machineCompliant)) throw new Error("veraPDF exit code contradicts validation result");
		output.validator.version = result.version;
		output.validator.machineCompliant = result.machineCompliant;
		output.findings = result.findings;
		output.validator.coverage = result.coverage;
		if (result.coverage.status === "partial") {
			output.machineStatus = "incomplete";
			output.evaluations.push({ rule: "pdfua.machine", outcome: "untested", reason: `veraPDF retained ${result.coverage.retainedChecks} of ${result.failedChecks} failed checks; ${result.coverage.omittedChecks} checks have no retained evidence. All ${result.failedRules} failed rule summaries are present. Stored assertions may have been capped; findings and locations are incomplete.` });
			for (const rule of result.coverage.rules.filter((rule) => rule.omittedChecks > 0)) output.evaluations.push({ rule: rule.rule, outcome: "untested", reason: `Retained ${rule.retainedChecks} of ${rule.failedChecks} failed checks; ${rule.omittedChecks} checks have no retained evidence or locations.` });
		} else {
			output.evaluations.push({ rule: "pdfua.machine", outcome: result.machineCompliant ? "passed" : "failed", reason: `veraPDF ${result.version} ${profile}: ${result.passedRules} passed rules, ${result.failedRules} failed rules, ${result.failedChecks} failed checks.` });
		}
		if (evidence.stderr.trim()) output.needsReview.push({ rule: "pdfua.diagnostics", message: "veraPDF emitted diagnostics.", remedy: "Inspect stderr and resolve warnings before relying on the machine result.", evidence: evidence.stderr, location: {}, severity: "moderate", confidence: "medium" });
	} catch (error) {
		output.machineStatus = "incomplete";
		output.evaluations.push({ rule: "pdfua.machine", outcome: "untested", reason: error instanceof Error ? error.message : String(error) });
	}
	return output;
}
