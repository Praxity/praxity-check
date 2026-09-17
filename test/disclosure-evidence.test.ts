import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { prepareInteractionReview } from "../src/interaction-review.ts";

// Fresh synthetic variants live outside the frozen benchmark corpus.
test("disclosure evidence observes adjacent content and tries each key from reset DOM", async () => {
	const variants = ["native-clean", "native-stale", "custom-clean", "custom-stale", "custom-inert", "enter-only", "unrelated", "details"];
	const browser = await chromium.launch();
	const context = await browser.newContext({ serviceWorkers: "block" });
	try {
		await context.route("http://disclosure.test/**", async (route) => {
			const variant = new URL(route.request().url()).pathname.slice(1);
			const native = variant.startsWith("native");
			const tag = native ? "button" : "span";
			const control = `<${tag} id="trigger" ${native ? 'type="button"' : 'role="button" tabindex="0"'} aria-expanded="false">Show the field guide</${tag}>`;
			const script = `const trigger = document.getElementById('trigger');
				const panel = document.getElementById('panel');
				function activate() {
					${variant === "unrelated" ? "document.getElementById('unrelated').hidden = false; return;" : ""}
					panel.hidden = !panel.hidden;
					${variant.endsWith("clean") ? "trigger.setAttribute('aria-expanded', String(!panel.hidden));" : ""}
				}
				trigger.addEventListener('click', activate);
				${!native && variant !== "custom-inert" ? `trigger.addEventListener('keydown', event => {
					if (event.key === 'Enter' ${variant === "enter-only" ? "" : "|| event.key === ' '"}) { event.preventDefault(); activate(); }
				});` : ""}`;
			await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><title>Field guide</title></head><body>
				<h1>Observation practice</h1><p>Read the field guide, then record an observation of a synthetic landscape.</p>
				${variant === "details" ? '<details id="trigger"><summary>Show the field guide</summary><div id="panel">Look for rounded pebbles near the river.</div></details>' : `<h2>${control}</h2><div id="panel" hidden>Look for rounded pebbles near the river.</div><aside id="unrelated" hidden>Unrelated weather bulletin</aside><p id="outside">Outside the two-sibling limit</p><script>${script}</script>`}
				</body></html>` });
		});
		const packet = await prepareInteractionReview(context, variants.map((file) => ({ file, url: `http://disclosure.test/${file}` })), [], "synthetic disclosure variants");
		assert.equal(packet.auditedPages, variants.length);
		const candidates = packet.evidence.candidates.filter((item) => item.surface === "disclosures");
		assert.equal(candidates.length, variants.length, "identical control markup with different traces must stay distinct");
		for (const variant of variants) {
			const candidate = candidates.find((item) => item.page === variant);
			assert.ok(candidate, variant);
			assert.ok(candidate.dom.related.some((item) => item.includes("div#panel") && item.includes("Look for rounded pebbles")), variant);
			assert.match(candidate.traceNote ?? "", /Unchanged aria-expanded alone does not prove failed activation/);
			for (const key of ["Enter", "Space"]) {
				const trace = candidate.traces.find((item) => item.action === key);
				assert.ok(trace, `${variant}: ${key}`);
				const before = JSON.parse(trace.before);
				const after = JSON.parse(trace.after);
				const panelBefore = before.elements.find((item: { selector: string }) => item.selector === "div#panel");
				const panelAfter = after.elements.find((item: { selector: string }) => item.selector === "div#panel");
				assert.equal(panelBefore.visible, false, `${variant}: ${key} must start closed`);
				const opens = variant !== "custom-inert" && variant !== "unrelated" && !(variant === "enter-only" && key === "Space");
				assert.equal(panelAfter.visible, opens, `${variant}: ${key}`);
				assert.equal(panelAfter.context, "nearby DOM; relationship unverified");
				assert.ok(!after.elements.some((item: { selector: string }) => item.selector === "p#outside"));
				assert.ok(after.elements.length <= 32);
				assert.ok(trace.before.length <= 6013 && trace.after.length <= 6013);
				const trigger = after.elements.find((item: { selector: string }) => item.selector === candidate.selector);
				if (variant !== "details") assert.equal(trigger.attributes["aria-expanded"], variant.endsWith("clean") ? "true" : "false");
				if (variant === "details") {
					const restore: { after: string } | undefined = candidate.traces.find((item) => item.action === `${key} (restore)`);
					assert.ok(restore, `native details ${key} restores`);
					assert.equal(JSON.parse(restore.after).elements.find((item: { selector: string }) => item.selector === "div#panel").visible, false);
				}
				if (variant === "unrelated") {
					const unrelated = after.elements.find((item: { selector: string }) => item.selector === "aside#unrelated");
					assert.equal(unrelated.visible, true);
					assert.ok(packet.markdown.includes('"aside#unrelated" [nearby DOM; relationship unverified] visible: false → true.'));
					assert.equal(unrelated.context, "nearby DOM; relationship unverified");
				}
			}
		}
		assert.match(packet.markdown, /Referenced or nearby rendered elements/);
		assert.match(packet.markdown, /Nearby DOM context; relationship unverified/);
	} finally {
		await context.close();
		await browser.close();
	}
});

test("disclosure evidence keeps explicit references and completed traces when reset fails", async () => {
	const browser = await chromium.launch();
	const context = await browser.newContext({ serviceWorkers: "block" });
	try {
		context.on("page", (page) => {
			const reload = page.reload.bind(page);
			let attempts = 0;
			page.reload = async (...args) => {
				if (++attempts === 1) throw new Error("synthetic reset failure");
				return reload(...args);
			};
		});
		const references = Array.from({ length: 15 }, (_, index) => `ref${index}`);
		await context.route("http://disclosure.test/**", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><title>Field guide</title><body>
			<h1>Observation practice</h1><p>Read the field guide, then record an observation of a synthetic landscape.</p>
			<h2><button id="trigger" aria-expanded="false" aria-controls="panel" aria-describedby="${references.join(" ")}" onclick="document.getElementById('panel').hidden = false">Show the field guide</button></h2>
			<div id="panel" hidden>Look for rounded pebbles near the river.</div><aside>Unrelated bulletin</aside>
			${references.map((id) => `<p id="${id}">Reference ${id}</p>`).join("")}</body></html>` }));
		const packet = await prepareInteractionReview(context, [{ file: "reset-failure", url: "http://disclosure.test/reset-failure" }], [], "reset failure");
		const candidate = packet.evidence.candidates.find((item) => item.surface === "disclosures");
		assert.ok(candidate);
		assert.equal(candidate.dom.related.length, 16);
		assert.equal(candidate.dom.related.filter((item) => item.includes("div#panel")).length, 1);
		assert.ok(candidate.dom.related.every((item) => !item.includes("relationship unverified")));
		for (const id of references) assert.ok(candidate.dom.related.some((item) => item.startsWith(`p#${id} `)));
		assert.equal(candidate.traces.length, 1);
		assert.equal(candidate.traces[0]?.action, "Enter");
		assert.equal(JSON.parse(candidate.traces[0]!.after).elements.find((item: { selector: string }) => item.selector === "div#panel").visible, true);
		assert.match(candidate.traceNote ?? "", /synthetic reset failure/);
	} finally {
		await context.close();
		await browser.close();
	}
});
