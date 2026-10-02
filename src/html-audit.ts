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
 * Audit discovered pages and declared states. The interface lets tests exercise
 * whole audits. The module's depth hides browser settings, check order,
 * context lifetimes and time limits; probe restoration keeps its locality in
 * checks.ts. Returns page results, blocked requests and the browser version,
 * viewport and colour scheme.
 *
 * A failed check retains earlier check results and records unchecked coverage.
 * The 60s limit covers checks only, after settling, triage and title retrieval.
 * A timeout retains completed checks' findings, review items, notes, evaluations
 * and rules; every unfinished check is recorded as unchecked with the timeout
 * reason. The page remains audited. After an initial timeout, declared states
 * are recorded as unchecked and skipped. Scenario timeouts also retain completed
 * checks and allow later states to run. States concatenate their results without
 * deduplication.
 *
 * Initial page creation, navigation, settling, triage or title retrieval failure
 * retains an unaudited page with no findings and records skipped declared states.
 * Scenario context or page creation, navigation, settling, triage or action failure
 * records that state as unchecked. Earlier evidence survives and later pages and
 * states continue. Page and context cleanup failures become notes, preserving the
 * evidence. Only browser launch and initial context creation failures reject the
 * audit. Browser-close failures do not replace the outcome.
 */
export async function auditHtml(
	options: HtmlAuditOptions,
	/** @internal Tests shorten the check deadline without changing production options. */
	testOptions: { pageAuditTimeoutMs?: number } = {},
): Promise<HtmlAuditResult> {
	return withAuditBrowser(async (browser, blockedRequests) => ({
		pages: await auditPages(browser, options.pages, blockedRequests, options.scenarios, options.auditOrigin, options.allowNetwork, testOptions.pageAuditTimeoutMs ?? PAGE_AUDIT_TIMEOUT_MS),
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

/**
 * Each check is isolated. One evaluate exception used to escape here, unwind
 * auditPages and discard every page already audited along with the JSON -- a
 * whole package report lost to one malformed element. A check that fails is
 * recorded as not run, which is materially different from a check that ran and
 * found nothing.
 */
async function runChecks(page: Page, pageId: string, timeoutMs: number): Promise<{ result: CheckResult; timedOut: boolean }> {
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
	let timedOut = false;
	let timer: NodeJS.Timeout | undefined;
	const timeoutError = new Error(`page audit exceeded ${timeoutMs / 1000}s`);
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(timeoutError);
		}, timeoutMs);
	});
	const unchecked = (check: (page: Page, pageId: string) => Promise<CheckResult>, reason: string) => {
		untested.push({
			type: "check", check: check.name, page: pageId,
			state: check === darkSchemeVisuals ? "dark" : "initial", outcome: "untested", reason,
		});
		notes.push(`${check.name} did not run on ${pageId}: ${reason}. Treat it as unchecked, not as clean.`);
	};
	const run = async (check: (page: Page, pageId: string) => Promise<CheckResult>, newVariantsOnly = false) => {
		try {
			// Merge only the race winner, so a late check cannot alter returned evidence.
			const result = await Promise.race([check(page, pageId), timeout]);
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
			unchecked(check, reason);
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
	try {
		for (let index = 0; index < checks.length; index++) {
			const current = checks[index];
			if (!current) continue;
			if (timedOut || page.isClosed()) {
				const reason = timedOut ? timeoutError.message : "page closed before check ran";
				for (const remaining of checks.slice(index)) unchecked(remaining.check, reason);
				break;
			}
			await run(current.check, current.newVariantsOnly);
		}
	} finally {
		clearTimeout(timer);
	}
	return { result: { findings, needsReview, notes, evaluations, rules: [...rules.values()], untested }, timedOut };
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

function uncheckedState(pageId: string, scenario: Scenario, reason: string): CheckResult {
	return {
		findings: [],
		notes: [`state ${scenario.id} did not run on ${pageId}: ${reason}. Treat it as not run, not as passed.`],
		untested: [{
			type: "check", check: `scenario:${scenario.id}`, page: pageId, state: scenario.id,
			outcome: "untested", reason,
		}],
	};
}

async function auditPages(
	browser: Browser,
	pages: DiscoveredPage[],
	blockedRequests: BlockedRequest[],
	scenarios: Scenario[],
	auditOrigin: string,
	allowNetwork: boolean,
	timeoutMs: number,
): Promise<PageAudit[]> {
	const context = await createAuditContext(browser, auditOrigin, allowNetwork, blockedRequests);
	const audits: PageAudit[] = [];
	try {
		for (const discoveredPage of pages) {
			const blockedBefore = blockedRequests.length;
			const declaredStates = scenarios.filter((candidate) => candidate.page === discoveredPage.file);
			const audit: PageAudit = {
				page: discoveredPage, triage: { ok: false }, audited: false, findings: [], notes: [],
			};
			audits.push(audit);
			let page: Page | undefined;
			try {
				let phase = "page creation";
				try {
					page = await context.newPage();
					phase = "navigation";
					const response = await page.goto(discoveredPage.url, {
						waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS,
					});
					phase = "settling";
					const settleNote = await settle(page);
					if (settleNote) audit.notes.push(`${discoveredPage.file}: ${settleNote}`);
					phase = "triage";
					audit.triage = await triage(page, response?.status() ?? null, blockedRequests.length - blockedBefore);
					if (audit.triage.ok) {
						phase = "title retrieval";
						audit.title = await page.title();
					}
				} catch (error) {
					audit.triage = { ok: false, reason: `${phase} failed: ${error instanceof Error ? error.message : String(error)}` };
				}
				if (!audit.triage.ok || !page) {
					const reason = audit.triage.reason ?? "page triage failed";
					const skipped = declaredStates.map((scenario) => uncheckedState(discoveredPage.file, scenario, reason));
					audit.untested = [{
						type: "check", check: "page-audit", page: discoveredPage.file,
						state: "initial", outcome: "untested", reason,
					}, ...skipped.flatMap((state) => state.untested ?? [])];
					audit.notes.push(...skipped.flatMap((state) => state.notes));
					continue;
				}

				const initial = await runChecks(page, discoveredPage.file, timeoutMs);
				const stateResults = [initial.result];
				if (initial.timedOut) {
					const reason = `initial page audit exceeded ${timeoutMs / 1000}s`;
					stateResults.push(...declaredStates.map((scenario) => uncheckedState(discoveredPage.file, scenario, reason)));
				} else for (const scenario of declaredStates) {
					let stateContext: BrowserContext | undefined;
					try {
						stateContext = await createAuditContext(browser, auditOrigin, allowNetwork, blockedRequests);
						const statePage = await stateContext.newPage();
						const blockedBeforeState = blockedRequests.length;
						const response = await statePage.goto(discoveredPage.url, {
							waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS,
						});
						const settleNote = await settle(statePage);
						const stateVerdict = await triage(
							statePage, response?.status() ?? null, blockedRequests.length - blockedBeforeState,
						);
						if (!stateVerdict.ok) throw new Error(stateVerdict.reason ?? "page triage failed");
						await runScenarioActions(statePage, scenario);
						const { result: stateResult } = await runChecks(statePage, discoveredPage.file, timeoutMs);
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
						stateResults.push(uncheckedState(discoveredPage.file, scenario, reason));
					} finally {
						try {
							await stateContext?.close();
						} catch (error) {
							audit.notes.push(`state ${scenario.id} context cleanup failed on ${discoveredPage.file}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				}
				audit.audited = true;
				audit.findings = stateResults.flatMap((state) => state.findings);
				audit.needsReview = stateResults.flatMap((state) => state.needsReview ?? []);
				audit.notes.push(...stateResults.flatMap((state) => state.notes));
				audit.evaluations = stateResults.flatMap((state) => state.evaluations ?? []);
				audit.rules = stateResults.flatMap((state) => state.rules ?? []);
				audit.untested = stateResults.flatMap((state) => state.untested ?? []);
			} finally {
				try {
					if (page && !page.isClosed()) await page.close();
				} catch (error) {
					audit.notes.push(`page cleanup failed on ${discoveredPage.file}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	} finally {
		try {
			await context.close();
		} catch (error) {
			// Keep cleanup evidence with the last page; it applies to the shared context.
			audits.at(-1)?.notes.push(`initial context cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return audits;
}
