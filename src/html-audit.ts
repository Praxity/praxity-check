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
import type { DiscoveredPage } from "./discover.ts";
import type { AuditEnvironment, BlockedRequest, PageAudit } from "./report.ts";
import { runScenarioActions, type Scenario } from "./scenarios.ts";
import { isAuditServerUrl } from "./serve.ts";

const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 10_000;
const PAGE_AUDIT_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 720 } as const;

export interface HtmlAuditOptions {
	pages: DiscoveredPage[];
	scenarios: Scenario[];
	auditOrigin: string;
	allowNetwork: boolean;
}

export interface HtmlAuditResult {
	pages: PageAudit[];
	blockedRequests: BlockedRequest[];
	environment: Omit<AuditEnvironment, "runtime">;
}

/**
 * Audit discovered pages and declared states. The interface gives tests leverage
 * over whole audits. The module's depth hides browser settings, check order,
 * context lifetimes and time limits; probe restoration keeps its locality in
 * checks.ts. Returns page results, blocked requests and the browser version,
 * viewport and colour scheme.
 *
 * A failed check retains earlier check results and records unchecked coverage.
 * Initial navigation or triage failure retains an unaudited page with no findings.
 * The 60s limit covers checks only, after settling, triage and title retrieval.
 * An initial page timeout discards results already gathered for that page and
 * retains only its title, settling note and a page-audit unchecked record. Declared
 * states are then skipped. A scenario page creation, navigation, settling, triage,
 * action or check-run failure records that state as unchecked, discards its
 * gathered results and keeps earlier states. Successful states concatenate their
 * results without deduplication.
 *
 * Browser launch, initial context or page creation, initial settling, triage and
 * title retrieval, scenario-context creation and page or scenario-context cleanup
 * failures reject the audit. They do not return partial results, including results
 * from earlier pages or states. Browser-close failures do not replace the outcome.
 */
export async function auditHtml(options: HtmlAuditOptions): Promise<HtmlAuditResult> {
	return withAuditBrowser(async (browser, blockedRequests) => ({
		pages: await auditPages(browser, options.pages, blockedRequests, options.scenarios, options.auditOrigin, options.allowNetwork),
		blockedRequests,
		environment: {
			browser: { engine: "chromium", version: browser.version() },
			viewport: VIEWPORT,
			colorScheme: "light",
		},
	}));
}

/**
 * Borrow a context with the audit's launch settings and network policy for the
 * callback's lifetime. This seam gives prepare-review the same policy without
 * exposing check execution. The module closes the browser when the callback
 * finishes; launch, context creation and callback failures reject unchanged.
 */
export async function withAuditContext<T>(
	options: Pick<HtmlAuditOptions, "auditOrigin" | "allowNetwork">,
	run: (context: BrowserContext, blockedRequests: BlockedRequest[]) => Promise<T>,
): Promise<T> {
	return withAuditBrowser(async (browser, blockedRequests) => {
		const context = await createAuditContext(browser, options.auditOrigin, options.allowNetwork, blockedRequests);
		return run(context, blockedRequests);
	});
}

async function withAuditBrowser<T>(run: (browser: Browser, blockedRequests: BlockedRequest[]) => Promise<T>): Promise<T> {
	// Auditing author intent requires a browser that does not silently suppress
	// autoplay before the 1.4.2 probe can observe it.
	const browser = await chromium.launch({
		timeout: NAVIGATION_TIMEOUT_MS,
		args: ["--autoplay-policy=no-user-gesture-required"],
	});
	try {
		return await run(browser, []);
	} finally {
		// Preserve the CLI's outcome when browser cleanup fails.
		await browser.close().catch(() => {});
	}
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

async function createAuditContext(
	browser: Browser,
	auditOrigin: string,
	allowNetwork: boolean,
	blockedRequests: BlockedRequest[],
) {
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
	if (!allowNetwork) {
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
	return context;
}

async function auditPages(
	browser: Browser,
	pages: DiscoveredPage[],
	blockedRequests: BlockedRequest[],
	scenarios: Scenario[],
	auditOrigin: string,
	allowNetwork: boolean,
): Promise<PageAudit[]> {
	const context = await createAuditContext(browser, auditOrigin, allowNetwork, blockedRequests);
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
					notes: settleNote ? [`${discoveredPage.file}: ${settleNote}`] : [],
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
					notes: settleNote ? [`${discoveredPage.file}: ${settleNote}`] : [],
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
				const stateContext = await createAuditContext(browser, auditOrigin, allowNetwork, blockedRequests);
				try {
					const statePage = await stateContext.newPage();
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
							...(settleNote ? [`${discoveredPage.file}, state ${scenario.id}: ${settleNote}`] : []),
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
						notes: [`state ${scenario.id} did not run on ${discoveredPage.file}: ${reason}. Treat it as not run, not as passed.`],
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
					await stateContext.close();
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
				notes: settleNote ? [`${discoveredPage.file}: ${settleNote}`, ...combined.notes] : combined.notes,
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
