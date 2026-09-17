#!/usr/bin/env node

import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
	altTextQuality,
	audioAutoplay,
	darkSchemeVisuals,
	focusIndicators,
	focusNotObscured,
	interactionChecks,
	instrumentShadowRoots,
	keyboardWalk,
	keyboardScrollableRegions,
	linkTextQuality,
	localResources,
	nonTextContrast,
	pauseStopHide,
	reflow,
	runAxe,
	scopeCoverage,
	stateContrast,
	textScale,
	textSpacing,
	settle,
	triage,
	type CheckResult,
} from "./checks.ts";
import { discover } from "./discover.ts";
import { assertOutputOutside, openInput, snapshotInput, type Input } from "./input.ts";
import { countAtOrAbove, createReport, humanSummary, parseBaseline, type BlockedRequest, type Confidence, type PageAudit, type AuditReport } from "./report.ts";
import { resolveScreenReaderPage, runScreenReader } from "./screen-reader.ts";
import { isAuditServerUrl, serve, type StaticServer } from "./serve.ts";
import { htmlFeedback } from "./feedback.ts";
import { importHtmlReview, writeHtmlReviewBundle } from "./html-review.ts";
import { prepareInteractionReview } from "./interaction-review.ts";
import { loadScenarios, runScenarioActions, type Scenario } from "./scenarios.ts";

import { parseChecks, parseTier, validateHtmlSelection, type SelectionOptions } from "./selection.ts";

const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 10_000;
const PAGE_AUDIT_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 720 } as const;
const USAGE = `Usage:
  praxity-check check <folder|zip|pdf> [options]
  praxity-check compare-pdf <before.json> <after.json> [--json]
  praxity-check prepare-review <folder|zip> [--allow-network] [--output <new-directory>]
  praxity-check prepare-review <pdf> --tier inference --checks accessibility|design [--focus visual|usability] [--output <new-directory>] [--pages 1,3] [--audience <text>] [--use <text>]
  praxity-check screen-reader <folder|zip> --page <html> --control <name> --expected <phrase> --take-screen-control --allow-network

Options:
  --checks accessibility|design|accessibility,design  Select independent check domains
  --tier deterministic|inference        Select the evidence method
  --focus visual|usability              PDF inference review focus (default visual)
  --design-evidence                    PDF: add measured design facts and detail crops
  --min-text-size-pt <number>           PDF: explicit requirement for all extracted text; requires --design-evidence
  --json <file>                         Write the complete JSON report
  --min-image-ppi <number>              PDF: review rasters below an explicit PPI threshold
  --max-sparse-words <number>          PDF: review sparse pages using this word-count threshold
  --review <file>                     Import model review JSON; HTML reviews stay beside their manifest and evidence
  --paper-size A4|Letter                PDF: require this MediaBox size, either orientation
  --pdfua <ua1|ua2|off>    PDF/UA machine profile, default ua1 (requires veraPDF)
  --verapdf <path>         Path to the veraPDF executable
  --baseline <report.json>              Compare exact occurrences with a prior report
  --scenarios <file>                    Scan named rendered states from JSON
  --allow-network                       Allow the audited package to use the network
  --min-confidence high|medium|low      Reporting and exit threshold (default: high)
  --page <html>                         Page for the screen-reader action
  --control <name>                      VoiceOver control name to find and activate
  --expected <phrase>                   Phrase expected after activation
  --take-screen-control                 Allow VoiceOver, Safari, focus, and keyboard control
  -h, --help                            Show this help

HTML prepare-review writes Markdown to stdout; --output also writes a private importable bundle.
HTML check --tier inference requires --review and runs no deterministic checks.
Omitting --tier with --review runs deterministic checks plus imported model observations.
screen-reader writes Markdown evidence to stdout.
PDF prepare-review writes a private bundle of page images, facts and review instructions.
screen-reader is macOS-only, disruptive, and never runs as part of check or prepare-review.`;

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

interface ReviewOptions extends CommonOptions {
	command: "prepare-review";
	output?: string;
}

interface ScreenReaderOptions extends CommonOptions {
	command: "screen-reader";
	page?: string;
	control?: string;
	expected?: string;
	takeScreenControl: boolean;
}

type Options = CheckOptions | ReviewOptions | ScreenReaderOptions;

function parseArgs(args: string[]): Options {
	const command = args[0];
	if ((command !== "check" && command !== "prepare-review" && command !== "screen-reader") || !args[1]) {
		throw new Error(USAGE);
	}

	const common = { target: resolve(args[1]), allowNetwork: false };
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
		else if (options.command === "check" && arg === "--review" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.reviewFiles.push(resolve(args[++i]!));
		else if (arg === "--allow-network") options.allowNetwork = true;
		else if (options.command === "screen-reader" && arg === "--take-screen-control") options.takeScreenControl = true;
		else if (options.command === "screen-reader" && arg === "--page" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.page = args[++i];
		else if (options.command === "screen-reader" && arg === "--control" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.control = args[++i];
		else if (options.command === "screen-reader" && arg === "--expected" && args[i + 1] && !args[i + 1]?.startsWith("--")) options.expected = args[++i];
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
		if (!options.takeScreenControl) {
			throw new Error("screen-reader launches VoiceOver, opens Safari, moves focus, and sends keyboard input. Rerun with --take-screen-control only when interruption is safe.");
		}
		if (!options.allowNetwork) {
			throw new Error("screen-reader uses your existing Safari profile and network connection, which Praxity Check's Playwright network blocker cannot protect. Rerun with --allow-network only for an export you trust.");
		}
		if (!options.page || !options.control || !options.expected) {
			throw new Error("screen-reader requires --page, --control, and --expected");
		}
	}
	if (options.command !== "screen-reader") validateHtmlSelection(options.command, options);
	if (options.command === "check") {
		if (options.tier === "inference" && !options.reviewFiles.length) throw new Error("HTML --tier inference requires --review from a prepare-review --output bundle");
		if (options.tier === "deterministic" && options.reviewFiles.length) throw new Error("--tier deterministic cannot import inference reviews; use --tier inference or omit --tier for a combined report");
		if (options.tier === "inference" && (options.baselineFile || options.scenarioFile || options.allowNetwork)) throw new Error("HTML inference import uses retained evidence; --baseline, --scenarios and --allow-network require a deterministic run");
		if (options.reviewFiles.length > 16 || new Set(options.reviewFiles).size !== options.reviewFiles.length) throw new Error("Use at most 16 distinct HTML reviews");
	}
	return options;
}

function inferenceSummary(report: AuditReport) {
	return (report.inferenceReviews ?? []).flatMap((review) => review.findings.flatMap((item) => [
		`${item.category === "observed-defect" ? "Model observation" : item.category === "needs-context" ? "Question" : "Suggestion"} (${review.reviewer.model}): ${item.message}`,
		`  Location: ${item.location.page}, ${item.location.selector}`,
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

async function withPageTimeout<T>(page: Page, run: () => Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			void page.close();
			reject(new Error(`page audit exceeded ${PAGE_AUDIT_TIMEOUT_MS / 1000}s`));
		}, PAGE_AUDIT_TIMEOUT_MS);
	});
	try {
		return await Promise.race([run(), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Each check is isolated. One evaluate exception used to escape here, unwind
 * auditPages and discard every page already audited along with the JSON -- a
 * whole package report lost to one malformed element. A check that fails is
 * recorded as not run, which is materially different from a check that ran and
 * found nothing.
 */
async function runChecks(page: Page, pageId: string): Promise<CheckResult> {
	// Order matters: motion must be observed before anything interacts with the
	// page, and the last group mutates the viewport or document, so it runs after
	// every check that reads the natural page state.
	const natural = [
		pauseStopHide, audioAutoplay, runAxe, scopeCoverage, interactionChecks,
		keyboardWalk, altTextQuality, linkTextQuality, localResources,
		keyboardScrollableRegions, focusNotObscured, nonTextContrast,
		stateContrast, focusIndicators,
	] as const;
	const mutating = [reflow, textScale, textSpacing] as const;

	const findings: CheckResult["findings"] = [];
	const needsReview: NonNullable<CheckResult["needsReview"]> = [];
	const notes: string[] = [];
	const evaluations: NonNullable<CheckResult["evaluations"]> = [];
	const rules = new Map<string, NonNullable<CheckResult["rules"]>[number]>();
	const untested: NonNullable<CheckResult["untested"]> = [];
	const run = async (check: (page: Page, pageId: string) => Promise<CheckResult>, newVariantsOnly = false) => {
		try {
			const result = await check(page, pageId);
			const findingKeys = new Set(findings.map((item) => `${item.rule}\0${item.selector ?? ""}`));
			const reviewKeys = new Set(needsReview.map((item) => `${item.rule}\0${item.selector ?? ""}`));
			findings.push(...result.findings.filter((item) =>
				!newVariantsOnly || !findingKeys.has(`${item.rule}\0${item.selector ?? ""}`)));
			needsReview.push(...(result.needsReview ?? []).filter((item) =>
				!newVariantsOnly || !reviewKeys.has(`${item.rule}\0${item.selector ?? ""}`)));
			notes.push(...result.notes);
			evaluations.push(...(result.evaluations ?? []));
			for (const rule of result.rules ?? []) rules.set(`${rule.id}\0${rule.rulesetVersion}`, rule);
			untested.push(...(result.untested ?? []));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			untested.push({
				type: "check",
				check: check.name,
				page: pageId,
				state: check === darkSchemeVisuals ? "dark" : "initial",
				outcome: "untested",
				reason,
			});
			notes.push(
				`${check.name} did not run on ${pageId}: ${reason} — treat as unchecked, not as clean`,
			);
		}
	};
	const checks: Array<{
		check: (page: Page, pageId: string) => Promise<CheckResult>;
		newVariantsOnly?: boolean;
	}> = [
		...natural.map((check) => ({ check })),
		{ check: darkSchemeVisuals, newVariantsOnly: true },
		...mutating.map((check) => ({ check })),
	];
	for (let index = 0; index < checks.length; index++) {
		const current = checks[index];
		if (!current) continue;
		if (page.isClosed()) {
			for (const remaining of checks.slice(index)) {
				untested.push({
					type: "check",
					check: remaining.check.name,
					page: pageId,
					state: remaining.check === darkSchemeVisuals ? "dark" : "initial",
					outcome: "untested",
					reason: "page closed before check ran",
				});
			}
			break;
		}
		await run(current.check, current.newVariantsOnly);
	}
	return { findings, needsReview, notes, evaluations, rules: [...rules.values()], untested };
}

async function auditPages(
	context: BrowserContext,
	pages: Awaited<ReturnType<typeof discover>>["pages"],
	blockedRequests: BlockedRequest[],
	scenarios: Scenario[],
): Promise<PageAudit[]> {
	const audits: PageAudit[] = [];
	for (const discoveredPage of pages) {
		const blockedBefore = blockedRequests.length;
		const page = await context.newPage();
		try {
			let response;
			try {
				response = await page.goto(discoveredPage.url, {
					waitUntil: "load",
					timeout: NAVIGATION_TIMEOUT_MS,
				});
			} catch (error) {
				const reason = `navigation failed: ${error instanceof Error ? error.message : String(error)}`;
				audits.push({
					page: discoveredPage,
					triage: { ok: false, reason },
					audited: false,
					findings: [],
					notes: [],
					untested: [{
						type: "check",
						check: "page-audit",
						page: discoveredPage.file,
						state: "initial",
						outcome: "untested",
						reason,
					}],
				});
				continue;
			}

			const settleNote = await settle(page);
			const verdict = await triage(page, response?.status() ?? null, blockedRequests.length - blockedBefore);
			if (!verdict.ok) {
				audits.push({
					page: discoveredPage,
					triage: verdict,
					audited: false,
					findings: [],
					notes: settleNote ? [settleNote] : [],
					untested: [{
						type: "check",
						check: "page-audit",
						page: discoveredPage.file,
						state: "initial",
						outcome: "untested",
						reason: verdict.reason ?? "page triage failed",
					}],
				});
				continue;
			}

			const title = await page.title();
			let result: CheckResult;
			try {
				result = await withPageTimeout(page, () => runChecks(page, discoveredPage.file));
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				audits.push({
					page: discoveredPage,
					triage: { ok: false, reason },
					audited: false,
					title,
					findings: [],
					notes: settleNote ? [settleNote] : [],
					untested: [{
						type: "check",
						check: "page-audit",
						page: discoveredPage.file,
						state: "initial",
						outcome: "untested",
						reason,
					}],
				});
				continue;
			}
			const stateResults = [result];
			for (const scenario of scenarios.filter((candidate) => candidate.page === discoveredPage.file)) {
				const statePage = await context.newPage();
				try {
					const blockedBeforeState = blockedRequests.length;
					const response = await statePage.goto(discoveredPage.url, {
						waitUntil: "load",
						timeout: NAVIGATION_TIMEOUT_MS,
					});
					const settleNote = await settle(statePage);
					const stateVerdict = await triage(
						statePage,
						response?.status() ?? null,
						blockedRequests.length - blockedBeforeState,
					);
					if (!stateVerdict.ok) throw new Error(stateVerdict.reason ?? "page triage failed");
					await runScenarioActions(statePage, scenario);
					const stateResult = await withPageTimeout(statePage, () => runChecks(statePage, discoveredPage.file));
					stateResults.push({
						findings: stateResult.findings.map((item) => ({ ...item, state: scenario.id })),
						needsReview: (stateResult.needsReview ?? []).map((item) => ({ ...item, state: scenario.id })),
						notes: [
							...(settleNote ? [`state ${scenario.id}: ${settleNote}`] : []),
							...stateResult.notes.map((note) => `state ${scenario.id}: ${note}`),
						],
						evaluations: (stateResult.evaluations ?? []).map((evaluation) => ({ ...evaluation, state: scenario.id })),
						rules: stateResult.rules,
						untested: (stateResult.untested ?? []).map((evaluation) => ({ ...evaluation, state: scenario.id })),
					});
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					stateResults.push({
						findings: [],
						notes: [`state ${scenario.id} did not run on ${discoveredPage.file}: ${reason} — treat as unchecked, not as clean`],
						untested: [{
							type: "check",
							check: `scenario:${scenario.id}`,
							page: discoveredPage.file,
							state: scenario.id,
							outcome: "untested",
							reason,
						}],
					});
				} finally {
					if (!statePage.isClosed()) await statePage.close();
				}
			}
			const combined: CheckResult = {
				findings: stateResults.flatMap((state) => state.findings),
				needsReview: stateResults.flatMap((state) => state.needsReview ?? []),
				notes: stateResults.flatMap((state) => state.notes),
				evaluations: stateResults.flatMap((state) => state.evaluations ?? []),
				rules: stateResults.flatMap((state) => state.rules ?? []),
				untested: stateResults.flatMap((state) => state.untested ?? []),
			};
			audits.push({
				page: discoveredPage,
				triage: verdict,
				audited: true,
				title,
				findings: combined.findings,
				needsReview: combined.needsReview,
				notes: settleNote ? [settleNote, ...combined.notes] : combined.notes,
				evaluations: combined.evaluations,
				rules: combined.rules,
				untested: combined.untested,
			});
		} finally {
			if (!page.isClosed()) await page.close();
		}
	}
	return audits;
}

/**
 * Exit codes:
 * 0 — ran clean, no high-confidence findings
 * 1 — ran, high-confidence findings present
 * 2 — could not run (bad input, unsafe archive, browser launch failure, or every page failed triage)
 */
async function main(args: string[]): Promise<number> {
	if ([args[0], args[1]].some((arg) => arg === "--help" || arg === "-h") || args[0] === "help") {
		console.log(USAGE);
		return 0;
	}
	let input: Input | undefined;
	let server: StaticServer | undefined;
	let browser: Browser | undefined;
	try {
		const options = parseArgs(args);
		const baseline = options.command === "check" && options.baselineFile
			? parseBaseline(JSON.parse(await readFile(options.baselineFile, "utf8")) as unknown)
			: undefined;
		if (options.command === "screen-reader") {
			console.error("praxity-check: starting an acknowledged disruptive session; VoiceOver and Safari will take keyboard and screen focus");
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
			console.log(`Imported ${reviews.length} HTML accessibility ${reviews.length === 1 ? "review" : "reviews"}. Deterministic checks were not selected.
${report.feedback.findings.length} model observations, ${report.feedback.questions.length} questions, ${report.feedback.suggestions.length} suggestions. These do not affect the deterministic failure exit code.`);
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
		// Auditing author intent requires a browser that does not silently suppress
		// autoplay before the 1.4.2 probe can observe it.
		browser = await chromium.launch({
			timeout: NAVIGATION_TIMEOUT_MS,
			args: ["--autoplay-policy=no-user-gesture-required"],
		});
		// A fresh context has no registrations to clear; blocking service workers
		// also prevents the package from installing one during the run (spec §4).
		const context = await browser.newContext({
			serviceWorkers: "block",
			viewport: VIEWPORT,
			colorScheme: "light",
		});
		await instrumentShadowRoots(context);
		context.setDefaultTimeout(ACTION_TIMEOUT_MS);
		context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

		const blockedRequests: BlockedRequest[] = [];
		if (!options.allowNetwork) {
			await context.route("**/*", async (route) => {
				const request = route.request();
				if (isAuditServerUrl(request.url(), auditOrigin)) {
					await route.continue();
					return;
				}
				blockedRequests.push({
					url: request.url(),
					method: request.method(),
					resourceType: request.resourceType(),
				});
				await route.abort("blockedbyclient");
			});
			await context.routeWebSocket(/.*/, async (socket) => {
				if (isAuditServerUrl(socket.url(), auditOrigin)) {
					socket.connectToServer();
					return;
				}
				blockedRequests.push({ url: socket.url(), method: "WEBSOCKET", resourceType: "websocket" });
				await socket.close({ code: 1008, reason: "outbound network blocked by praxity-check" });
			});
		}
		if (options.command === "prepare-review") {
			const packet = await prepareInteractionReview(context, discovery.pages, blockedRequests, basename(options.target));
			console.log(packet.markdown);
			if (options.output && snapshot) {
				const result = await writeHtmlReviewBundle(options.output, options.target, snapshot.contentSha256, packet, options.allowNetwork);
				console.error(`HTML review bundle: ${result.directory}. Read review-prompt.md and save review.json beside manifest.json and evidence.json.`);
			}
			return packet.auditedPages > 0 ? 0 : 2;
		}

		const pages = await auditPages(context, discovery.pages, blockedRequests, scenarios);
		const report = createReport(
			options.target,
			input.wasZip,
			discovery,
			pages,
			blockedRequests,
			options.allowNetwork,
			{
				runtime: { name: "node", version: process.version },
				browser: { engine: "chromium", version: browser.version() },
				viewport: VIEWPORT,
				colorScheme: "light",
			},
			scenarios,
			baseline,
		);
		report.selection = selection;
		if (snapshot) report.contentSha256 = snapshot.contentSha256;
		if (reviews.length) {
			report.inferenceReviews = reviews;
			report.notes.push("The tier was omitted. Deterministic checks ran alongside imported model observations; only deterministic findings affect the failure exit code.");
		}
		report.feedback = htmlFeedback(report);
		console.log(humanSummary(report, options.minConfidence));
		if (reviews.length) console.log(inferenceSummary(report));
		if (options.json) await writeReport(options.json, report, protectedPaths);
		if (pages.length === 0 || pages.every((page) => !page.triage.ok)) return 2;
		return countAtOrAbove(report, options.minConfidence) > 0 ? 1 : 0;
	} catch (error) {
		console.error(`praxity-check: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	} finally {
		await browser?.close().catch(() => {});
		await server?.close().catch(() => {});
		await input?.cleanup().catch(() => {});
	}
}

process.exitCode = await main(process.argv.slice(2));
