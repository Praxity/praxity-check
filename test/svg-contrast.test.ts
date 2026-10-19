import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { focusIndicators, nonTextContrast, runAxe, stateContrast } from "../src/checks.ts";

let browser: Browser;
let page: Page;
before(async () => {
	browser = await chromium.launch();
	page = await browser.newPage();
});
after(async () => { await browser?.close(); });

const diagram = (content: string, css = "") => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Concept map</title><style>
body { background: #fff; } text { font: 16px Arial; } ${css}
</style></head><body><main><h1>Concept map</h1>
<svg role="img" aria-label="Progress map" width="240" height="100" viewBox="0 0 240 100">${content}</svg>
</main></body></html>`;

// #595959 on white is 7.00:1. The pale fill is only 1.16:1.
const BORDERED = diagram(`<g><rect id="node" x="5" y="5" width="230" height="90"
fill="#eee" stroke="#595959" stroke-width="3"/><text x="30" y="55">Complete</text></g>`);
const FILL_ONLY = diagram(`<rect id="node" x="5" y="5" width="230" height="90" fill="#eee"/>`);
const TEXT_ON_BOX = diagram(`<rect x="5" y="5" width="230" height="90" fill="#fff"/>
<text id="label" x="30" y="55" fill="#111">Complete</text>`, "body { background: #111; }");
const LIGHT_TEXT = diagram(`<rect x="5" y="5" width="230" height="90" fill="#fff"/>
<text id="label" x="30" y="55" fill="#eee">Complete</text>`, "body { background: #111; }");
const CHILD_RING = diagram(`<a id="node" href="#next"><rect x="10" y="10" width="200" height="70"
fill="#fff" stroke="#eee" stroke-width="3"/><text x="30" y="55" fill="#111">Next</text></a>`,
"a { outline: none; } a:focus-visible rect { stroke: #111; }");
const NO_RING = diagram(`<a id="node" href="#next"><rect x="10" y="10" width="200" height="70"
fill="#fff" stroke="#111" stroke-width="3"/><text x="30" y="55" fill="#111">Next</text></a>`, "a { outline: none; }");

test("SVG boundary uses its border; an almost full-size fill still needs contrast", async () => {
	await page.setContent(BORDERED);
	assert.deepEqual((await nonTextContrast(page, "bordered.html")).findings, []);
	await page.setContent(FILL_ONLY);
	assert.deepEqual((await nonTextContrast(page, "fill-only.html")).findings.map((item) => [item.rule, item.selector]),
		[["non-text-contrast-graphic", "rect#node"]]);
});

test("a border does not establish that a colour-only status passes", async () => {
	await page.setContent(BORDERED.replace(/<text.*?<\/text>/, ""));
	assert.deepEqual((await nonTextContrast(page, "colour-only.html")).needsReview?.map((item) => [item.rule, item.selector]),
		[["non-text-contrast-compositing", "rect#node"]]);
});

test("SVG text uses the light box over the dark page", async () => {
	await page.setContent(TEXT_ON_BOX);
	const result = await runAxe(page, "text-on-box.html");
	assert.deepEqual(result.findings.filter((item) => item.rule === "svg-text-contrast"), []);
	assert.deepEqual(result.evaluations?.filter((item) => item.rule === "svg-text-contrast").map((item) => item.outcome), ["passed"]);
});

test("light SVG text on a light box fails even over a dark page", async () => {
	await page.setContent(LIGHT_TEXT);
	const result = await runAxe(page, "light-text.html");
	assert.deepEqual(result.findings.filter((item) => item.rule === "svg-text-contrast").map((item) => [item.selector, item.evidence]),
		[["text#label", "rgb(238 238 238) on rgb(255 255 255); 1.16:1 (required: 4.5:1)"]]);
});

test("SVG text and tspan use computed fill, alpha, size and weight", async () => {
	await page.setContent(diagram(`<rect x="5" y="5" width="230" height="90" fill="#fff"/>
<text id="large" x="10" y="30" style="font-size:24px" fill="#777">Large</text>
<text x="10" y="60" style="font-size:19px;font-weight:700" fill="#777"><tspan id="bold">Bold</tspan></text>
<text id="normal" x="110" y="30" fill="#777">Normal</text>
<text x="110" y="60" fill="#000" fill-opacity="0.2"><tspan id="alpha" opacity="0.5">Faint</tspan></text>`));
	const result = await runAxe(page, "text-styles.html");
	assert.deepEqual(result.findings.filter((item) => item.rule === "svg-text-contrast").map((item) => item.selector),
		["text#normal", "tspan#alpha"]);
	assert.match(result.findings.find((item) => item.selector === "tspan#alpha")!.evidence, /rgb\(230 230 230\) on rgb\(255 255 255\); 1.25:1/);
});

test("SVG links accept a child stroke focus ring and reject no change", async () => {
	await page.setContent(CHILD_RING);
	assert.deepEqual((await focusIndicators(page, "child-ring.html")).findings, []);
	assert.deepEqual((await stateContrast(page, "child-ring.html")).findings, []);
	await page.setContent(NO_RING);
	assert.deepEqual((await focusIndicators(page, "no-ring.html")).findings.map((item) => [item.rule, item.selector]),
		[["focus-visible", "a#node"]]);
	assert.deepEqual((await stateContrast(page, "no-ring.html")).findings.map((item) => [item.rule, item.selector]),
		[["state-non-text-contrast", "a#node"]]);
});

test("a focusable SVG group accepts an outline on its child shape", async () => {
	await page.setContent(diagram(`<g id="node" tabindex="0" role="button" aria-label="Next">
<rect x="10" y="10" width="200" height="70" fill="#fff"/></g>`,
"g { outline: none; } g:focus-visible rect { outline: 3px solid #111; outline-offset: 2px; }"));
	assert.deepEqual((await focusIndicators(page, "group-outline.html")).findings, []);
	assert.deepEqual((await stateContrast(page, "group-outline.html")).findings, []);
	// A dark ring's small colour change is not a 3:1 focus change.
	await page.setContent(CHILD_RING.replace('stroke="#eee"', 'stroke="#222"'));
	assert.deepEqual((await stateContrast(page, "weak-change.html")).findings.map((item) => item.rule), ["state-non-text-contrast"]);
});

test("SVG backdrop follows geometry, transforms and translucent layers", async () => {
	await page.setContent(diagram(`<g transform="translate(5 5)"><rect width="230" height="90" fill="#fff"/>
<circle cx="0" cy="0" r="10" fill="#000"/><rect width="230" height="90" fill="#000" fill-opacity="0.1"/>
<text id="label" x="30" y="55" fill="#eee">Complete</text></g>`, "body { background: #111; }"));
	const result = await runAxe(page, "layers.html");
	assert.deepEqual(result.findings.filter((item) => item.rule === "svg-text-contrast").map((item) => item.selector), ["text#label"]);
	assert.match(result.findings.find((item) => item.selector === "text#label")!.evidence, /on rgb\(230 230 230\)/);
});

test("unsupported SVG text paint requires review", async () => {
	await page.setContent(diagram(`<defs><linearGradient id="paint"><stop stop-color="#fff"/><stop offset="1" stop-color="#eee"/></linearGradient></defs>
<rect width="240" height="100" fill="url(#paint)"/><text id="label" x="30" y="55">Complete</text>`));
	assert.deepEqual((await runAxe(page, "gradient.html")).needsReview?.filter((item) => item.rule === "svg-text-contrast").map((item) => item.selector), ["text#label"]);
});
