import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { parseScenarios, runScenarioActions } from "../src/scenarios.ts";

test("scenario parser accepts only bounded named actions", () => {
	const scenarios = parseScenarios({
		scenarios: [{
			id: "lesson-open",
			page: "index.html",
			actions: [
				{ action: "click", selector: "button#start" },
				{ action: "press", selector: "input#answer", key: "Enter" },
				{ action: "select", selector: "select#topic", value: "biology" },
				{ action: "waitFor", selector: "main.lesson" },
			],
		}],
	});
	assert.equal(scenarios[0]?.actions.length, 4);
	assert.throws(
		() => parseScenarios({ scenarios: [{ id: "bad", page: "../index.html", actions: [{ action: "click", selector: "body" }] }] }),
		/relative package path/,
	);
	assert.throws(
		() => parseScenarios({ scenarios: [{ id: "bad", page: "index.html", actions: [{ action: "press", selector: "body", key: "Control+L" }] }] }),
		/allowed navigation key/,
	);
	assert.throws(
		() => parseScenarios({ scenarios: [{ id: "bad", page: "index.html", actions: [{ action: "script", selector: "body" }] }] }),
		/must be click, press, select, or waitFor/,
	);
});

test("scenario actions drive a rendered state without script injection", async () => {
	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();
	try {
		await page.setContent(`<!doctype html><html><body>
			<button id="start" onclick="document.querySelector('main').hidden=false">Start</button>
			<input id="answer" onkeydown="if(event.key==='Enter') this.dataset.entered='yes'">
			<select id="topic"><option value="history">History</option><option value="biology">Biology</option></select>
			<main class="lesson" hidden>Lesson</main>
		</body></html>`);
		const [scenario] = parseScenarios({
			scenarios: [{
				id: "lesson-open",
				page: "index.html",
				actions: [
					{ action: "click", selector: "button#start" },
					{ action: "press", selector: "input#answer", key: "Enter" },
					{ action: "select", selector: "select#topic", value: "biology" },
					{ action: "waitFor", selector: "main.lesson" },
				],
			}],
		});
		assert.ok(scenario);
		await runScenarioActions(page, scenario);
		assert.equal(await page.locator("input#answer").getAttribute("data-entered"), "yes");
		assert.equal(await page.locator("select#topic").inputValue(), "biology");
		await assert.doesNotReject(page.locator("main.lesson").waitFor({ state: "visible" }));
	} finally {
		await context.close();
		await browser.close();
	}
});
