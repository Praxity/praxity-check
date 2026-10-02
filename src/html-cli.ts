#!/usr/bin/env node

import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditHtml, withAuditContext } from "./html-audit.ts";
import { discover } from "./discover.ts";
import { assertOutputOutside, openInput, snapshotInput, type Input } from "./input.ts";
import { countAtOrAbove, createReport, humanSummary, parseBaseline, type Confidence, type AuditReport } from "./report.ts";
import { resolveScreenReaderPage, runScreenReader, runScreenReaderJourney, validateJourneySessionOptions } from "./screen-reader.ts";
import { serve, type StaticServer } from "./serve.ts";
import { htmlFeedback } from "./feedback.ts";
import { importHtmlReview, readHtmlReviewBundle, writeHtmlReviewBundle } from "./html-review.ts";
import { parseReviewExecutionOption, runPreparedReview, validateReviewExecutionOptions, type ReviewExecutionOptions } from "./review-runner.ts";
import { prepareInteractionReview } from "./interaction-review.ts";
import { loadScenarios } from "./scenarios.ts";

import { parseChecks, parseTier, validateHtmlSelection, type SelectionOptions } from "./selection.ts";

const USAGE = `Usage:
  praxity-check check <folder|zip|pdf> [options]
  praxity-check compare-pdf <before.json> <after.json> [--json]
  praxity-check prepare-review <folder|zip> [--allow-network] [--output <new-directory>]
  praxity-check prepare-review <pdf> --tier inference --checks accessibility|design [--focus visual|usability] [--output <new-directory>] [--pages 1,3] [--audience <text>] [--use <text>]
  praxity-check screen-reader <folder|zip> --page <html> --control <name> --expected <phrase> --take-screen-control --allow-network
  praxity-check screen-reader <folder|zip|URL> --journey <file.json> --output <new-directory> --take-screen-control [--allow-network]

Options:
  --checks accessibility|design|accessibility,design
                                   What to check (default accessibility)
  --tier deterministic|inference   How to check: automated rules, or import a model review
  --min-confidence high|medium|low Lowest confidence to show and fail on (default high)
  --json <file>                    Save the full report, with evidence, as JSON
  --baseline <report.json>         Compare issues and possible issues with an earlier JSON report
  --scenarios <file>               Also check the page states listed in this JSON file
  --allow-network                  Let the course make internet requests
  --review <file>                  Import a model review (review.json); keep HTML reviews in their bundle folder
  -h, --help                       Show this help

prepare-review options:
  --output <new-directory>         Save the review bundle in this new folder
  --reviewer manual|codex          Run the review with Codex (default), or save a bundle to review yourself
  --model <id>                     Codex model (default gpt-5.6-luna)
  --classifier none|jev            Optional Jev classifier (default none; needs JEV_API_KEY)
  --focus visual|usability         PDF: what the model review looks at (default visual)
  --pages <list>                   PDF: pages to review, such as 1,3
  --audience <text>                PDF: who the document is for
  --use <text>                     PDF: how people will use the document

PDF options:
  --review-bundle <manifest.json>  The bundle manifest for a --review; newer PDF reviews need it
  --design-evidence                Add measured design facts and close-up crops
  --min-text-size-pt <number>      Smallest allowed text size; needs --design-evidence
  --min-image-ppi <number>         Flag images below this resolution
  --max-sparse-words <number>      Flag pages with this many words or fewer
  --paper-size A4|Letter           Flag pages of a different size, in either orientation
  --pdfua ua1|ua2|off              PDF/UA profile to validate (default ua1; needs veraPDF)
  --verapdf <path>                 Path to the veraPDF program

screen-reader options:
  --page <html>                    macOS: page to open
  --control <name>                 macOS: VoiceOver name of the control to activate
  --expected <phrase>              macOS: phrase VoiceOver should say after activation
  --journey <file.json>            Windows: NVDA keyboard journey to run
  --output <new-directory>         Windows: save the journey's JSON and Markdown evidence in this new folder
  --take-screen-control            Confirm that the screen reader and browser may take over the keyboard and screen

check --tier inference needs --review and runs no automated checks.
check --review without --tier runs automated checks and imports the review.
prepare-review prints Markdown evidence for HTML. Add --output to also save a review bundle.
prepare-review for a PDF saves a bundle of page images, facts and review instructions.
screen-reader runs VoiceOver actions on macOS and NVDA journeys on Windows, and never runs during check or prepare-review.
A VoiceOver action prints Markdown evidence. An NVDA journey saves JSON and Markdown evidence in --output.`;

interface CommonOptions extends SelectionOptions {
	target: string;
	allowNetwork: boolean;
}

interface CheckOptions extends CommonOptions {
	command: "check";
	json?: string;
	baselineFile?: string;
	scenarioFile?: string;
	minConfidence: Confidence;
	reviewFiles: string[];
}

interface ReviewOptions extends CommonOptions, ReviewExecutionOptions {
	command: "prepare-review";
	output?: string;
}

interface ScreenReaderOptions extends CommonOptions {
	command: "screen-reader";
	page?: string;
	control?: string;
	expected?: string;
	journeyFile?: string;
	output?: string;
	takeScreenControl: boolean;
}

type Options = CheckOptions | ReviewOptions | ScreenReaderOptions;

export function parseArgs(args: string[]): Options {
	const command = args[0];
	if ((command !== "check" && command !== "prepare-review" && command !== "screen-reader") || !args[1]) {
		throw new Error(USAGE);
	}

	const common = { target: command === "screen-reader" && /^[a-z][a-z0-9+.-]*:\/\//i.test(args[1]) ? args[1] : resolve(args[1]), allowNetwork: false };
	const options: Options = command === "check"
		? { command, ...common, minConfidence: "high", reviewFiles: [] }
		: command === "screen-reader"
			? { command, ...common, takeScreenControl: false }
			: { command, ...common };
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (options.command !== "screen-reader" && arg === "--checks" && args[i + 1]) { options.checks = parseChecks(args[++i]!).join(","); }
		else if (options.command !== "screen-reader" && arg === "--tier" && args[i + 1]) { options.tier = parseTier(args[++i]!); }
		else if (options.command === "prepare-review" && arg === "--output" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.output = resolve(args[++i]!);
		else if (options.command === "prepare-review" && parseReviewExecutionOption(options, arg!, args[i + 1])) i++;
		else if (options.command === "check" && arg === "--review" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.reviewFiles.push(resolve(args[++i]!));
		else if (arg === "--allow-network") options.allowNetwork = true;
		else if (options.command === "screen-reader" && arg === "--take-screen-control") options.takeScreenControl = true;
		else if (options.command === "screen-reader" && arg === "--page" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.page = args[++i];
		else if (options.command === "screen-reader" && arg === "--control" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.control = args[++i];
		else if (options.command === "screen-reader" && arg === "--expected" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.expected = args[++i];
		else if (options.command === "screen-reader" && arg === "--journey" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.journeyFile = resolve(args[++i]!);
		else if (options.command === "screen-reader" && arg === "--output" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.output = resolve(args[++i]!);
		else if (options.command === "check" && arg === "--min-confidence" && /^(high|medium|low)$/.test(args[i + 1] ?? "")) {
			options.minConfidence = args[++i] as Confidence;
		}
		else if (options.command === "check" && arg === "--json" && args[i + 1] && !args[i + 1]?.startsWith("--")) {
			options.json = resolve(args[++i] as string);
		} else if (options.command === "check" && arg === "--baseline" && args[i + 1] && !args[i + 1]?.startsWith("--")) {
			options.baselineFile = resolve(args[++i] as string);
		} else if (options.command === "check" && arg === "--scenarios" && args[i + 1] && !args[i + 1]?.startsWith("--")) {
			options.scenarioFile = resolve(args[++i] as string);
		} else throw new Error(`unknown or incomplete option: ${arg}`);
	}
	if (options.command === "screen-reader") {
		if (options.journeyFile) {
			if (options.page || options.control || options.expected) throw new Error("--journey cannot be combined with --page, --control, or --expected");
			validateJourneySessionOptions(options);
		} else {
			if (options.output) throw new Error("screen-reader --output requires --journey");
			if (!options.takeScreenControl) {
				throw new Error("screen-reader launches VoiceOver, opens Safari, moves focus, and sends keyboard input. Rerun with --take-screen-control only when interruption is safe.");
			}
			if (!options.allowNetwork) {
				throw new Error("screen-reader uses your existing Safari profile and network connection, which Praxity Check's Playwright network blocker cannot protect. Rerun with --allow-network only for an export you trust.");
			}
			if (!options.page || !options.control || !options.expected) {
				throw new Error("screen-reader requires --page, --control, and --expected");
			}
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(options.target)) throw new Error("VoiceOver screen-reader action requires a folder or ZIP; use --journey for a URL");
		}
	}
	if (options.command !== "screen-reader") validateHtmlSelection(options.command, options);
	if (options.command === "prepare-review") {
		options.reviewer ??= options.tier === "inference" ? "codex" : "manual";
		validateReviewExecutionOptions(options, Boolean(options.output));
	}
	if (options.command === "check") {
		if (options.tier === "inference" && !options.reviewFiles.length) throw new Error("HTML --tier inference requires --review from a prepare-review --output bundle");
		if (options.tier === "deterministic" && options.reviewFiles.length) throw new Error("--tier deterministic cannot import inference reviews; use --tier inference or omit --tier for a combined report");
		if (options.tier === "inference" && (options.baselineFile || options.scenarioFile || options.allowNetwork)) throw new Error("--tier inference only imports saved review evidence, so it cannot use --baseline, --scenarios or --allow-network. Omit --tier to also run automated checks.");
		if (options.reviewFiles.length > 16 || new Set(options.reviewFiles).size !== options.reviewFiles.length) throw new Error("Use at most 16 distinct HTML reviews");
	}
	return options;
}

function inferenceSummary(report: AuditReport) {
	return (report.inferenceReviews ?? []).flatMap((review) => review.findings.flatMap((item) => [
		`${item.category === "observed-defect" ? "Issue" : item.category === "needs-context" ? "Question" : "Suggestion"} from ${review.reviewer.model}: ${item.message}`,
		`  Page: ${item.location.page}`, `  Element: ${item.location.selector}`,
		`  Consequence: ${item.consequence}`, `  Change: ${item.action}`, `  Verify: ${item.verification}`,
	])).join("\n");
}

async function writeReport(path: string, report: unknown, protectedPaths: string[]) {
	await assertOutputOutside(path, protectedPaths);
	const temporary = await mkdtemp(resolve(dirname(path), ".praxity-check-report-"));
	try {
		const pending = resolve(temporary, "report.json");
		await writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		await assertOutputOutside(path, protectedPaths);
		await rename(pending, path);
	} finally { await rm(temporary, { recursive: true, force: true }); }
}

/**
 * Exit codes:
 * 0 — ran clean, no high-confidence findings
 * 1 — ran, high-confidence findings present
 * 2 — could not run (bad input, unsafe archive, browser launch failure, or every page failed triage)
 */
export async function htmlCli(args: string[]): Promise<number> {
	if ([args[0], args[1]].some((arg) => arg === "--help" || arg === "-h") || args[0] === "help") {
		console.log(USAGE);
		return 0;
	}
	let input: Input | undefined;
	let server: StaticServer | undefined;
	try {
		const options = parseArgs(args);
		if (options.command === "screen-reader" && options.journeyFile) {
			await assertOutputOutside(options.output!, [options.journeyFile]);
			const journey = JSON.parse(await readFile(options.journeyFile, "utf8")) as unknown;
			const result = await runScreenReaderJourney({ target: options.target, journey, output: options.output!, takeScreenControl: options.takeScreenControl, allowNetwork: options.allowNetwork });
			console.log(`NVDA journey JSON: ${result.jsonPath}\nNVDA journey Markdown: ${result.markdownPath}`);
			return result.exitCode;
		}
		const baseline = options.command === "check" && options.baselineFile
			? parseBaseline(JSON.parse(await readFile(options.baselineFile, "utf8")) as unknown)
			: undefined;
		if (options.command === "screen-reader") {
			console.error("praxity-check: starting VoiceOver and Safari. They control the keyboard and screen until the test ends.");
		}
		const selection = options.command === "screen-reader" ? undefined : validateHtmlSelection(options.command, options);
		const revisionBound = Boolean(options.command === "prepare-review" && options.output || options.command === "check" && options.reviewFiles.length);
		const protectedTarget = revisionBound || !(await stat(options.target)).isDirectory() ? [options.target] : [];
		const protectedPaths = [...protectedTarget, ...(options.command === "check" ? [...options.reviewFiles.map(dirname), ...(options.baselineFile ? [options.baselineFile] : []), ...(options.scenarioFile ? [options.scenarioFile] : [])] : [])];
		if (options.command === "check" && options.json) await assertOutputOutside(options.json, protectedPaths);
		if (options.command === "prepare-review" && options.output) await assertOutputOutside(options.output, protectedPaths);
		const snapshot = revisionBound ? await snapshotInput(options.target) : undefined;
		input = snapshot ?? await openInput(options.target);
		server = await serve(input.root);
		const auditOrigin = server.origin;
		const discovery = await discover(input.root, auditOrigin);
		const reviews = options.command === "check" && snapshot ? await Promise.all(options.reviewFiles.map((file) => importHtmlReview(file, snapshot.contentSha256, discovery))) : [];
		if (options.command === "check" && selection?.tier === "inference") {
			const report = createReport(options.target, input.wasZip, discovery, discovery.pages.map((page) => ({ page, audited: false, triage: { ok: true }, findings: [], notes: [] })), [], false, {
				runtime: { name: "node", version: process.version }, browser: null, viewport: null, colorScheme: null,
			}, []);
			report.selection = selection;
			report.contentSha256 = snapshot!.contentSha256;
			report.inferenceReviews = reviews;
			report.feedback = htmlFeedback(report);
			console.log(`Imported ${reviews.length} model ${reviews.length === 1 ? "review" : "reviews"}. Automated checks did not run because --tier inference was selected.
The model reported ${[["issue", report.feedback.findings.length], ["question", report.feedback.questions.length], ["suggestion", report.feedback.suggestions.length]].map(([noun, n]) => `${n} ${noun}${n === 1 ? "" : "s"}`).join(", ").replace(/, ([^,]*)$/, " and $1")}. Model results never change the exit code.`);
			console.log(inferenceSummary(report));
			if (options.json) await writeReport(options.json, report, protectedPaths);
			return 0;
		}
		const scenarios = options.command === "check" && options.scenarioFile
			? await loadScenarios(options.scenarioFile)
			: [];
		const knownPages = new Set(discovery.pages.map((page) => page.file));
		const missingScenario = scenarios.find((scenario) => !knownPages.has(scenario.page));
		if (missingScenario) {
			throw new Error(`scenario ${JSON.stringify(missingScenario.id)} refers to unknown page ${JSON.stringify(missingScenario.page)}`);
		}
		if (options.command === "screen-reader") {
			const page = resolveScreenReaderPage(discovery.pages, auditOrigin, options.page as string);
			console.log(await runScreenReader({
				page,
				control: options.control as string,
				expected: options.expected as string,
			}));
			return 0;
		}
		if (options.command === "prepare-review") {
			const packet = await withAuditContext({ auditOrigin, allowNetwork: options.allowNetwork },
				(context, blockedRequests) => prepareInteractionReview(context, discovery.pages, blockedRequests, basename(options.target)));
			console.log(packet.markdown);
			if (options.output && snapshot) {
				const result = await writeHtmlReviewBundle(options.output, options.target, snapshot.contentSha256, packet, options.allowNetwork);
				if (options.classifier === "jev" || options.reviewer === "codex") {
					const { evidence } = await readHtmlReviewBundle(join(result.directory, "review.json"), snapshot.contentSha256, discovery);
					await runPreparedReview(result.directory, options, { kind: "html", sourceSha256: result.manifest.evidenceSha256, items: evidence.candidates.map(candidate => ({ id: candidate.id, text: candidate.dom.html })) }, path => importHtmlReview(path, snapshot.contentSha256, discovery));
				}
				console.error(`Review bundle saved to ${result.directory}. ${options.reviewer === "codex" ? "Its review.json is ready to import with check --review." : "Follow review-prompt.md, then save the result as review.json in the same folder."}`);
			}
			return packet.auditedPages > 0 ? 0 : 2;
		}

		const { pages, blockedRequests, environment } = await auditHtml({ pages: discovery.pages, scenarios, auditOrigin, allowNetwork: options.allowNetwork });
		const report = createReport(
			options.target,
			input.wasZip,
			discovery,
			pages,
			blockedRequests,
			options.allowNetwork,
			{
				runtime: { name: "node", version: process.version },
				...environment,
			},
			scenarios,
			baseline,
		);
		report.selection = selection;
		if (snapshot) report.contentSha256 = snapshot.contentSha256;
		if (reviews.length) {
			report.inferenceReviews = reviews;
			report.notes.push("Ran automated checks and imported model reviews. Only automated check results change the exit code.");
		}
		report.feedback = htmlFeedback(report);
		console.log(humanSummary(report, options.minConfidence, options.json));
		if (reviews.length) console.log(inferenceSummary(report));
		if (options.json) await writeReport(options.json, report, protectedPaths);
		if (pages.length === 0 || pages.every((page) => !page.triage.ok)) return 2;
		return countAtOrAbove(report, options.minConfidence) > 0 ? 1 : 0;
	} catch (error) {
		console.error(`praxity-check: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	} finally {
		await server?.close().catch(() => {});
		await input?.cleanup().catch(() => {});
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	process.exitCode = await htmlCli(process.argv.slice(2));
}
