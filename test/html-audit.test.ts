import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { discover } from "../src/discover.ts";
import { auditHtml, withAuditContext } from "../src/html-audit.ts";
import { prepareInteractionReview } from "../src/interaction-review.ts";
import { serve } from "../src/serve.ts";

const IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20'/%3E%3C/svg%3E";

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

test("a page timeout discards its earlier findings while retaining earlier pages", async (t) => {
	const content = `<!doctype html><html lang="en"><head><title>Timeout</title></head><body><main><h1>Timeout fixture</h1>
	<img src="${IMAGE}"><button>Continue</button>`;
	const options = await fixture(t, {
		"a-responsive.html": `${content}</main></body></html>`,
		"z-timeout.html": `${content}<script>
			// A stalled keyboard handler consumes the real audit limit after axe ran.
			document.addEventListener('keydown', event => {
				if (event.key !== 'Tab') return;
				const deadline = performance.now() + 120000;
				while (performance.now() < deadline) {}
			});
		</script></main></body></html>`,
	});
	const result = await auditHtml({ ...options, scenarios: [
		{ id: "skipped-state", page: "z-timeout.html", actions: [{ action: "waitFor", selector: "button" }] },
	] });
	assert.equal(result.pages.length, 2);
	const completed = result.pages[0];
	assert.ok(completed?.audited);
	assert.ok(completed.findings.some((finding) => finding.rule === "axe:image-alt"));
	const timedOut = result.pages[1];
	assert.ok(timedOut);
	assert.equal(timedOut.audited, false);
	assert.equal(timedOut.title, "Timeout");
	assert.deepEqual(timedOut.triage, { ok: false, reason: "page audit exceeded 60s" });
	assert.deepEqual(timedOut.findings, []);
	assert.deepEqual(timedOut.notes, []);
	assert.equal(timedOut.evaluations, undefined);
	assert.equal(timedOut.rules, undefined);
	assert.deepEqual(timedOut.untested, [{
		type: "check", check: "page-audit", page: "z-timeout.html", state: "initial",
		outcome: "untested", reason: "page audit exceeded 60s",
	}]);
});
