import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { discover } from "../src/discover.ts";
import { serve } from "../src/serve.ts";
import { prepareInteractionReview } from "../src/interaction-review.ts";

test("interaction-review evidence preserves behaviour differences in identical tab markup", async () => {
	const root = fileURLToPath(new URL("../bench/interaction-review/tabs", import.meta.url));
	const server = await serve(root);
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({ serviceWorkers: "block" });
		const pages = (await discover(root, server.origin)).pages;
		const packet = await prepareInteractionReview(context, pages, [], "tabs");

		assert.match(packet.markdown, /Components prepared for review: 3/);
		const clean = packet.markdown.split("First location: `clean.html`")[1]?.split("#### Candidate")[0] ?? "";
		const defect = packet.markdown.split("First location: `defect.html`")[1]?.split("### Dialogs")[0] ?? "";
		const manual = packet.markdown.split("First location: `manual-clean.html`")[1]?.split("### Dialogs")[0] ?? "";
		assert.match(clean, /Action: `ArrowRight`[\s\S]*?After: `\{"active":"button#tab-two"/);
		assert.match(defect, /Action: `ArrowRight`[\s\S]*?After: `\{"active":"button#tab-one"/);
		assert.match(manual, /Action: `ArrowRight`[\s\S]*?"tabindex":"-1","aria-selected":"false"/);
		assert.match(manual, /Action: `Enter`[\s\S]*?"tabindex":"0","aria-selected":"true"/);

		const choicesRoot = fileURLToPath(new URL("../bench/interaction-review/choices", import.meta.url));
		const choicesServer = await serve(choicesRoot);
		try {
			const choices = await prepareInteractionReview(
				await browser.newContext({ serviceWorkers: "block" }),
				(await discover(choicesRoot, choicesServer.origin)).pages,
				[],
				"choices",
			);
			assert.match(choices.markdown, /No interaction was prepared/);
			assert.match(choices.markdown, /Native select popup and keyboard state are not observable reliably in headless Chromium/);
			} finally {
				await choicesServer.close();
			}

			const stateRoot = fileURLToPath(new URL("../bench/interaction-review/state-context", import.meta.url));
			const stateServer = await serve(stateRoot);
			const stateContext = await browser.newContext({
				serviceWorkers: "block",
				viewport: { width: 1280, height: 720 },
				colorScheme: "light",
			});
			try {
				const state = await prepareInteractionReview(
					stateContext,
					(await discover(stateRoot, stateServer.origin)).pages,
					[],
					"state-context",
				);
				assert.match(state.markdown, /Browser: Playwright chromium/);
				assert.match(state.markdown, /Viewport: 1280 × 720 CSS px/);
				assert.match(state.markdown, /Theme: lesson-light; preferred colour scheme: light/);
				assert.match(state.markdown, /Semantic context: `h3`[\s\S]*Rendered HTML context:[\s\S]*<h3><button id="section"/);
				const live = state.markdown.split("### Live regions and loading")[1]?.split("### Interaction flows")[0] ?? "";
				assert.doesNotMatch(live, /Reading guide disabled/, "restoration message leaked into a later candidate");
			} finally {
				await stateContext.close();
				await stateServer.close();
			}
		} finally {
		await browser.close();
		await server.close();
	}
});
