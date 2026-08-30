#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
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
import { openInput, type Input } from "./input.ts";
import { countAtOrAbove, createReport, humanSummary, parseBaseline, type BlockedRequest, type Confidence, type PageAudit } from "./report.ts";
import { resolveScreenReaderPage, runScreenReader } from "./screen-reader.ts";
import { isAuditServerUrl, serve, type StaticServer } from "./serve.ts";
import { prepareInteractionReview } from "./interaction-review.ts";
import { loadScenarios, runScenarioActions, type Scenario } from "./scenarios.ts";

const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 10_000;
const PAGE_AUDIT_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 720 } as const;
const USAGE = `Usage:
  praxity-check check <folder|zip> [options]
  praxity-check prepare-review <folder|zip> [--allow-network]
  praxity-check screen-reader <folder|zip> --page <html> --control <name> --expected <phrase> --take-screen-control --allow-network

Options:
  --json <file>                         Write the complete JSON report
  --baseline <report.json>              Compare exact occurrences with a prior report
  --scenarios <file>                    Scan named rendered states from JSON
  --allow-network                       Allow the audited package to use the network
  --min-confidence high|medium|low      Reporting and exit threshold (default: high)
  --page <html>                         Page for the screen-reader action
  --control <name>                      VoiceOver control name to find and activate
  --expected <phrase>                   Phrase expected after activation
  --take-screen-control                 Allow VoiceOver, Safari, focus, and keyboard control
  -h, --help                            Show this help

prepare-review and screen-reader write Markdown evidence to stdout.
screen-reader is macOS-only, disruptive, and never runs as part of check or prepare-review.`;

interface CommonOptions {
	target: string;
	allowNetwork: boolean;
}

interface CheckOptions extends CommonOptions {
	command: "check";
	json?: string;
	baselineFile?: string;
	scenarioFile?: string;
	minConfidence: Confidence;
}

interface ReviewOptions extends CommonOptions {
	command: "prepare-review";
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
		? { command, ...common, minConfidence: "high" }
		: command === "screen-reader"
			? { command, ...common, takeScreenControl: false }
			: { command, ...common };
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--allow-network") options.allowNetwork = true;
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
	return options;
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
		input = await openInput(options.target);
		server = await serve(input.root);
		const auditOrigin = server.origin;
		const discovery = await discover(input.root, auditOrigin);
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
		console.log(humanSummary(report, options.minConfidence));
		if (options.json) await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
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
