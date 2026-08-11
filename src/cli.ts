#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
	altTextQuality,
	audioAutoplay,
	focusIndicators,
	focusNotObscured,
	interactionChecks,
	keyboardWalk,
	keyboardScrollableRegions,
	linkTextQuality,
	nonTextContrast,
	pauseStopHide,
	reflow,
	runAxe,
	scopeCoverage,
	stateContrast,
	textSpacing,
	settle,
	triage,
	type CheckResult,
} from "./checks.ts";
import { discover } from "./discover.ts";
import { openInput, type Input } from "./input.ts";
import { countAtOrAbove, createReport, humanSummary, type BlockedRequest, type Confidence, type PageAudit } from "./report.ts";
import { isAuditServerUrl, serve, type StaticServer } from "./serve.ts";
import { prepareTierB } from "./tier-b.ts";

const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 10_000;
const PAGE_AUDIT_TIMEOUT_MS = 60_000;
const USAGE = `Usage:
  prax-audit check <folder|zip> [options]
  prax-audit prepare-tier-b <folder|zip> [--allow-network]

Options:
  --json <file>                         Write the complete JSON report
  --allow-network                       Allow the audited package to use the network
  --min-confidence high|medium|low      Reporting and exit threshold (default: high)
  -h, --help                            Show this help

prepare-tier-b writes local Markdown evidence to stdout; redirect it to a file.`;

interface CommonOptions {
	target: string;
	allowNetwork: boolean;
}

interface CheckOptions extends CommonOptions {
	command: "check";
	json?: string;
	minConfidence: Confidence;
}

interface TierBOptions extends CommonOptions {
	command: "prepare-tier-b";
}

type Options = CheckOptions | TierBOptions;

function parseArgs(args: string[]): Options {
	const command = args[0];
	if ((command !== "check" && command !== "prepare-tier-b") || !args[1]) {
		throw new Error(USAGE);
	}

	const common = { target: resolve(args[1]), allowNetwork: false };
	const options: Options = command === "check"
		? { command, ...common, minConfidence: "high" }
		: { command, ...common };
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--allow-network") options.allowNetwork = true;
		else if (options.command === "check" && arg === "--min-confidence" && /^(high|medium|low)$/.test(args[i + 1] ?? "")) {
			options.minConfidence = args[++i] as Confidence;
		}
		else if (options.command === "check" && arg === "--json" && args[i + 1] && !args[i + 1]?.startsWith("--")) {
			options.json = resolve(args[++i] as string);
		} else throw new Error(`unknown or incomplete option: ${arg}`);
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
	const ordered = [
		pauseStopHide, audioAutoplay, runAxe, scopeCoverage, interactionChecks,
		keyboardWalk, altTextQuality, linkTextQuality,
		keyboardScrollableRegions, focusNotObscured, nonTextContrast,
		stateContrast, focusIndicators, reflow, textSpacing,
	] as const;

	const findings: CheckResult["findings"] = [];
	const needsReview: NonNullable<CheckResult["needsReview"]> = [];
	const notes: string[] = [];
	for (const check of ordered) {
		try {
			const result = await check(page, pageId);
			findings.push(...result.findings);
			needsReview.push(...(result.needsReview ?? []));
			notes.push(...result.notes);
		} catch (error) {
			notes.push(
				`${check.name} did not run on ${pageId}: ${error instanceof Error ? error.message : String(error)} — treat as unchecked, not as clean`,
			);
			if (page.isClosed()) break;
		}
	}
	return { findings, needsReview, notes };
}

async function auditPages(
	context: BrowserContext,
	pages: Awaited<ReturnType<typeof discover>>["pages"],
	blockedRequests: BlockedRequest[],
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
				audits.push({
					page: discoveredPage,
					triage: {
						ok: false,
						reason: `navigation failed: ${error instanceof Error ? error.message : String(error)}`,
					},
					audited: false,
					findings: [],
					notes: [],
				});
				continue;
			}

			const settleNote = await settle(page);
			const verdict = await triage(page, response?.status() ?? null, blockedRequests.length - blockedBefore);
			if (!verdict.ok) {
				audits.push({ page: discoveredPage, triage: verdict, audited: false, findings: [], notes: settleNote ? [settleNote] : [] });
				continue;
			}

			const result = await withPageTimeout(page, () => runChecks(page, discoveredPage.file));
			audits.push({
				page: discoveredPage,
				triage: verdict,
				audited: true,
				findings: result.findings,
				notes: settleNote ? [settleNote, ...result.notes] : result.notes,
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
		input = await openInput(options.target);
		server = await serve(input.root);
		const auditOrigin = server.origin;
		const discovery = await discover(input.root, auditOrigin);
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
			viewport: { width: 1280, height: 720 },
			colorScheme: "light",
		});
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
				await socket.close({ code: 1008, reason: "outbound network blocked by prax-audit" });
			});
		}
		if (options.command === "prepare-tier-b") {
			const packet = await prepareTierB(context, discovery.pages, blockedRequests, basename(options.target));
			console.log(packet.markdown);
			return packet.auditedPages > 0 ? 0 : 2;
		}

		const pages = await auditPages(context, discovery.pages, blockedRequests);
		const report = createReport(
			options.target,
			input.wasZip,
			discovery,
			pages,
			blockedRequests,
			options.allowNetwork,
		);
		console.log(humanSummary(report, options.minConfidence));
		if (options.json) await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
		if (pages.length === 0 || pages.every((page) => !page.triage.ok)) return 2;
		return countAtOrAbove(report, options.minConfidence) > 0 ? 1 : 0;
	} catch (error) {
		console.error(`prax-audit: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	} finally {
		await browser?.close().catch(() => {});
		await server?.close().catch(() => {});
		await input?.cleanup().catch(() => {});
	}
}

process.exitCode = await main(process.argv.slice(2));
