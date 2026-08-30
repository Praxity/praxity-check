#!/usr/bin/env node

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type Detectability = "yes" | "partial" | "no";
type ResultKind = "finding" | "needsReview";
type ActOutcome = "passed" | "failed" | "inapplicable";

interface ExpectedResult {
	result: ResultKind;
	rule: string;
}

interface BenchCase {
	id: string;
	expectedDetectable: Detectability;
	expectedResults: ExpectedResult[];
}

interface ReportResult {
	page: string;
	rule: string;
}

interface BenchReport {
	pages: Array<{ file: string; audited: boolean; triage: { ok: boolean; reason?: string } }>;
	findings: ReportResult[];
	needsReview: ReportResult[];
	notes: string[];
}

interface ActCase {
	actRuleId: string;
	praxityRule: string;
	testcaseId: string;
	title: string;
	expected: ActOutcome;
	expectedFinding: boolean;
	consistent: boolean;
	note?: string;
}

const run = promisify(execFile);
const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(BENCH_DIR, "../../src/cli.ts");
const MANIFEST = join(BENCH_DIR, "manifest.json");
const ACT_DIR = resolve(BENCH_DIR, "../act");
const ACT_MANIFEST = join(ACT_DIR, "manifest.json");
const EXPECTED_CASES = 40;
const RESULT_KINDS = new Set<ResultKind>(["finding", "needsReview"]);
const DETECTABILITY = new Set<Detectability>(["yes", "partial", "no"]);
const UNCHECKED = /did not run|not run|unchecked|page audit exceeded/i;
const ACT_OUTCOMES = new Set<ActOutcome>(["passed", "failed", "inapplicable"]);

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected an object");
	}
	return value as Record<string, unknown>;
}

function parseManifest(value: unknown): BenchCase[] {
	if (!Array.isArray(value) || value.length !== EXPECTED_CASES) {
		throw new Error(`manifest must contain exactly ${EXPECTED_CASES} cases`);
	}
	const ids = new Set<string>();
	return value.map((raw, index) => {
		const item = record(raw);
		if (typeof item.id !== "string" || ids.has(item.id)) {
			throw new Error(`manifest case ${index + 1} has a missing or duplicate id`);
		}
		ids.add(item.id);
		if (!DETECTABILITY.has(item.expectedDetectable as Detectability)) {
			throw new Error(`${item.id} has an invalid expectedDetectable value`);
		}
		if (!Array.isArray(item.expectedResults)) {
			throw new Error(`${item.id} must declare expectedResults`);
		}
		const expectedResults = item.expectedResults.map((rawResult) => {
			const expected = record(rawResult);
			if (!RESULT_KINDS.has(expected.result as ResultKind) || typeof expected.rule !== "string") {
				throw new Error(`${item.id} has an invalid expected result`);
			}
			return { result: expected.result as ResultKind, rule: expected.rule };
		});
		if (new Set(expectedResults.map(resultKey)).size !== expectedResults.length) {
			throw new Error(`${item.id} has duplicate expected results`);
		}
		return {
			id: item.id,
			expectedDetectable: item.expectedDetectable as Detectability,
			expectedResults,
		};
	});
}

function parseResults(value: unknown, name: string): ReportResult[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value.map((raw) => {
		const item = record(raw);
		if (typeof item.page !== "string" || typeof item.rule !== "string") {
			throw new Error(`${name} contains an invalid result`);
		}
		return { page: item.page, rule: item.rule };
	});
}

function parseReport(value: unknown): BenchReport {
	const report = record(value);
	if (!Array.isArray(report.pages) || !Array.isArray(report.notes)) {
		throw new Error("scan report is missing pages or notes");
	}
	return {
		pages: report.pages.map((raw) => {
			const page = record(raw);
			const triage = record(page.triage);
			if (typeof page.file !== "string" || typeof page.audited !== "boolean" || typeof triage.ok !== "boolean") {
				throw new Error("scan report contains an invalid page result");
			}
			return {
				file: page.file,
				audited: page.audited,
				triage: {
					ok: triage.ok,
					reason: typeof triage.reason === "string" ? triage.reason : undefined,
				},
			};
		}),
		findings: parseResults(report.findings, "findings"),
		needsReview: parseResults(report.needsReview, "needsReview"),
		notes: report.notes.map((note) => {
			if (typeof note !== "string") throw new Error("scan report contains an invalid note");
			return note;
		}),
	};
}

function parseActManifest(value: unknown): ActCase[] {
	const manifest = record(value);
	if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
		throw new Error("ACT manifest must contain cases");
	}
	return manifest.cases.map((raw, index) => {
		const item = record(raw);
		const { actRuleId, praxityRule, testcaseId, title, expected, expectedFinding, consistent, note } = item;
		if (
			typeof actRuleId !== "string" ||
			typeof praxityRule !== "string" ||
			typeof testcaseId !== "string" ||
			typeof title !== "string" ||
			!ACT_OUTCOMES.has(expected as ActOutcome) ||
			typeof expectedFinding !== "boolean" ||
			typeof consistent !== "boolean" ||
			(note !== undefined && typeof note !== "string") ||
			(consistent === false && typeof note !== "string")
		) {
			throw new Error(`ACT manifest case ${index + 1} is invalid`);
		}
		return {
			actRuleId,
			praxityRule,
			testcaseId,
			title,
			expected: expected as ActOutcome,
			expectedFinding,
			consistent,
			note,
		};
	});
}

function resultKey(result: ExpectedResult): string {
	return `${result.result}:${result.rule}`;
}

function pageResults(report: BenchReport, page: string): Set<string> {
	return new Set([
		...report.findings.filter((item) => item.page === page).map((item) => `finding:${item.rule}`),
		...report.needsReview.filter((item) => item.page === page).map((item) => `needsReview:${item.rule}`),
	]);
}

function processError(error: unknown): { code?: number | string; stderr?: string } {
	return error && typeof error === "object" ? error as { code?: number | string; stderr?: string } : {};
}

async function scanVariant(root: string, cases: BenchCase[], variant: "defect" | "clean"): Promise<BenchReport> {
	const target = join(root, variant);
	await mkdir(target);
	for (const item of cases) {
		const source = join(BENCH_DIR, item.id);
		const destination = join(target, item.id);
		await mkdir(destination);
		await copyFile(join(source, `${variant}.html`), join(destination, `${variant}.html`));
		for (const entry of await readdir(source, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".html") || /^(?:defect|clean)\.html$/.test(entry.name)) continue;
			await copyFile(join(source, entry.name), join(destination, entry.name));
		}
	}

	const output = join(root, `${variant}.json`);
	console.log(`Scanning ${cases.length} ${variant} pages...`);
	try {
		await run(process.execPath, [CLI, "check", target, "--json", output, "--min-confidence", "low"], {
			maxBuffer: 20 * 1024 * 1024,
		});
	} catch (error) {
		const failure = processError(error);
		if (Number(failure.code) !== 1) {
			throw new Error(`the ${variant} scan failed${failure.stderr ? `: ${failure.stderr.trim()}` : ""}`);
		}
	}
	return parseReport(JSON.parse(await readFile(output, "utf8")) as unknown);
}

async function scanAct(root: string): Promise<BenchReport> {
	const output = join(root, "act.json");
	console.log("\nScanning selected ACT fixtures...");
	try {
		await run(process.execPath, [CLI, "check", ACT_DIR, "--json", output, "--min-confidence", "low"], {
			maxBuffer: 20 * 1024 * 1024,
		});
	} catch (error) {
		const failure = processError(error);
		if (Number(failure.code) !== 1) {
			throw new Error(`the ACT scan failed${failure.stderr ? `: ${failure.stderr.trim()}` : ""}`);
		}
	}
	return parseReport(JSON.parse(await readFile(output, "utf8")) as unknown);
}

async function main(): Promise<number> {
	const cases = parseManifest(JSON.parse(await readFile(MANIFEST, "utf8")) as unknown);
	const actCases = parseActManifest(JSON.parse(await readFile(ACT_MANIFEST, "utf8")) as unknown);
	const root = await mkdtemp(join(tmpdir(), "praxity-check-bench-"));
	try {
		const defect = await scanVariant(root, cases, "defect");
		const clean = await scanVariant(root, cases, "clean");
		const act = await scanAct(root);
		const errors: string[] = [];

		for (const [variant, report] of [["defect", defect], ["clean", clean]] as const) {
			for (const item of cases) {
				const file = `${item.id}/${variant}.html`;
				const page = report.pages.find((candidate) => candidate.file === file);
				if (!page?.audited || !page.triage.ok) {
					errors.push(`${file} was not audited${page?.triage.reason ? `: ${page.triage.reason}` : ""}`);
				}
			}
			for (const note of report.notes.filter((note) => UNCHECKED.test(note))) {
				errors.push(`${variant} scan reported unchecked coverage: ${note}`);
			}
		}

		for (const item of cases) {
			const defectResults = pageResults(defect, `${item.id}/defect.html`);
			const cleanResults = pageResults(clean, `${item.id}/clean.html`);
			const observed = new Set([...defectResults].filter((result) => !cleanResults.has(result)));
			const expected = new Set(item.expectedResults.map(resultKey));
			const missing = [...expected].filter((result) => !observed.has(result));
			const unexpected = [...observed].filter((result) => !expected.has(result));
			const cleanOnlyFindings = [...cleanResults].filter(
				(result) => result.startsWith("finding:") && !defectResults.has(result),
			);
			if (missing.length > 0) errors.push(`${item.id} missed ${missing.join(", ")}`);
			if (unexpected.length > 0) errors.push(`${item.id} added ${unexpected.join(", ")}`);
			if (cleanOnlyFindings.length > 0) {
				errors.push(`${item.id} clean page added ${cleanOnlyFindings.join(", ")}`);
			}
		}

		for (const item of actCases) {
			const file = `${item.actRuleId}/${item.testcaseId}.html`;
			const page = act.pages.find((candidate) => candidate.file === file);
			if (!page?.audited || !page.triage.ok) {
				errors.push(`${file} was not audited${page?.triage.reason ? `: ${page.triage.reason}` : ""}`);
				continue;
			}
			const finding = act.findings.some((candidate) => candidate.page === file && candidate.rule === item.praxityRule);
			if (finding !== item.expectedFinding) {
				errors.push(`${file} ${finding ? "added" : "missed"} finding:${item.praxityRule}`);
			}
			const consistent = item.expected === "failed" ? finding : !finding;
			if (consistent !== item.consistent) {
				errors.push(`${file} ACT consistency changed; review its manifest classification`);
			}
		}
		for (const note of act.notes.filter((note) => UNCHECKED.test(note))) {
			errors.push(`ACT scan reported unchecked coverage: ${note}`);
		}

		console.log("\nDeclared detection coverage:");
		for (const category of ["yes", "partial", "no"] as const) {
			const matching = cases.filter((item) => item.expectedDetectable === category);
			const detected = matching.filter((item) => item.expectedResults.length > 0);
			console.log(`  ${category}: ${detected.length}/${matching.length}`);
			const gaps = matching.filter((item) => item.expectedResults.length === 0).map((item) => item.id);
			if (gaps.length > 0) console.log(`    no current result: ${gaps.join(", ")}`);
		}

		const consistentAct = actCases.filter((item) => item.consistent);
		console.log(`\nSelected ACT consistency: ${consistentAct.length}/${actCases.length}`);
		for (const item of actCases.filter((candidate) => !candidate.consistent)) {
			console.log(`  ${item.actRuleId} ${item.title}: ${item.note}`);
		}

		if (errors.length === 0) {
			console.log(`\nPASS ${cases.length} defect/clean pairs and ${actCases.length} ACT fixtures match their manifests.`);
			return 0;
		}
		console.error(`\nFAIL ${errors.length} benchmark mismatch${errors.length === 1 ? "" : "es"}:`);
		for (const error of errors) console.error(`  ${error}`);
		return 1;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

process.exitCode = await main().catch((error: unknown) => {
	console.error(`praxity-check bench: ${error instanceof Error ? error.message : String(error)}`);
	return 1;
});
