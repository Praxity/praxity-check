import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditHtml } from "../src/html-audit.ts";
import { discover } from "../src/discover.ts";
import { serve } from "../src/serve.ts";

const IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20'/%3E%3C/svg%3E";

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
