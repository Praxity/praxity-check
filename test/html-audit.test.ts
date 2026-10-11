import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { chromium, type Browser } from "playwright";
import { discover } from "../src/discover.ts";
import { auditHtml, withAuditContext } from "../src/html-audit.ts";
import { prepareInteractionReview } from "../src/interaction-review.ts";
import { createReport, humanSummary } from "../src/report.ts";
import { serve } from "../src/serve.ts";

const IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20'/%3E%3C/svg%3E";
const CONTENT = `<!doctype html><html lang="en"><head><title>Evidence</title></head><body><main><h1>Evidence fixture</h1><img src="${IMAGE}"><button>Continue</button>`;

function observeBrowser(t: TestContext, observe: (browser: Browser) => void) {
	const launch = chromium.launch.bind(chromium);
	// Faults enter through Playwright's public interface; checks still use real Chromium.
	t.mock.method(chromium, "launch", async (options: Parameters<typeof chromium.launch>[0]) => {
		const browser = await launch(options);
		observe(browser);
		return browser;
	});
}

async function fixture(t: TestContext, files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "praxity-check-html-audit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
	const server = await serve(root);
	t.after(() => server.close());
	return { pages: (await discover(root, server.origin)).pages, auditOrigin: server.origin, allowNetwork: false };
}

test("scenario contexts isolate storage while preserving it across navigation", async (t) => {
	const options = await fixture(t, {
		"index.html": `<!doctype html><html lang="en"><head><title>Resume</title></head><body><main><h1>Deck</h1>
		<p id="fresh" hidden>Fresh progress</p><p id="cache-fresh" hidden>Fresh cache</p>
		<button id="mark">Save progress</button><a id="next" href="next.html" hidden>Next page</a>
		<script>
			document.querySelector('#fresh').hidden = localStorage.getItem('progress') !== null;
			caches.keys().then(keys => { document.querySelector('#cache-fresh').hidden = keys.length !== 0; });
			// The initial scan keeps writing even after another page clears the origin.
			const background = setInterval(() => localStorage.setItem('progress', 'background'), 25);
			document.querySelector('#mark').onclick = async () => {
				clearInterval(background);
				localStorage.setItem('progress', 'saved');
				const cache = await caches.open('progress');
				await cache.put('/progress', new Response('saved'));
				document.querySelector('#next').hidden = false;
			};
		</script></main></body></html>`,
		"next.html": `<!doctype html><html lang="en"><head><title>Next slide</title></head><body><main><h1>Next slide</h1>
		<p id="resumed" hidden>Progress and cache survived navigation</p>
		<script>
			caches.match('/progress').then(async response => {
				if (localStorage.getItem('progress') === 'saved' && await response?.text() === 'saved') {
					document.querySelector('#resumed').hidden = false;
				}
			});
		</script></main></body></html>`,
	});
	const result = await auditHtml({ ...options, scenarios: [
		{ id: "keeps-progress", page: "index.html", actions: [
			{ action: "waitFor", selector: "#fresh" },
			{ action: "click", selector: "#mark" },
			{ action: "click", selector: "#next" },
			{ action: "waitFor", selector: "#resumed" },
		] },
		{ id: "starts-fresh", page: "index.html", actions: [
			{ action: "waitFor", selector: "#fresh" },
			{ action: "waitFor", selector: "#cache-fresh" },
		] },
	] });
	const page = result.pages.find((page) => page.page.file === "index.html");
	assert.ok(page?.audited);
	for (const state of ["keeps-progress", "starts-fresh"]) {
		assert.ok(page.evaluations?.some((evaluation) => evaluation.state === state), `${state} was not scanned`);
		assert.ok(!page.untested?.some((evaluation) => evaluation.state === state), `${state} did not complete`);
	}
});

test("two audits of the same export produce identical results", async (t) => {
	const options = await fixture(t, {
		"index.html": `<!doctype html><html lang="en"><head><title>Determinism</title>
		<style>
			.faint { color: #d1d5dc; background: #fff; }
			#no-ring:focus { outline: none; box-shadow: none; }
			#narrow { width: 900px; }
		</style></head><body><main><h1>Determinism fixture</h1>
		<p class="faint">Low contrast text that should be reported every run.</p>
		<div id="narrow">Content too wide to reflow at 320px.</div>
		<button id="no-ring">No focus ring</button><button id="ok">Has the default ring</button>
		<img src="a.png" alt="IMG_4021.jpg"><p>Read the guide, <a href="/a">click here</a>.</p>
		</main></body></html>`,
	});
	const first = await auditHtml({ ...options, scenarios: [] });
	const second = await auditHtml({ ...options, scenarios: [] });
	assert.ok(first.pages[0]?.findings.length, "fixture produced no findings");
	assert.deepEqual(second, first);
});

test("natural and dark checks observe the page before the mutating checks", async (t) => {
	const options = await fixture(t, {
		"index.html": `<!doctype html><html lang="en"><head><title>Check order</title><meta name="color-scheme" content="light dark">
		<style>
			#dark-only { color: #000; background: #fff; }
			#clipped { font: 16px Arial, sans-serif; height: 20px; overflow: hidden; width: 160px; }
			#wide { width: 900px; }
			@media (prefers-color-scheme: dark) { #dark-only { color: #bbb; } }
		</style></head><body><main><h1>Check order</h1>
		<img id="filename" src="${IMAGE}" alt="IMG_4021.jpg">
		<p id="dark-only">Text that becomes unreadable in dark mode.</p>
		<div id="wide">Content too wide to reflow.</div><div id="clipped">fit fit fit fit fit fit fit</div>
		<script>
			// A responsive export can permanently replace content during a resize.
			addEventListener('resize', () => {
				if (innerWidth < 400) {
					document.querySelector('#filename')?.remove();
					document.querySelector('#dark-only')?.remove();
				}
			});
		</script></main></body></html>`,
	});
	const result = await auditHtml({ ...options, scenarios: [] });
	const page = result.pages[0];
	assert.ok(page?.audited);
	assert.deepEqual(page.untested, []);
	assert.ok(page.findings.some((finding) => finding.rule === "alt-filename" && finding.selector === "img#filename"));
	assert.ok(page.findings.some((finding) => finding.rule === "axe:color-contrast" && finding.selector === "p#dark-only" && finding.state === "dark"));
	assert.ok(page.findings.some((finding) => finding.rule === "reflow-320"));
	assert.ok(page.findings.some((finding) => finding.rule === "text-spacing-clip"));
	assert.deepEqual(page.findings.map((finding) => finding.rule), [
		"alt-filename", "axe:color-contrast", "reflow-320", "text-spacing-clip",
	]);
});

test("audits record blocked HTTP and WebSocket requests", async (t) => {
	const options = await fixture(t, {
		"index.html": `<!doctype html><html lang="en"><head><title>Network</title></head><body><main><h1>Local course</h1>
		<p>${"This course ships its lesson content locally and remains readable when internet requests are blocked. ".repeat(4)}</p>
		<script>
			fetch('https://example.invalid/course').catch(() => {});
			new WebSocket('wss://example.invalid/socket');
		</script></main></body></html>`,
	});
	const result = await auditHtml({ ...options, scenarios: [] });
	assert.ok(result.pages[0]?.audited);
	assert.deepEqual(result.blockedRequests.sort((a, b) => a.url.localeCompare(b.url)), [
		{ url: "https://example.invalid/course", method: "GET", resourceType: "fetch" },
		{ url: "wss://example.invalid/socket", method: "WEBSOCKET", resourceType: "websocket" },
	]);
	assert.ok(result.environment.browser?.version);
	assert.deepEqual(result.environment.viewport, { width: 1280, height: 720 });
	assert.equal(result.environment.colorScheme, "light");
});

test("network permission allows requests to another local origin", async (t) => {
	const remote = await fixture(t, { "course.js": "document.querySelector('#loaded').hidden = false;" });
	const options = await fixture(t, {
		"index.html": `<!doctype html><html lang="en"><head><title>Allowed network</title></head><body><main><h1>Course</h1>
		<p id="loaded" hidden>Remote content loaded</p><script src="${remote.auditOrigin}/course.js"></script>
		</main></body></html>`,
	});
	const result = await auditHtml({ ...options, allowNetwork: true, scenarios: [
		{ id: "loaded", page: "index.html", actions: [{ action: "waitFor", selector: "#loaded" }] },
	] });
	assert.deepEqual(result.blockedRequests, []);
	assert.ok(result.pages[0]?.audited);
	assert.ok(result.pages[0].evaluations?.some((evaluation) => evaluation.state === "loaded"));
	assert.deepEqual(result.pages[0].untested, []);
});

test("prepare-review borrows the same network policy through the context seam", async (t) => {
	const options = await fixture(t, {
		"index.html": `<!doctype html><html lang="en"><head><title>Review network</title></head><body><main><h1>Local course</h1>
		<p>${"This course ships its lesson content locally and remains readable when internet requests are blocked. ".repeat(4)}</p>
		<script>fetch('https://example.invalid/review').catch(() => {});</script>
		</main></body></html>`,
	});
	const { packet, blockedRequests } = await withAuditContext(options, async (context, blockedRequests) => ({
		packet: await prepareInteractionReview(context, options.pages, blockedRequests, "network"),
		blockedRequests,
	}));
	assert.equal(packet.auditedPages, 1);
	assert.match(packet.markdown, /Internet requests stopped: 1/);
	assert.deepEqual(blockedRequests, [{ url: "https://example.invalid/review", method: "GET", resourceType: "fetch" }]);
});

test("a page timeout keeps completed checks and records every unfinished check", async (t) => {
	const options = await fixture(t, {
		"a-responsive.html": `${CONTENT}</main></body></html>`,
		"z-timeout.html": `${CONTENT}<script>
			// Keyboard input stalls after axe has produced evidence.
			document.addEventListener('keydown', event => {
				if (event.key !== 'Tab') return;
				const deadline = performance.now() + 30000;
				while (performance.now() < deadline) {}
			});
		</script></main></body></html>`,
	});
	const result = await auditHtml({ ...options, scenarios: [
		{ id: "skipped-state", page: "z-timeout.html", actions: [{ action: "waitFor", selector: "button" }] },
	] }, { pageAuditTimeoutMs: 8000 });
	assert.equal(result.pages.length, 2);
	const completed = result.pages[0];
	assert.ok(completed?.audited);
	assert.ok(completed.findings.some((finding) => finding.rule === "axe:image-alt"));
	const timedOut = result.pages[1];
	assert.ok(timedOut);
	assert.equal(timedOut.audited, true);
	assert.equal(timedOut.title, "Evidence");
	assert.deepEqual(timedOut.triage, { ok: true });
	assert.ok(timedOut.findings.some((finding) => finding.rule === "axe:image-alt"));
	assert.ok(timedOut.evaluations?.some((evaluation) => evaluation.rule === "axe:image-alt"));
	assert.ok(timedOut.rules?.some((rule) => rule.id === "axe:image-alt"));
	const unfinished = [
		"keyboardWalk", "altTextQuality", "linkTextQuality", "localResources",
		"keyboardScrollableRegions", "focusNotObscured", "nonTextContrast", "stateContrast",
		"focusIndicators", "darkSchemeVisuals", "reflow", "textScale", "textSpacing",
	];
	assert.deepEqual(timedOut.untested, [
		...unfinished.map((check) => ({
			type: "check", check, page: "z-timeout.html", state: check === "darkSchemeVisuals" ? "dark" : "initial",
			outcome: "untested", reason: "page audit exceeded 8s",
		})),
		{ type: "check", check: "scenario:skipped-state", page: "z-timeout.html", state: "skipped-state",
			outcome: "untested", reason: "initial page audit exceeded 8s" },
	]);
	assert.match(timedOut.notes.join("\n"), /keyboardWalk did not run.*page audit exceeded 8s/);
	const report = createReport("course", false, { pages: options.pages, stubs: [] }, result.pages,
		result.blockedRequests, false, { runtime: { name: "node", version: process.version }, ...result.environment }, []);
	const json = JSON.parse(JSON.stringify(report));
	assert.deepEqual(json.counts.checksNotRun, { checks: 13, pages: 1 });
	assert.deepEqual(json.evaluations.filter((entry: { type: string }) => entry.type === "check"),
		[...timedOut.untested!].sort((a, b) => a.check.localeCompare(b.check)));
	const summary = humanSummary(report);
	assert.match(summary, /Checked 2 pages\.\nChecks not run: 13 on 1 page\.\n/);
	assert.match(summary, /States not checked: 1 state\./);
	assert.match(summary, /z-timeout\.html, state skipped-state: initial page audit exceeded 8s/);
	assert.match(summary, /keyboardWalk did not run on z-timeout\.html: page audit exceeded 8s/);
});

test("a completed clean audit reports zero checks not run", async (t) => {
	const options = await fixture(t, {
		"index.html": '<!doctype html><html lang="en"><head><title>Clean course</title></head><body><main><h1>Clean course</h1><p>Read the lesson.</p></main></body></html>',
	});
	const result = await auditHtml({ ...options, scenarios: [] });
	assert.ok(result.pages[0]?.audited);
	assert.deepEqual(result.pages[0].findings, []);
	const report = createReport("course", false, { pages: options.pages, stubs: [] }, result.pages,
		result.blockedRequests, false, { runtime: { name: "node", version: process.version }, ...result.environment }, []);
	assert.deepEqual(JSON.parse(JSON.stringify(report)).counts.checksNotRun, { checks: 0, pages: 0 });
	assert.doesNotMatch(humanSummary(report), /Checks not run:/);
});

for (const phase of ["settling", "triage", "title retrieval"] as const) {
	test(`a ${phase} failure retains an unaudited page and continues to later pages`, async (t) => {
		const script = phase === "settling"
			? `Object.defineProperty(document.body, 'innerText', { get() { throw new Error('settling fixture failed'); } });`
			: phase === "triage"
				? `const query = document.querySelectorAll.bind(document); document.querySelectorAll = selector => {
					if (selector === 'iframe') throw new Error('triage fixture failed'); return query(selector); };`
				: "";
		if (phase === "title retrieval") observeBrowser(t, (browser) => {
			const newContext = browser.newContext.bind(browser);
			t.mock.method(browser, "newContext", async (options: Parameters<typeof browser.newContext>[0]) => {
				const context = await newContext(options);
				context.on("page", (page) => {
					const title = page.title.bind(page);
					t.mock.method(page, "title", () => page.url().endsWith("b-failed.html")
						? Promise.reject(new Error("title retrieval fixture failed")) : title());
				});
				return context;
			});
		});
		const options = await fixture(t, {
			"a-before.html": `${CONTENT}</main></body></html>`,
			"b-failed.html": `${CONTENT}<script>${script}</script></main></body></html>`,
			"c-after.html": `${CONTENT}</main></body></html>`,
		});
		const result = await auditHtml({ ...options, scenarios: [] });
		assert.equal(result.pages.length, 3);
		for (const index of [0, 2]) {
			const page = result.pages[index];
			assert.ok(page?.audited);
			assert.ok(page.findings.some((finding) => finding.rule === "axe:image-alt"));
		}
		const failed = result.pages[1];
		assert.ok(failed);
		assert.equal(failed.audited, false);
		assert.equal(failed.triage.ok, false);
		assert.match(failed.triage.reason ?? "", new RegExp(`${phase} failed: .*${phase} fixture failed`));
		assert.deepEqual(failed.findings, []);
		assert.deepEqual(failed.untested, [{
			type: "check", check: "page-audit", page: "b-failed.html", state: "initial",
			outcome: "untested", reason: failed.triage.reason,
		}]);
	});
}

test("scenario context creation failure keeps earlier states and continues", async (t) => {
	observeBrowser(t, (browser) => {
		const newContext = browser.newContext.bind(browser);
		let attempts = 0;
		t.mock.method(browser, "newContext", (options: Parameters<typeof browser.newContext>[0]) => {
			if (++attempts === 3) return Promise.reject(new Error("scenario context fixture failed"));
			return newContext(options);
		});
	});
	const options = await fixture(t, { "index.html": `${CONTENT}</main></body></html>` });
	const result = await auditHtml({ ...options, scenarios: ["before", "failed", "after"].map((id) => ({
		id, page: "index.html", actions: [{ action: "waitFor" as const, selector: "button" }],
	})) });
	const page = result.pages[0];
	assert.ok(page?.audited);
	for (const state of [undefined, "before", "after"]) {
		assert.ok(page.findings.some((finding) => finding.rule === "axe:image-alt" && finding.state === state));
	}
	assert.deepEqual(page.untested, [{
		type: "check", check: "scenario:failed", page: "index.html", state: "failed",
		outcome: "untested", reason: "scenario context fixture failed",
	}]);
});

test("a scenario timeout keeps completed checks and continues to later states", async (t) => {
	const options = await fixture(t, { "index.html": `${CONTENT}<button id="stall" onclick="stalled=true">Start stall</button>
	<script>
		let stalled = false;
		document.addEventListener('keydown', event => {
			if (!stalled || event.key !== 'Tab') return;
			const deadline = performance.now() + 30000;
			while (performance.now() < deadline) {}
		});
	</script></main></body></html>` });
	const result = await auditHtml({ ...options, scenarios: [
		{ id: "before", page: "index.html", actions: [{ action: "waitFor", selector: "#stall" }] },
		{ id: "timeout", page: "index.html", actions: [{ action: "click", selector: "#stall" }] },
		{ id: "after", page: "index.html", actions: [{ action: "waitFor", selector: "#stall" }] },
	] }, { pageAuditTimeoutMs: 8000 });
	const page = result.pages[0];
	assert.ok(page?.audited);
	for (const state of [undefined, "before", "timeout", "after"]) {
		assert.ok(page.findings.some((finding) => finding.rule === "axe:image-alt" && finding.state === state), `missing evidence in ${state ?? "initial"}`);
	}
	assert.ok(page.evaluations?.some((evaluation) => evaluation.rule === "axe:image-alt" && evaluation.state === "timeout"));
	assert.ok(page.untested?.some((evaluation) => evaluation.check === "keyboardWalk" && evaluation.state === "timeout"));
	assert.ok(page.untested?.every((evaluation) => evaluation.state === "timeout" && evaluation.reason === "page audit exceeded 8s"));
	const report = createReport("course", false, { pages: options.pages, stubs: [] }, result.pages,
		result.blockedRequests, false, { runtime: { name: "node", version: process.version }, ...result.environment }, []);
	assert.deepEqual(JSON.parse(JSON.stringify(report)).counts.checksNotRun, { checks: 13, pages: 1 });
	assert.match(humanSummary(report), /Checks not run: 13 on 1 page\./);
	assert.doesNotMatch(humanSummary(report), /States not checked:/);
});

test("an initial page creation failure records the page and continues", async (t) => {
	observeBrowser(t, (browser) => {
		const newContext = browser.newContext.bind(browser);
		let attempts = 0;
		t.mock.method(browser, "newContext", async (options: Parameters<typeof browser.newContext>[0]) => {
			const context = await newContext(options);
			const newPage = context.newPage.bind(context);
			t.mock.method(context, "newPage", () => ++attempts === 1
				? Promise.reject(new Error("page creation fixture failed")) : newPage());
			return context;
		});
	});
	const options = await fixture(t, {
		"a-failed.html": `${CONTENT}</main></body></html>`,
		"b-after.html": `${CONTENT}</main></body></html>`,
	});
	const result = await auditHtml({ ...options, scenarios: [] });
	assert.equal(result.pages.length, 2);
	assert.equal(result.pages[0]?.audited, false);
	assert.equal(result.pages[0]?.triage.reason, "page creation failed: page creation fixture failed");
	assert.equal(result.pages[0]?.untested?.[0]?.check, "page-audit");
	assert.ok(result.pages[1]?.findings.some((finding) => finding.rule === "axe:image-alt"));
});

for (const cleanup of ["page", "scenario context", "initial context"] as const) {
	test(`${cleanup} cleanup failure keeps evidence and records a note`, async (t) => {
		observeBrowser(t, (browser) => {
			const newContext = browser.newContext.bind(browser);
			let attempts = 0;
			t.mock.method(browser, "newContext", async (options: Parameters<typeof browser.newContext>[0]) => {
				const context = await newContext(options);
				const initial = ++attempts === 1;
				if (cleanup === "page" && initial) context.on("page", (page) => {
					const close = page.close.bind(page);
					t.mock.method(page, "close", async () => {
						await close();
						if (page.url().endsWith(".html")) throw new Error("page cleanup fixture failed");
					});
				});
				if (cleanup === "initial context" && initial || cleanup === "scenario context" && !initial) {
					const close = context.close.bind(context);
					t.mock.method(context, "close", async () => {
						await close();
						throw new Error(`${cleanup} cleanup fixture failed`);
					});
				}
				return context;
			});
		});
		const options = await fixture(t, {
			"a-before.html": `${CONTENT}</main></body></html>`,
			"b-after.html": `${CONTENT}</main></body></html>`,
		});
		const result = await auditHtml({ ...options, scenarios: [
			{ id: "before", page: "a-before.html", actions: [{ action: "waitFor", selector: "button" }] },
			{ id: "after", page: "a-before.html", actions: [{ action: "waitFor", selector: "button" }] },
		] });
		assert.equal(result.pages.length, 2);
		for (const page of result.pages) {
			assert.ok(page.audited);
			assert.ok(page.findings.some((finding) => finding.rule === "axe:image-alt"));
		}
		for (const state of ["before", "after"]) {
			assert.ok(result.pages[0]?.findings.some((finding) => finding.state === state));
		}
		assert.match(result.pages.flatMap((page) => page.notes).join("\n"), new RegExp(`${cleanup} cleanup fixture failed`));
	});
}

test("a later initial context failure records the page and continues", async (t) => {
	observeBrowser(t, (browser) => {
		const newContext = browser.newContext.bind(browser);
		let attempts = 0;
		t.mock.method(browser, "newContext", (options: Parameters<typeof browser.newContext>[0]) => ++attempts === 2
			? Promise.reject(new Error("later initial context fixture failed")) : newContext(options));
	});
	const options = await fixture(t, {
		"a-before.html": `${CONTENT}</main></body></html>`,
		"b-failed.html": `${CONTENT}</main></body></html>`,
		"c-after.html": `${CONTENT}</main></body></html>`,
	});
	const result = await auditHtml({ ...options, scenarios: [
		{ id: "skipped", page: "b-failed.html", actions: [{ action: "waitFor", selector: "button" }] },
	] });
	for (const index of [0, 2]) {
		assert.ok(result.pages[index]?.audited);
		assert.ok(result.pages[index]?.findings.some(finding => finding.rule === "axe:image-alt"));
	}
	const failed = result.pages[1]!;
	assert.equal(failed.audited, false);
	assert.equal(failed.triage.reason, "context creation failed: later initial context fixture failed");
	assert.deepEqual(failed.untested?.map(item => item.check), ["page-audit", "scenario:skipped"]);
});

test("initial context creation failure still rejects the audit", async (t) => {
	observeBrowser(t, (browser) => {
		t.mock.method(browser, "newContext", () => Promise.reject(new Error("initial context fixture failed")));
	});
	const options = await fixture(t, { "index.html": `${CONTENT}</main></body></html>` });
	await assert.rejects(auditHtml({ ...options, scenarios: [] }), /initial context fixture failed/);
});
