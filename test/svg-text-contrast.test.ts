import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { focusIndicators, nonTextContrast, runAxe, stateContrast, type CheckResult } from "../src/checks.ts";

let browser: Browser;
let context: BrowserContext;
let page: Page;
before(async () => {
	browser = await chromium.launch();
	// axe opens an additional page; browser.newPage() makes an owned context that
	// cannot create that page. Keep its context explicit in every regression run.
	context = await browser.newContext();
	page = await context.newPage();
});
after(async () => { await context?.close(); await browser?.close(); });

const diagram = (content: string, css = "", viewport = 'width="400" height="200" viewBox="0 0 400 200"') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Concept map</title><style>
body { background:#fff; color:#111; } text { font:16px Arial,sans-serif; } ${css}
</style></head><body><main><h1>Concept map</h1><svg role="img" aria-label="Planning steps" ${viewport}>${content}</svg></main></body></html>`;
const textFailures = (result: CheckResult) => result.findings.filter((i) => i.rule === "svg-text-contrast");
const textReviews = (result: CheckResult) => result.needsReview?.filter((i) => i.rule === "svg-text-contrast") ?? [];
const outcome = (result: CheckResult) => result.evaluations?.filter((i) => i.rule === "svg-text-contrast").map((i) => i.outcome);
const check = async (html: string) => { await page.setContent(html); await page.evaluate(() => document.fonts.ready.then(() => {})); return runAxe(page, "map.html"); };
const expectReview = (result: CheckResult, blocker: RegExp) => {
	assert.deepEqual(textFailures(result), []);
	assert.equal(textReviews(result).length, 1);
	assert.match(textReviews(result)[0]!.evidence, blocker);
	assert.match(textReviews(result)[0]!.evidence, /[34](?:\.5)?:1/);
	assert.deepEqual(outcome(result), ["cantTell"]);
};

test("realistic rounded concept map has zero failures and zero review items", async () => {
	await page.setContent(await readFile(new URL("./fixtures/svg-concept-map.html", import.meta.url), "utf8"));
	for (const run of [runAxe, nonTextContrast, stateContrast, focusIndicators]) {
		const result = await run(page, "concept-map.html");
		assert.deepEqual(result.findings, [], run.name);
		assert.deepEqual(result.needsReview ?? [], [], run.name);
		if (run === runAxe) assert.deepEqual(outcome(result), ["passed"]);
	}
});

test("dark SVG text uses the light box over a dark page", async () => {
	const result = await check(diagram('<rect width="400" height="200" fill="white"/><text id="label" x="30" y="55" fill="#111">Complete</text>', 'body { background:#111; }'));
	assert.deepEqual(textFailures(result), []);
	assert.deepEqual(textReviews(result), []);
	assert.deepEqual(outcome(result), ["passed"]);
});

test("light SVG text fails on a light box even over a dark page", async () => {
	const result = await check(diagram('<rect width="400" height="200" fill="white"/><text id="label" x="30" y="55" fill="#eee">Complete</text>', 'body { background:#111; }'));
	assert.deepEqual(textFailures(result).map((i) => [i.selector, i.evidence]), [["text#label", "rgb(238 238 238) on rgb(255 255 255); 1.16:1 (required: 4.5:1)"]]);
	assert.deepEqual(outcome(result), ["failed"]);
});

test("text and tspan use effective fill, own opacity, size and weight", async () => {
	const result = await check(diagram(`<text id="large" x="10" y="30" style="font-size:24px" fill="#777">Large</text>
<text x="10" y="60" style="font-size:19px;font-weight:700" fill="#777"><tspan id="bold">Bold</tspan></text>
<text id="normal" x="150" y="30" fill="#777">Normal</text>
<text x="150" y="60" fill="#000" fill-opacity="0.2"><tspan id="alpha" opacity="0.5">Faint</tspan></text>`));
	assert.deepEqual(textFailures(result).map((i) => [i.selector, i.evidence]), [
		["text#normal", "rgb(119 119 119) on rgb(255 255 255); 4.48:1 (required: 4.5:1)"],
		["tspan#alpha", "rgb(230 230 230) on rgb(255 255 255); 1.25:1 (required: 4.5:1)"],
	]);
	assert.deepEqual(textReviews(result), []);
});

test("round 2 P1: pale anchor text inside text cannot hide behind its parent's black fill", async () => {
	for (const content of [
		'<text x="10" y="50" fill="#000">Read <a id="pale" href="#x" fill="#ddd">pale link text here</a></text>',
		'<text x="10" y="50"><a id="pale" href="#x" fill="#ddd">pale link only</a></text>',
	]) {
		const result = await check(diagram(content));
		assert.deepEqual(textFailures(result).map((i) => [i.selector,i.evidence]), [["a#pale", "rgb(221 221 221) on rgb(255 255 255); 1.36:1 (required: 4.5:1)"]]);
		assert.deepEqual(outcome(result), ["failed"]);
	}
});

test("round 2 P1: textPath-only labels and mixed text paths are measured", async () => {
	for (const ordinary of ["", '<text x="10" y="100">Ordinary label</text>']) {
		const result = await check(diagram(`<defs><path id="curve" d="M10 60 L280 60"/></defs><text fill="white"><textPath id="pale" href="#curve">Invisible label</textPath></text>${ordinary}`));
		assert.deepEqual(textFailures(result).map((i) => [i.selector,i.evidence]), [["textPath#pale", "rgb(255 255 255) on rgb(255 255 255); 1.00:1 (required: 4.5:1)"]]);
		assert.deepEqual(outcome(result), ["failed"]);
	}
});

test("round 1 P1: the complete text box catches a narrow black stripe", async () => {
	const result = await check(diagram('<rect width="400" height="200" fill="white"/><rect id="stripe" x="25" width="20" height="200" fill="black"/><text id="label" x="10" y="55" style="font-size:24px">MMMMMMMMMM</text>'));
	assert.deepEqual(textFailures(result).map((i) => i.evidence), ["rgb(0 0 0) on rgb(0 0 0); 1.00:1 (required: 3:1)"]);
	assert.deepEqual(textReviews(result), []);
});

test("round 1 P1: overflowing white text fails against white outside its box", async () => {
	const result = await check(diagram('<rect id="box" width="100" height="40" fill="#003"/><text id="over" x="5" y="25" fill="white">Overflowing label</text>'));
	assert.deepEqual(textFailures(result).map((i) => i.evidence), ["rgb(255 255 255) on rgb(255 255 255); 1.00:1 (required: 4.5:1)"]);
	assert.deepEqual(textReviews(result), []);
});

test("round 1 P1: paint-order cannot invent a black backdrop below white text", async () => {
	expectReview(await check(diagram('<rect id="box" x="10" y="10" width="220" height="80" fill="white" stroke="black" stroke-width="200" paint-order="stroke fill"/><text x="30" y="55" fill="white">Complete</text>')), /fill over its border.*#box/);
});

test("round 1 P1: object opacity is never applied separately to fill and stroke", async () => {
	expectReview(await check(diagram('<rect id="box" x="10" y="10" width="220" height="80" fill="white" stroke="white" stroke-width="200" opacity="0.3"/><text x="30" y="55" style="font-size:24px">Complete</text>', 'body { background:black; }')), /fill and border fade together.*#box/);
});

test("round 1 P1: viewBox scaling sets the delivered font-size threshold", async () => {
	const result = await check(diagram('<text id="scaled" x="10" y="100" style="font-size:40px" fill="#888">Scaled text</text>', '', 'width="250" height="125" viewBox="0 0 1000 500"'));
	assert.deepEqual(textFailures(result).map((i) => i.evidence), ["rgb(136 136 136) on rgb(255 255 255); 3.54:1 (required: 4.5:1)"]);
});

test("round 2 P1: separated-centre non-scaling strokes cannot be excluded by scaled bounds", async () => {
	const result = await check(diagram('<line id="panel" x1="1000" y1="8000" x2="25000" y2="8000" transform="scale(.01)" stroke="black" stroke-width="100" vector-effect="non-scaling-stroke"/><text x="30" y="55" style="font-size:24px" fill="black">Complete</text>'));
	assert.deepEqual(textFailures(result).map((i) => i.evidence), ["rgb(0 0 0) on rgb(0 0 0); 1.00:1 (required: 3:1)"]);
	assert.deepEqual(textReviews(result), []);
});

test("inherited browser-resolved currentColor has a literal solid result", async () => {
	const result = await check(diagram('<g fill="currentColor" color="#777"><text x="30" y="55">Complete</text></g>'));
	assert.deepEqual(textFailures(result).map((i) => i.evidence), ["rgb(119 119 119) on rgb(255 255 255); 4.48:1 (required: 4.5:1)"]);
	for (const fill of ["context-fill", "context-stroke"]) expectReview(await check(diagram(`<text id="label" x="30" y="55" fill="${fill}">Complete</text>`)), /unresolved colour.*#label/);
});

test("review names the local gradient box and states the required ratio", async () => {
	expectReview(await check(diagram('<defs><linearGradient id="paint"><stop stop-color="white"/><stop offset="1" stop-color="#eee"/></linearGradient></defs><rect id="node-7" width="400" height="200" fill="url(#paint)"/><text x="30" y="55">Complete</text>')), /gradient, pattern or unresolved colour.*#node-7/);
});

test("a later opaque rounded box removes uncertainty from covered paint", async () => {
	const result = await check(diagram('<defs><linearGradient id="paint"><stop stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient></defs><rect width="400" height="200" fill="url(#paint)"/><rect x="10" y="10" width="300" height="100" rx="6" fill="white"/><text x="30" y="55">Complete</text>'));
	assert.deepEqual(textReviews(result), []);
	assert.deepEqual(outcome(result), ["passed"]);
});

test("HTML ancestor opacity remains review, with its blocking element", async () => {
	expectReview(await check(diagram('<text x="30" y="55" fill="white">Complete</text>').replace('<svg ', '<div id="faded" style="background:black;opacity:.4"><svg ').replace('</svg>', '</svg></div>')), /ancestor fades.*#faded/);
});

test("stroke-only SVG text remains review, with its blocking element", async () => {
	expectReview(await check(diagram('<text id="outline" x="30" y="55" fill="none" stroke="#eee">Outline</text>')), /outline stroke.*#outline/);
});

test("hairline backdrop strokes remain review", async () => {
	expectReview(await check(diagram('<line id="hairline" x1="0" y1="50" x2="300" y2="50" stroke="black" stroke-width=".2"/><text x="30" y="55">Complete</text>')), /thinner than one screen pixel.*#hairline/);
});

test("use reviews referenced text and unresolved references, while graphic-only icons add no text review", async () => {
	for (const href of ["#label-source", "#missing"]) {
		expectReview(await check(diagram(`<defs><text id="label-source" x="30" y="55">Label</text></defs><use id="copy" href="${href}"/>`)), /referenced text.*use#copy/);
	}
	const result = await check(diagram('<defs><symbol id="icon"><path d="M0 0 L10 0 L10 10 Z"/></symbol></defs><use href="#icon"/>'));
	assert.deepEqual(textReviews(result), []);
});

test("overlapping sibling tspans cannot pass", async () => {
	const result = await check(diagram('<text><tspan x="30" y="55">Complete</tspan><tspan x="30" y="55">Complete</tspan></text>'));
	assert.equal(textReviews(result).length, 2);
	assert.deepEqual(outcome(result), ["cantTell"]);
});

test("local generated content and overlaid HTML remain review", async () => {
	for (const [html, reason] of [
		[diagram('<text x="30" y="55">Complete</text>', 'main::before { content:"";position:absolute;inset:0;background:black; }'), /Generated content ::before.*main/],
		[diagram('<text x="30" y="55">Complete</text>').replace('</main>', '<div id="overlay" style="position:absolute;left:0;top:0;width:400px;height:400px;background:white"></div></main>'), /page element.*#overlay/],
	] as const) expectReview(await check(html), reason);
});

test("round 2 P1: original COLR glyphs require review in axe and state text", async () => {
	const font = (await readFile(new URL('./fixtures/svg-colour-font.ttf', import.meta.url))).toString('base64');
	const html = diagram('<a href="#x"><text id="palette" x="30" y="55" fill="black">AAA</text></a>', `@font-face {font-family:Palette;src:url(data:font/ttf;base64,${font})} text {font-family:Palette} a {outline:none} a:focus text {fill:#111}`);
	expectReview(await check(html), /font Check Palette Probe.*#palette/);
	const result = await stateContrast(page, "palette.html");
	assert.deepEqual(result.findings.filter((i) => i.rule === "state-text-contrast"), []);
	assert.deepEqual(result.needsReview?.filter((i) => i.rule === "state-text-contrast").map((i) => i.evidence.split(';')[0]), ["hover", "focus"]);
	assert.match(result.needsReview!.find((i) => i.rule === "state-text-contrast")!.evidence, /font Check Palette Probe.*#palette.*4\.5:1/);
});

test("state text uses the same measured result and SVG backdrop", async () => {
	await page.setContent(diagram('<rect width="400" height="200" fill="white"/><a id="link" href="#x"><text x="30" y="55" fill="black">Next</text></a>', 'a:focus text {fill:#eee}'));
	const result = await stateContrast(page, "state.html");
	assert.deepEqual(result.findings.filter((i) => i.rule === "state-text-contrast").map((i) => i.evidence), ["focus; rgb(238 238 238) on rgb(255 255 255); 1.16:1 (required: 4.5:1; default: 21.00:1)"]);
});

test("300 labels on a 5,000-node page add under one second", async () => {
	const html = (count: number) => diagram(`<a href="#x">${Array.from({length:count}, (_,i)=>`<text x="${(i%10)*120}" y="${Math.floor(i/10)*40+30}">Label ${i}</text>`).join('')}</a>`, '', 'width="1200" height="1200" viewBox="0 0 1200 1200"').replace('</main>', '</main>'+ '<p>Other page content.</p>'.repeat(5000));
	const time = async (count: number) => { await page.setContent(html(count)); const start=performance.now(); const result=await stateContrast(page,"large.html"); assert.deepEqual(result.needsReview ?? [], []); return performance.now()-start; };
	await time(30);
	const additions=[];
	for(let i=0;i<3;i++) { const baseline=await time(0); additions.push(await time(300)-baseline); }
	const median=additions.sort((a,b)=>a-b)[1]!;
	assert.ok(median<1000, `300 SVG labels added ${median.toFixed(0)}ms; samples ${additions.join(', ')}`);
});
