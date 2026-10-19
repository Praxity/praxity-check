import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { focusIndicators, nonTextContrast, runAxe, stateContrast } from "../src/checks.ts";

let browser: Browser;
let context: BrowserContext;
let page: Page;
before(async () => {
	browser = await chromium.launch();
	context = await browser.newContext();
	page = await context.newPage();
});
after(async () => { await context?.close(); await browser?.close(); });

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
		[["svg-fill-meaning", "svg"]]);
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

const expectTextReview = async (reason: RegExp) => {
	const result = await runAxe(page, "review.html");
	const reviews = result.needsReview?.filter((item) => item.rule === "svg-text-contrast");
	assert.equal(reviews?.length, 1);
	assert.match(reviews![0]!.evidence, reason);
	assert.deepEqual(result.evaluations?.filter((item) => item.rule === "svg-text-contrast").map((item) => item.outcome), ["cantTell"]);
};

test("P1: a narrow stripe missed by every old sample cannot pass text contrast", async () => {
	await page.setContent(diagram(`<rect width="240" height="100" fill="#fff"/>
<rect id="stripe" x="20" width="20" height="100" fill="#000"/>
<text id="label" x="10" y="55" style="font-size:24px">MMMMMMMMMM</text>`));
	await page.evaluate(() => {
		const bounds = document.querySelector<SVGTextElement>("#label")!.getBBox();
		document.querySelector("#stripe")!.setAttribute("x", String(bounds.x + bounds.width * .08));
		document.querySelector("#stripe")!.setAttribute("width", String(bounds.width * .12));
	});
	await expectTextReview(/partially intersects/);
});

test("P1: overflowing text requires proof for the whole box", async () => {
	await page.setContent(diagram(`<rect id="box" width="100" height="40" fill="#003"/>
<text id="over" x="5" y="25" font-size="16" fill="#fff">Overflowing label</text>`).replace('width="240" height="100" viewBox="0 0 240 100"', 'width="400" height="100" viewBox="0 0 400 100"'));
	await expectTextReview(/partially intersects/);
});

test("P1: paint-order cannot invent a black backdrop under white text", async () => {
	await page.setContent(diagram(`<rect x="10" y="10" width="220" height="80" fill="#fff" stroke="#000" stroke-width="200" paint-order="stroke fill"/>
<text id="label" x="30" y="55" fill="#fff">Complete</text>`));
	await expectTextReview(/Paint-order/);
});

test("P1: object opacity applies once to overlapping fill and stroke", async () => {
	await page.setContent(diagram(`<rect x="10" y="10" width="220" height="80" fill="#fff" stroke="#fff" stroke-width="200" opacity="0.3"/>
<text id="label" x="30" y="55" fill="#000" style="font-size:24px">Complete</text>`, "body { background:#000; }"));
	await expectTextReview(/Object opacity/);
});

test("P1: viewBox scaling sets the delivered font-size threshold", async () => {
	await page.setContent(diagram(`<text id="scaled" x="10" y="100" style="font-size:40px" fill="#888">Scaled text</text>`)
		.replace('width="240" height="100" viewBox="0 0 240 100"', 'width="250" height="125" viewBox="0 0 1000 500"'));
	const result = await runAxe(page, "scaled.html");
	assert.deepEqual(result.findings.filter((item) => item.rule === "svg-text-contrast").map((item) => [item.selector, item.evidence]),
		[["text#scaled", "rgb(136 136 136) on rgb(255 255 255); 3.54:1 (required: 4.5:1)"]]);
});

test("browser-resolved inherited currentColor has its literal solid contrast", async () => {
	await page.setContent(diagram(`<g fill="currentColor" color="#777"><text id="label" x="30" y="55">Complete</text></g>`));
	const result = await runAxe(page, "current-color.html");
	assert.deepEqual(result.findings.filter((item) => item.rule === "svg-text-contrast").map((item) => item.evidence),
		["rgb(119 119 119) on rgb(255 255 255); 4.48:1 (required: 4.5:1)"]);
	for (const value of ["context-fill", "context-stroke"]) {
		await page.setContent(diagram(`<text x="30" y="55" fill="${value}">Complete</text>`));
		await expectTextReview(/Unresolved fill/);
	}
});

test("HTML ancestor opacity requires text review", async () => {
	await page.setContent(diagram(`<text x="30" y="55" fill="#fff">Complete</text>`)
		.replace("<svg ", '<div style="background:#000;opacity:.4"><svg ').replace("</svg>", "</svg></div>"));
	await expectTextReview(/Ancestor opacity/);
});

test("stroke-only text requires review rather than silent exclusion", async () => {
	await page.setContent(diagram(`<text id="outline" x="5" y="30" fill="none" stroke="#eee">Outline</text>`));
	await expectTextReview(/Stroked SVG text/);
});

test("use instances cannot silently pass SVG text coverage", async () => {
	await page.setContent(diagram(`<defs><symbol id="used"><text x="30" y="55" fill="#eee">Complete</text></symbol></defs><use href="#used"/>`));
	await expectTextReview(/use instance/);
});

test("P1: a hidden central circle cannot carry a pale rectangle's boundary", async () => {
	await page.setContent(diagram(`<circle cx="120" cy="50" r="15"/><rect id="target" x="10" y="10" width="220" height="80" fill="#eee"/>`));
	const result = await nonTextContrast(page, "hidden-circle.html");
	assert.deepEqual(result.findings.map((item) => [item.rule, item.selector]), [["non-text-contrast-graphic", "rect#target"]]);
	assert.deepEqual(result.needsReview?.filter((item) => item.selector === "rect#target"), []);
});

test("P1: a circle straddling a black panel cannot pass against its centre colour", async () => {
	await page.setContent(diagram(`<rect id="panel" width="60" height="100" fill="#000"/><circle id="straddle" cx="60" cy="50" r="30" fill="#ccc"/>`)
		.replace('width="240" height="100" viewBox="0 0 240 100"', 'width="200" height="100" viewBox="0 0 200 100"'));
	const result = await nonTextContrast(page, "straddle.html");
	assert.deepEqual(result.needsReview?.filter((item) => item.selector === "circle#straddle").map((item) => item.rule), ["non-text-contrast-compositing"]);
	assert.match(result.needsReview!.find((item) => item.selector === "circle#straddle")!.evidence, /partially intersects/);
});

test("HTML group opacity and subpixel strokes require boundary review", async () => {
	for (const html of [
		diagram(`<rect id="faded" x="10" y="10" width="20" height="20" fill="#fff"/>`)
			.replace("<svg ", '<div style="background:#000;opacity:.4"><svg ').replace("</svg>", "</svg></div>"),
		diagram(`<rect id="hairline" x="20" y="20" width="150" height="50" fill="none" stroke="#000" stroke-width="0.2"/>`),
	]) {
		await page.setContent(html);
		const result = await nonTextContrast(page, "boundary-review.html");
		assert.deepEqual(result.needsReview?.map((item) => item.rule), ["non-text-contrast-compositing"]);
		assert.deepEqual(result.findings, []);
	}
});

test("a use-only graphic is explicitly unmeasured", async () => {
	await page.setContent(diagram(`<defs><symbol id="node"><rect width="100" height="40" fill="#eee"/></symbol></defs><use href="#node"/>`));
	const result = await nonTextContrast(page, "use.html");
	assert.deepEqual(result.needsReview?.map((item) => [item.rule, item.selector]), [["non-text-contrast-compositing", "use"]]);
	assert.match(result.needsReview![0]!.evidence, /use instance/);
});

test("fill meaning is one explicit 1.4.1 question per SVG", async () => {
	await page.setContent(diagram(`<rect x="5" y="10" width="100" height="80" fill="#eee" stroke="#595959" stroke-width="3"/>
<rect x="125" y="10" width="100" height="80" fill="#eee" stroke="#595959" stroke-width="3"/>`));
	const result = await nonTextContrast(page, "two-boxes.html");
	assert.deepEqual(result.findings, []);
	assert.deepEqual(result.needsReview?.map((item) => [item.rule, item.basis]), [["svg-fill-meaning", "WCAG 1.4.1 Use of Color (A)"]]);
});

test("P1: an empty butt-capped dash pattern is no focus indicator", async () => {
	await page.setContent(diagram(`<a id="node" href="#next"><rect x="10" y="10" width="200" height="70"
fill="#fff" stroke="#fff" stroke-width="3" stroke-dasharray="0 10000"/></a>`,
	"a { outline:none; } a:focus-visible rect { stroke:#000; }"));
	assert.deepEqual((await focusIndicators(page, "empty-dashes.html")).findings.map((item) => [item.rule, item.selector]), [["focus-visible", "a#node"]]);
	assert.deepEqual((await stateContrast(page, "empty-dashes.html")).findings.map((item) => [item.rule, item.selector]), [["state-non-text-contrast", "a#node"]]);
});

test("both focus callers preserve hairline uncertainty and its reason", async () => {
	for (const width of ["0.000001", "0.2"]) {
		await page.setContent(CHILD_RING.replace('stroke-width="3"', `stroke-width="${width}"`));
		const visible = await focusIndicators(page, "hairline.html");
		assert.deepEqual(visible.findings, []);
		assert.deepEqual(visible.needsReview?.map((item) => item.rule), ["focus-visible"]);
		assert.match(visible.needsReview![0]!.evidence, /Subpixel stroke/);
		const contrast = await stateContrast(page, "hairline.html");
		assert.deepEqual(contrast.findings, []);
		assert.match(contrast.needsReview!.find((item) => item.evidence.startsWith("focus;"))!.evidence, /Subpixel stroke/);
	}
});

test("SVG focus review survives HTML ancestor opacity and use instances", async () => {
	for (const html of [
		CHILD_RING.replace("<svg ", '<div style="opacity:.4"><svg ').replace("</svg>", "</svg></div>"),
		diagram(`<defs><rect id="shape" width="200" height="70"/></defs><a href="#next"><use href="#shape"/></a>`, "a { outline:none; }"),
	]) {
		await page.setContent(html);
		const visible = await focusIndicators(page, "focus-review.html");
		assert.deepEqual(visible.findings, []);
		assert.deepEqual(visible.needsReview?.map((item) => item.rule), ["focus-visible"]);
		const contrast = await stateContrast(page, "focus-review.html");
		assert.deepEqual(contrast.findings, []);
		assert.equal(contrast.needsReview?.filter((item) => item.evidence.startsWith("focus;")).length, 1);
	}
});

test("tiny focus width growth requires review rather than a temporal pass", async () => {
	await page.setContent(CHILD_RING.replace('stroke="#eee"', 'stroke="#111"')
		.replace("a:focus-visible rect { stroke: #111; }", "a:focus-visible rect { stroke-width:3.1px; }"));
	const result = await stateContrast(page, "width-change.html");
	assert.deepEqual(result.findings, []);
	assert.match(result.needsReview!.find((item) => item.evidence.startsWith("focus;"))!.evidence, /width change/);
});
