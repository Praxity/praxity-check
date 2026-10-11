import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditHtml } from "../src/html-audit.ts";
import { discover } from "../src/discover.ts";
import { createReport, humanSummary } from "../src/report.ts";
import type { Scenario } from "../src/scenarios.ts";
import { serve } from "../src/serve.ts";

const IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20'/%3E%3C/svg%3E";

test("shared initial destinations count as unchecked coverage while explicit actions reach a later slide", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "praxity-check-audit-storage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const file of ["a.html", "b.html", "c.html"]) {
		await writeFile(join(root, file), `<!doctype html><html lang="en"><title>Entry ${file}</title><body><h1>Entry ${file}</h1><script>location.replace("landing.html#first")</script></body></html>`);
	}
	await writeFile(join(root, "landing.html"), `<!doctype html><html lang="en"><title>First slide</title><main><h1>First slide</h1>
		<button id="next">Next</button><section id="later" hidden><h2>Later slide</h2><img id="defect" src="${IMAGE}"></section>
		<script>document.querySelector('#next').onclick = () => { document.querySelector('#later').hidden = false; location.hash = 'later'; };</script></main></html>`);
	const server = await serve(root);
	t.after(() => server.close());
	const pages = (await discover(root, server.origin)).pages.filter(page => page.file !== "landing.html");
	assert.deepEqual(pages.map(page => page.file), ["a.html", "b.html", "c.html"]);
	const scenarios: Scenario[] = [
		{ id: "later-slide", page: "b.html", actions: [
			{ action: "click", selector: "#next" },
			{ action: "waitFor", selector: "#later" },
		] },
	];
	const result = await auditHtml({ pages, auditOrigin: server.origin, allowNetwork: false, scenarios });
	assert.deepEqual(result.pages.map(page => page.audited), [true, false, false]);
	assert.ok(!result.pages[0]!.notes.some(note => note.includes("Initial navigation ended at the same URL")));
	assert.ok(result.pages[1]!.notes.includes(`Initial navigation ended at the same URL as a.html: ${server.origin}/landing.html#first. Use explicit scenario actions to reach the intended content; these inputs do not establish distinct rendered-page coverage.`));
	const imageOutcomes = result.pages[1]!.evaluations?.filter(item => item.rule === "axe:image-alt");
	assert.equal(imageOutcomes?.find(item => item.state === "initial")?.outcome, "inapplicable");
	assert.equal(imageOutcomes?.find(item => item.state === "later-slide")?.outcome, "failed");
	assert.ok(result.pages[1]!.findings.some(item => item.rule === "axe:image-alt" && item.state === "later-slide" && item.selector === "img#defect"));
	for (const audit of result.pages.slice(1)) {
		assert.deepEqual(audit.untested, [{
			type: "check", check: "distinct-destination", page: audit.page.file, state: "initial", outcome: "untested",
			reason: `Initial navigation ended at the same URL as a.html: ${server.origin}/landing.html#first. Use explicit scenario actions to reach the intended content; these inputs do not establish distinct rendered-page coverage.`,
		}]);
	}
	const report = createReport(root, false, { pages, stubs: [] }, result.pages, result.blockedRequests, false,
		{ ...result.environment, runtime: { name: "node", version: process.version } }, scenarios);
	assert.deepEqual(JSON.parse(JSON.stringify(report)).counts.checksNotRun, { checks: 2, pages: 2 });
	assert.equal(report.evaluations.filter(item => item.type === "check" && item.check === "distinct-destination").length, 2);
	assert.match(humanSummary(report), /Checked 1 page\.\nChecks not run: 2 on 2 pages\./);
	assert.match(humanSummary(report), /Pages not checked: 2 pages\./);
});

for (const storage of ["localStorage", "cookie", "cache", "indexedDB"] as const) {
	test(`initial pages cannot hide an alt defect using another page's ${storage}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "praxity-check-audit-storage-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const writers = {
			localStorage: "localStorage.setItem('hide-defect', 'yes')",
			cookie: "document.cookie = 'hide-defect=yes; path=/'",
			cache: "(async () => { const cache = await caches.open('defect'); await cache.put('/hide-defect', new Response('yes')); })()",
			indexedDB: "indexedDB.open('defect', 1).onupgradeneeded = event => event.target.result.createObjectStore('hidden')",
		};
		const readers = {
			localStorage: "document.querySelector('#defect').hidden = localStorage.getItem('hide-defect') === 'yes'",
			cookie: "document.querySelector('#defect').hidden = document.cookie.includes('hide-defect=yes')",
			cache: "caches.match('/hide-defect').then(response => { document.querySelector('#defect').hidden = !!response; })",
			indexedDB: "indexedDB.open('defect', 1).onsuccess = event => { document.querySelector('#defect').hidden = event.target.result.objectStoreNames.contains('hidden'); }",
		};
		await writeFile(join(root, "a.html"), `<!doctype html><html lang="en"><title>Writer</title><main><h1>Writer</h1><script>${writers[storage]}</script></main></html>`);
		await writeFile(join(root, "b.html"), `<!doctype html><html lang="en"><title>Defect</title><main><h1>Defect</h1><img id="defect" src="${IMAGE}"><script>${readers[storage]}</script></main></html>`);
		const server = await serve(root);
		t.after(() => server.close());
		const { pages } = await discover(root, server.origin);
		assert.deepEqual(pages.map(page => page.file), ["a.html", "b.html"]);
		const result = await auditHtml({ pages, scenarios: [], auditOrigin: server.origin, allowNetwork: false });
		assert.ok(result.pages.every(page => page.audited));
		const b = result.pages[1]!;
		assert.deepEqual(b.untested, []);
		assert.ok(b.findings.some(finding => finding.rule === "axe:image-alt" && finding.selector === "img#defect"));
		assert.equal(b.evaluations?.find(evaluation => evaluation.rule === "axe:image-alt" && evaluation.state === "initial")?.outcome, "failed");
	});
}
