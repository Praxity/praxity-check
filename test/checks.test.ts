import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import {
	altTextQuality,
	audioAutoplay,
	characterKeyShortcuts,
	focusIndicators,
	focusNotObscured,
	interactionChecks,
	keyboardWalk,
	keyboardScrollableRegions,
	linkTextQuality,
	mouseOnlyControls,
	nonTextContrast,
	pauseStopHide,
	pointerCancellation,
	reflow,
	runAxe,
	scopeCoverage,
	settle,
	stateContrast,
	textSpacing,
} from "../src/checks.ts";
import { serve, type StaticServer } from "../src/serve.ts";

/**
 * Positive controls. Every check here returns an empty array both when the page
 * is clean and when the check is silently broken -- `focusIndicators` shipped
 * with a selector that matched nothing and reported twenty clean controls it had
 * never looked at. A check with no known-failing fixture is not verified, it is
 * only quiet.
 *
 * Each fixture carries exactly one defect so a firing rule cannot be credited to
 * a neighbour.
 */

const BROKEN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Positive controls</title>
<style>
	button:focus { outline: 3px solid #005fcc; }
	#no-indicator { border: 1px solid #333; background: #eee; }
	.answers button:focus { outline: none; box-shadow: none; transform: translateX(0); }
	#wide { width: 900px; background: #ddd; }
	#clipped { font: 16px Arial, sans-serif; height: 20px; overflow: hidden; width: 160px; }
	#clipped-x { font: 16px Arial, sans-serif; overflow-x: hidden; white-space: nowrap; width: 180px; }
	#scrollable-menu { height: 20px; overflow: hidden auto; width: 200px; }
</style></head>
<body>
<h1>Positive controls</h1>
<button id="ok-indicator">Has the browser default ring</button>
<div class="answers"><button id="no-indicator">Suppressed focus ring</button></div>
<div id="wide">Text in a fixed 900px container that cannot reflow to 320px.</div>
<div id="clipped">fit fit fit fit fit fit fit</div>
<div id="clipped-x">iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii</div>
<div id="scrollable-menu">Scrollable menu text remains reachable vertically.</div>
<img src="a.png" alt="{{imageAlt}}">
<img src="b.png" alt="IMG_4021.jpg">
</body></html>`;

const MOUSE_ONLY_BROKEN = `<!doctype html><html lang="en"><head><title>Mouse only</title></head><body>
<h1>Mouse only</h1><div id="mouse-only">Open lesson</div>
<script>document.getElementById("mouse-only").addEventListener("click", () => document.title = "opened");</script>
</body></html>`;

const MOUSE_ONLY_CLEAN = `<!doctype html><html lang="en"><head><title>Keyboard control</title></head><body>
<h1>Keyboard control</h1><button id="keyboard-control">Open lesson</button>
<figure><div role="img" aria-label="Bar chart"><div id="chart"><canvas></canvas></div></div><table><tr><th>Category</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table></figure>
<script>
document.getElementById("keyboard-control").addEventListener("click", () => document.title = "opened");
document.getElementById("chart").addEventListener("click", () => {});
</script>
</body></html>`;

const SHORTCUT_BROKEN = `<!doctype html><html lang="en"><head><title>Shortcut</title></head><body><h1>Shortcut</h1>
<script>document.addEventListener("keydown", (event) => { if (event.key === "x") document.title = "shortcut"; });</script>
</body></html>`;

const SHORTCUT_CLEAN = `<!doctype html><html lang="en"><head><title>Modified shortcut</title></head><body><h1>Modified shortcut</h1>
<script>document.addEventListener("keydown", (event) => { if (event.ctrlKey && event.key === "x") document.title = "shortcut"; });</script>
</body></html>`;

const MOTION_BROKEN = `<!doctype html><html lang="en"><head><title>Motion</title><style>
@keyframes drift { to { transform: translateX(20px); } }
#animation, #preloader { animation: drift 6s infinite; }
#transition { transition: transform 10s linear; }
.carousel > div { display: inline-block; }
</style></head><body><h1>Motion beside content</h1>
<div id="animation">Long animation</div>
<div id="transition">Long transition</div>
<marquee id="marquee">Endless news ticker</marquee>
<div id="carousel" class="carousel" data-bs-ride="carousel"><div>Slide one</div><div>Slide two</div></div>
<div id="preloader" aria-busy="true" role="progressbar">Loading</div>
<script>const moving = document.getElementById("transition"); moving.getBoundingClientRect(); moving.style.transform = "translateX(20px)";</script>
</body></html>`;

const MOTION_CLEAN = `<!doctype html><html lang="en"><head><title>Controlled motion</title><style>
@keyframes drift { to { transform: translateX(20px); } }
#animation { animation: drift 6s infinite; }
</style></head><body><h1>Controlled motion</h1><div id="animation">Long animation</div>
<button id="pause">Pause animation</button>
<script>document.getElementById("pause").addEventListener("click", () => document.getElementById("animation").getAnimations().forEach((animation) => animation.pause()));</script>
</body></html>`;

const POINTER_BROKEN = `<!doctype html><html lang="en"><head><title>Pointer down</title></head><body><h1>Pointer down</h1>
<form id="form"><button type="submit">Submit</button></form><button id="pointer-down">Buy now</button>
<script>document.getElementById("pointer-down").addEventListener("pointerdown", () => document.getElementById("form").requestSubmit());</script>
</body></html>`;

const POINTER_CLEAN = `<!doctype html><html lang="en"><head><title>Pointer up</title></head><body><h1>Pointer up</h1>
<button id="pointer-up">Buy now</button><script>document.getElementById("pointer-up").addEventListener("click", () => document.title = "bought");</script>
</body></html>`;

const INTERACTION_BROKEN = `<!doctype html><html lang="en"><head><title>Interaction defects</title></head><body>
<h1>Interaction defects</h1><div>Decorative text</div><div>Open lesson</div>
<form id="purchase"><button type="submit">Submit order</button></form><button>Buy now</button>
<script>
const divs = document.querySelectorAll("div");
divs[1].addEventListener("click", () => document.title = "opened");
const buttons = document.querySelectorAll("button");
buttons[1].addEventListener("pointerdown", () => document.getElementById("purchase").requestSubmit());
document.addEventListener("keydown", (event) => { if (event.key === "x") document.title = "shortcut"; });
</script></body></html>`;

const INTERACTION_CLEAN = `<!doctype html><html lang="en"><head><title>Conforming interactions</title></head><body>
<h1>Conforming interactions</h1><button>Open lesson</button><button>Buy now</button>
<script>
const buttons = document.querySelectorAll("button");
buttons[0].addEventListener("click", () => document.title = "opened");
buttons[1].addEventListener("click", () => document.title = "bought");
document.addEventListener("keydown", (event) => { if (event.ctrlKey && event.key === "x") document.title = "shortcut"; });
</script></body></html>`;

const SCOPE_PARTIAL = `<!doctype html><html lang="en"><head><title>Partial scope</title></head><body>
<h1>Visible content</h1><iframe title="Embedded exercise" srcdoc="<button>Frame control</button>"></iframe><div id="host"></div>
<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<button>Shadow control</button>";</script>
</body></html>`;

const SCOPE_CLEAN = `<!doctype html><html lang="en"><head><title>Complete scope</title></head><body>
<h1>Visible content</h1><iframe title="Decoration" srcdoc="<p>No controls</p>"></iframe><div id="host"></div>
<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<span>No controls</span>";</script>
</body></html>`;

const SPACING_CLEAN = `<!doctype html><html lang="en"><head><title>Spacing controls</title><style>
#image-only { width: 100px; height: 30px; overflow: hidden; }
#image-only img { width: 100px; height: 100px; }
#already-clipped { width: 120px; height: 20px; overflow: hidden; }
#scrollable { width: 120px; height: 20px; overflow-y: auto; }
</style></head><body><h1>Spacing controls</h1>
<div id="image-only"><img alt="Blue square" src="a.png"></div>
<div id="already-clipped">This text is already much too long for its fixed box before spacing changes.</div>
<div id="scrollable">This text remains available by vertical scrolling after spacing changes.</div>
</body></html>`;

const SETTLE_DELAYED = `<!doctype html><html lang="en"><head><title>Delayed render</title></head><body>Loading…
<script>setTimeout(() => { document.body.innerHTML = "<main><h1>Ready</h1><button>Begin lesson</button></main>"; }, 700);</script>
</body></html>`;

const SETTLE_STABLE = `<!doctype html><html lang="en"><head><title>Stable render</title></head><body><main><h1>Ready</h1></main></body></html>`;

const SETTLE_CHANGING = `<!doctype html><html lang="en"><head><title>Changing render</title></head><body><h1>Loading</h1>
<script>setInterval(() => document.body.append(document.createElement("span")), 100);</script></body></html>`;

const LINK_TEXT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Links</title></head><body>
<h1>Links</h1>
<p>Book a tour, <a href="/tours">click here</a>. For parking, <a href="/parking">Click Here.</a></p>
<p><a href="/a">Apply</a> for undergraduate study, or <a href="/b">Apply</a> for postgraduate study.</p>
<p><a href="/good">Book a campus tour</a>, and <a href="/x" aria-label="Download the 2026 prospectus">click here</a>.</p>
</body></html>`;

const SIBLING_INDICATOR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sibling ring</title>
<style>
	.sr-only { position: absolute; width: 1px; height: 1px; opacity: 0; }
	/* The custom-checkbox pattern: the input's own ring is suppressed and the only
	   indicator is drawn on the adjacent label. */
	#opt:focus-visible { outline: none; box-shadow: none; }
	#opt:focus-visible + label::before { outline: 3px solid #0b5fff; outline-offset: 2px; }
	#opt + label::before { content: "\\2610"; display: inline-block; width: 1em; }
	#dead:focus-visible { outline: none; box-shadow: none; }
	#dead { position: absolute; width: 1px; height: 1px; opacity: 0; }
</style></head><body><h1>Sibling ring</h1>
<p><input type="checkbox" id="opt" class="sr-only"><label for="opt">Has a sibling ring</label></p>
<p><input type="checkbox" id="dead"><label for="dead">Has no ring anywhere</label></p>
</body></html>`;

const TRAP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Trap</title></head>
<body><h1>Trap</h1>
<button id="a">First</button><button id="b">Trapped</button><button id="c">Never reached</button>
<script>
	document.getElementById("b").addEventListener("keydown", (e) => {
		if (e.key === "Tab") { e.preventDefault(); document.getElementById("b").focus(); }
	});
</script>
</body></html>`;

const LOW_COMPONENT_CONTRAST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Low control contrast</title>
<style>body { background: #fff; } input { appearance: none; background: #fff; border: 2px solid oklch(0.75 0 0); }</style>
</head><body><label for="field">Search</label><input id="field"></body></html>`;

const LOW_GRAPHIC_CONTRAST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Low graphic contrast</title>
<style>body { background: #fff; }</style></head><body>
<svg role="img" aria-label="Upward trend" width="100" height="100"><path id="trend" d="M10 90 L50 50 L90 10" fill="none" stroke="#aaa" stroke-width="4"/></svg>
</body></html>`;

const GOOD_NON_TEXT_CONTRAST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Good non-text contrast</title>
<style>
body { background: #fff; }
#field, #inactive { appearance: none; background: #fff; border: 2px solid #595959; }
#inactive { border-color: #aaa; }
.glyph-control { appearance: none; background: #fff; border: 2px solid #ddd; color: #595959; }
</style>
</head><body><label for="field">Search</label><input id="field"><input id="inactive" disabled aria-label="Inactive control"><input aria-label="Browser default control">
<button class="glyph-control">Sort</button>
<button class="glyph-control" aria-label="Move up">↑</button>
<button class="glyph-control" aria-label="Move up"><svg width="16" height="16" aria-hidden="true"><path d="M2 10 L8 4 L14 10" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
<svg role="img" aria-label="Upward trend" width="100" height="100"><path d="M10 90 L50 50 L90 10" fill="none" stroke="#595959" stroke-width="4"/></svg>
<svg role="img" aria-label="Company logo" width="100" height="100"><path d="M10 90 L50 50 L90 10" fill="none" stroke="#aaa" stroke-width="4"/></svg>
</body></html>`;

const OBSCURED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Obscured focus</title>
<style>body { margin: 0; } header { position: fixed; inset: 0 0 auto; height: 80px; background: #fff; z-index: 2; } button { position: absolute; top: 20px; left: 20px; }</style>
</head><body><header>Sticky header</header><button id="covered">Covered control</button></body></html>`;

const PARTLY_OBSCURED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Partly obscured focus</title>
<style>body { margin: 0; } header { position: fixed; inset: 0 0 auto; height: 40px; background: #fff; z-index: 2; } button { position: absolute; top: 30px; left: 20px; }</style>
</head><body><header>Sticky header</header><button id="visible">Partly visible control</button></body></html>`;

const STATE_CONTRAST_BROKEN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>State contrast</title>
<style>
body { background: #fff; }
#practice { color: #005ea8; }
#practice:hover, #practice:focus { color: #b7b7b7; outline: 3px solid #ddd; }
</style></head><body><h1>State contrast</h1><a id="practice" href="#practice">Open practice set</a></body></html>`;

const STATE_CONTRAST_CLEAN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>State contrast</title>
<style>
body { background: #fff; }
#practice, #practice:hover, #practice:focus { color: #005ea8; }
#practice:hover, #practice:focus { outline: none; box-shadow: 0 0 0 2px #fff, 0 0 0 4px oklch(0.48 0.16 265); }
</style></head><body><h1>State contrast</h1><a id="practice" href="#practice">Open practice set</a></body></html>`;

const SCROLL_BROKEN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scrollable region</title>
<style>#lesson { height: 60px; overflow-y: auto; width: 240px; }</style></head><body><h1>Lesson</h1>
<div id="lesson">One<br>Two<br>Three<br>Four<br>Five<br>Six<br>Seven<br>Eight</div></body></html>`;

const SCROLL_CLEAN = SCROLL_BROKEN.replace('id="lesson"', 'id="lesson" tabindex="0" aria-label="Lesson transcript"');

const AUDIO_BROKEN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Autoplay audio</title></head><body>
<h1>Lesson</h1><audio id="narration" autoplay src="tone.wav"></audio></body></html>`;

const AUDIO_CLEAN = AUDIO_BROKEN.replace("autoplay src", "autoplay controls src");

const AXE_INCOMPLETE_CONTRAST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Unresolved contrast</title>
<style>body { background: #faf9f5; color: #222; } .wrap { position: relative; } .overlap { position: absolute; inset: 0; pointer-events: none; }</style>
</head><body><main><h1>Contrast</h1><div class="wrap"><p id="target">Clearly dark text</p><div class="overlap"></div></div></main></body></html>`;

function toneWav(): Buffer {
	const sampleRate = 8000;
	const samples = sampleRate * 4;
	const wav = Buffer.alloc(44 + samples, 128);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(36 + samples, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate, 28);
	wav.writeUInt16LE(1, 32);
	wav.writeUInt16LE(8, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(samples, 40);
	for (let i = 0; i < samples; i++) wav[44 + i] = 128 + Math.round(32 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
	return wav;
}

describe("tier A checks fire on known defects", () => {
	let root: string;
	let server: StaticServer;
	let browser: Browser;

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "prax-audit-checks-"));
		await writeFile(join(root, "broken.html"), BROKEN);
		await writeFile(join(root, "trap.html"), TRAP);
		await writeFile(join(root, "sibling.html"), SIBLING_INDICATOR);
		await writeFile(join(root, "links.html"), LINK_TEXT);
		await writeFile(join(root, "mouse-broken.html"), MOUSE_ONLY_BROKEN);
		await writeFile(join(root, "mouse-clean.html"), MOUSE_ONLY_CLEAN);
		await writeFile(join(root, "shortcut-broken.html"), SHORTCUT_BROKEN);
		await writeFile(join(root, "shortcut-clean.html"), SHORTCUT_CLEAN);
		await writeFile(join(root, "motion-broken.html"), MOTION_BROKEN);
		await writeFile(join(root, "motion-clean.html"), MOTION_CLEAN);
		await writeFile(join(root, "pointer-broken.html"), POINTER_BROKEN);
		await writeFile(join(root, "pointer-clean.html"), POINTER_CLEAN);
		await writeFile(join(root, "interaction-broken.html"), INTERACTION_BROKEN);
		await writeFile(join(root, "interaction-clean.html"), INTERACTION_CLEAN);
		await writeFile(join(root, "scope-partial.html"), SCOPE_PARTIAL);
		await writeFile(join(root, "scope-clean.html"), SCOPE_CLEAN);
		await writeFile(join(root, "spacing-clean.html"), SPACING_CLEAN);
		await writeFile(join(root, "settle-delayed.html"), SETTLE_DELAYED);
		await writeFile(join(root, "settle-stable.html"), SETTLE_STABLE);
		await writeFile(join(root, "settle-changing.html"), SETTLE_CHANGING);
		await writeFile(join(root, "low-component-contrast.html"), LOW_COMPONENT_CONTRAST);
		await writeFile(join(root, "low-graphic-contrast.html"), LOW_GRAPHIC_CONTRAST);
		await writeFile(join(root, "good-non-text-contrast.html"), GOOD_NON_TEXT_CONTRAST);
		await writeFile(join(root, "obscured.html"), OBSCURED);
		await writeFile(join(root, "partly-obscured.html"), PARTLY_OBSCURED);
		await writeFile(join(root, "state-broken.html"), STATE_CONTRAST_BROKEN);
		await writeFile(join(root, "state-clean.html"), STATE_CONTRAST_CLEAN);
		await writeFile(join(root, "scroll-broken.html"), SCROLL_BROKEN);
		await writeFile(join(root, "scroll-clean.html"), SCROLL_CLEAN);
		await writeFile(join(root, "audio-broken.html"), AUDIO_BROKEN);
		await writeFile(join(root, "audio-clean.html"), AUDIO_CLEAN);
		await writeFile(join(root, "axe-incomplete-contrast.html"), AXE_INCOMPLETE_CONTRAST);
		await writeFile(join(root, "tone.wav"), toneWav());
		server = await serve(root);
		browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
	});

	after(async () => {
		await browser?.close();
		await server?.close();
		await rm(root, { recursive: true, force: true });
	});

	const open = async (file: string): Promise<Page> => {
		const page = await browser.newPage();
		await page.goto(`${server.origin}/${file}`, { waitUntil: "load" });
		return page;
	};

	test("focusIndicators finds the control with no visible focus state", async () => {
		const page = await open("broken.html");
		const result = await focusIndicators(page, "broken.html");
		await page.close();

		assert.deepEqual(
			result.notes.filter((n) => n.includes("sampled 0")),
			[],
			"check sampled nothing — broken harness, not a clean page",
		);
		const hits = result.findings.filter((f) => f.rule === "focus-visible");
		assert.equal(hits.length, 1, `expected exactly the suppressed control, got ${hits.length}`);
		// The locator must name the control in terms someone can find in the source,
		// not an attribute this tool injected at runtime.
		assert.ok(
			hits[0]?.selector?.includes("no-indicator"),
			`locator should identify the suppressed control, got: ${hits[0]?.selector}`,
		);
		assert.ok(!hits[0]?.selector?.includes("prax-audit-id"), "internal marker leaked into the locator");
	});

	test("keyboardWalk finds a focus trap", async () => {
		const page = await open("trap.html");
		const result = await keyboardWalk(page, "trap.html");
		await page.close();
		assert.ok(
			result.findings.some((f) => f.rule === "keyboard-trap"),
			"Tab was held on one element and no trap was reported",
		);
	});

	test("nonTextContrast finds an author-styled low-contrast control boundary", async () => {
		const bad = await open("low-component-contrast.html");
		const badResult = await nonTextContrast(bad, "low-component-contrast.html");
		await bad.close();
		assert.ok(
			badResult.findings.some((f) => f.rule === "non-text-contrast-component"),
			"2.32:1 input boundary was not reported",
		);

		const good = await open("good-non-text-contrast.html");
		const goodResult = await nonTextContrast(good, "good-non-text-contrast.html");
		await good.close();
		assert.equal(goodResult.findings.length, 0, "conforming and browser-default controls were reported");
	});

	test("nonTextContrast finds a low-contrast required SVG part", async () => {
		const page = await open("low-graphic-contrast.html");
		const result = await nonTextContrast(page, "low-graphic-contrast.html");
		await page.close();
		assert.ok(
			result.findings.some((f) => f.rule === "non-text-contrast-graphic"),
			"2.32:1 meaning-bearing SVG stroke was not reported",
		);
	});

	test("stateContrast measures hover and focus text and indicator contrast", async () => {
		const bad = await open("state-broken.html");
		const badResult = await stateContrast(bad, "state-broken.html");
		await bad.close();
		for (const state of ["hover", "focus"]) {
			assert.ok(
				badResult.findings.some((f) => f.rule === "state-text-contrast" && f.evidence.includes(state)),
				`${state} text contrast was not reported`,
			);
		}
		assert.ok(
			badResult.findings.some((f) => f.rule === "state-non-text-contrast" && f.evidence.includes("focus")),
			"focus indicator contrast was not reported",
		);
		assert.ok(
			!badResult.findings.some((f) => f.rule === "state-non-text-contrast" && f.evidence.includes("hover")),
			"a merely subtle hover treatment was reported as required state information",
		);

		const good = await open("state-clean.html");
		const goodResult = await stateContrast(good, "state-clean.html");
		await good.close();
		assert.equal(goodResult.findings.length, 0, "conforming hover/focus colors were reported");
	});

	test("keyboardScrollableRegions proves a region responds to a keyboard key", async () => {
		const bad = await open("scroll-broken.html");
		const badResult = await keyboardScrollableRegions(bad, "scroll-broken.html");
		await bad.close();
		assert.equal(badResult.findings.filter((f) => f.rule === "scroll-region-keyboard").length, 1);

		const good = await open("scroll-clean.html");
		const goodResult = await keyboardScrollableRegions(good, "scroll-clean.html");
		await good.close();
		assert.equal(goodResult.findings.length, 0, "keyboard-scrollable region was reported");
	});

	test("audioAutoplay reports long autoplay without a sound control", async () => {
		const bad = await open("audio-broken.html");
		const badResult = await audioAutoplay(bad, "audio-broken.html");
		await bad.close();
		assert.equal(badResult.findings.filter((f) => f.rule === "audio-autoplay").length, 1);

		const good = await open("audio-clean.html");
		const goodResult = await audioAutoplay(good, "audio-clean.html");
		await good.close();
		assert.equal(goodResult.findings.length, 0, "native audio controls were ignored");
	});

	test("runAxe leaves symbol-only control contrast to the non-text check", async () => {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(`${server.origin}/good-non-text-contrast.html`, { waitUntil: "load" });
		const result = await runAxe(page, "good-non-text-contrast.html");
		await context.close();
		assert.ok(
			!result.findings.some((finding) => finding.rule === "axe:color-contrast"),
			"symbol-only control was misreported as text contrast",
		);
	});

	test("runAxe keeps incomplete contrast evidence out of findings", async () => {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(`${server.origin}/axe-incomplete-contrast.html`, { waitUntil: "load" });
		const result = await runAxe(page, "axe-incomplete-contrast.html");
		await context.close();
		assert.ok(!result.findings.some((finding) => finding.rule === "axe:color-contrast"));
		assert.ok(result.needsReview?.some((item) =>
			item.rule === "axe:color-contrast" && item.selector?.includes("target") && item.evidence.includes("overlapped")),
		);
	});

	test("focusNotObscured reports total fixed coverage but not partial overlap", async () => {
		const bad = await open("obscured.html");
		const badResult = await focusNotObscured(bad, "obscured.html");
		await bad.close();
		assert.ok(
			badResult.findings.some((f) => f.rule === "focus-not-obscured"),
			"control fully covered by a fixed header was not reported",
		);

		const good = await open("partly-obscured.html");
		const goodResult = await focusNotObscured(good, "partly-obscured.html");
		await good.close();
		assert.equal(goodResult.findings.length, 0, "partial overlap belongs to 2.4.12 AAA");
	});

	test("reflow finds content wider than 320px", async () => {
		const page = await open("broken.html");
		const result = await reflow(page, "broken.html");
		await page.close();
		const hit = result.findings.find((f) => f.rule === "reflow-320");
		assert.ok(hit, "900px container did not trigger a reflow finding");
		assert.equal(hit?.confidence, "high", "non-exempt text overflow is a conclusive failure");
	});

	test("textSpacing finds text clipped by a fixed-height container", async () => {
		const page = await open("broken.html");
		const result = await textSpacing(page, "broken.html");
		await page.close();
		assert.ok(
			result.findings.some((f) => f.rule === "text-spacing-clip"),
			"clipped text was not detected under WCAG spacing values",
		);
		assert.ok(
			result.findings.some((f) => f.selector === "div#clipped-x" && f.evidence.includes("horizontally")),
			"horizontally clipped nowrap text was not detected",
		);
		assert.ok(
			!result.findings.some((f) => f.selector === "div#scrollable-menu"),
			"reachable overflow:auto menu text was reported as clipped",
		);

		const clean = await open("spacing-clean.html");
		const cleanResult = await textSpacing(clean, "spacing-clean.html");
		await clean.close();
		assert.equal(cleanResult.findings.length, 0, "image overflow or text clipped before spacing was reported as new text loss");
	});

	test("scopeCoverage reports controls in frames and open shadow roots, but not empty subtrees", async () => {
		const partial = await open("scope-partial.html");
		const partialResult = await scopeCoverage(partial, "scope-partial.html");
		await partial.close();
		assert.equal(partialResult.findings.length, 0, "scope limits must be notes, not defects");
		assert.ok(
			partialResult.notes.some((note) => note.includes("1 of 1 same-origin iframe") && note.includes("1 of 1 open shadow root") && note.includes("partial")),
			`missing partial-scope counts: ${partialResult.notes.join(" | ")}`,
		);

		const clean = await open("scope-clean.html");
		const cleanResult = await scopeCoverage(clean, "scope-clean.html");
		await clean.close();
		assert.deepEqual(cleanResult.notes, [], "control-free frame and shadow subtrees made a clean result partial");
	});

	test("mouseOnlyControls finds a click-only div but not a native button or static chart", async () => {
		const broken = await open("mouse-broken.html");
		const brokenResult = await mouseOnlyControls(broken, "mouse-broken.html");
		await broken.close();
		assert.equal(brokenResult.findings.filter((f) => f.rule === "mouse-only-control").length, 1);

		const clean = await open("mouse-clean.html");
		const cleanResult = await mouseOnlyControls(clean, "mouse-clean.html");
		await clean.close();
		assert.equal(cleanResult.findings.length, 0, "native button or static chart was reported as mouse-only");
	});

	test("characterKeyShortcuts finds a bare document key but not Ctrl+key", async () => {
		const broken = await open("shortcut-broken.html");
		const brokenResult = await characterKeyShortcuts(broken, "shortcut-broken.html");
		await broken.close();
		assert.equal(brokenResult.findings.filter((f) => f.rule === "character-key-shortcut").length, 1);

		const clean = await open("shortcut-clean.html");
		const cleanResult = await characterKeyShortcuts(clean, "shortcut-clean.html");
		await clean.close();
		assert.equal(cleanResult.findings.length, 0, "modified shortcut was reported as character-only");
	});

	test("interactionChecks feeds all three analyses from one snapshot", async () => {
		const broken = await open("interaction-broken.html");
		const brokenResult = await interactionChecks(broken, "interaction-broken.html");
		const rules = new Set(brokenResult.findings.map((finding) => finding.rule));
		assert.deepEqual(rules, new Set(["mouse-only-control", "character-key-shortcut", "pointer-down-activation"]));
		const mouse = brokenResult.findings.find((finding) => finding.rule === "mouse-only-control");
		assert.ok(mouse?.selector, "mouse-only finding has no selector");
		assert.equal(await broken.locator(mouse.selector).count(), 1, `selector is not unique: ${mouse.selector}`);
		assert.ok(!mouse.selector.includes("Open lesson"), "accessible name leaked into the CSS selector");
		assert.ok(mouse.evidence.includes("Open lesson"), "accessible name was not moved to evidence");
		await broken.close();

		const clean = await open("interaction-clean.html");
		const cleanResult = await interactionChecks(clean, "interaction-clean.html");
		await clean.close();
		assert.equal(cleanResult.findings.length, 0, "conforming listener patterns were reported");
	});

	test("pauseStopHide finds automatic motion and honors controls and preload exceptions", async () => {
		const broken = await open("motion-broken.html");
		await broken.waitForTimeout(50);
		const brokenResult = await pauseStopHide(broken, "motion-broken.html");
		await broken.close();
		for (const id of ["animation", "transition", "marquee", "carousel"]) {
			assert.ok(brokenResult.findings.some((f) => f.selector === `div#${id}` || f.selector === `marquee#${id}`), `${id} motion was not reported`);
		}
		assert.ok(!brokenResult.findings.some((f) => f.selector === "div#preloader"), "essential preload progress was reported");

		const clean = await open("motion-clean.html");
		const cleanResult = await pauseStopHide(clean, "motion-clean.html");
		await clean.close();
		assert.equal(cleanResult.findings.length, 0, "motion with a working pause control was reported");
	});

	test("pointerCancellation finds down-event completion but not click activation", async () => {
		const broken = await open("pointer-broken.html");
		const brokenResult = await pointerCancellation(broken, "pointer-broken.html");
		await broken.close();
		assert.equal(brokenResult.findings.filter((f) => f.rule === "pointer-down-activation").length, 1);

		const clean = await open("pointer-clean.html");
		const cleanResult = await pointerCancellation(clean, "pointer-clean.html");
		await clean.close();
		assert.equal(cleanResult.findings.length, 0, "up-event click activation was reported");
	});

	test("settle waits through delayed hydration and notes a deadline", async () => {
		const delayed = await open("settle-delayed.html");
		const delayedNote = await settle(delayed, 4000);
		assert.equal(delayedNote, undefined, "delayed page did not reach a stable rendered state");
		assert.equal(await delayed.locator("button").count(), 1, "settle returned on the stable Loading shell");
		await delayed.close();

		const stable = await open("settle-stable.html");
		const stableNote = await settle(stable, 3000);
		await stable.close();
		assert.equal(stableNote, undefined, "an already-stable page produced a partial-result note");

		const changing = await open("settle-changing.html");
		const changingNote = await settle(changing, 600);
		await changing.close();
		assert.ok(changingNote?.includes("settle deadline") && changingNote.includes("partial"), "deadline did not produce a partial-result note");
	});

	test("altTextQuality separates template variables from filenames", async () => {
		const page = await open("broken.html");
		const result = await altTextQuality(page, "broken.html");
		await page.close();
		const rules = result.findings.map((f) => f.rule).sort();
		assert.deepEqual(rules, ["alt-filename", "alt-template-variable"]);
	});
	test("linkTextQuality flags known-useless text and ambiguous repeats, not good links", async () => {
		const page = await open("links.html");
		const result = await linkTextQuality(page, "links.html");
		await page.close();

		const useless = result.findings.filter((f) => f.rule === "link-text-uninformative");
		// "click here" twice -- case and trailing full stop must not hide the second.
		// "Read more" also sits in the denylist, so a repeat of it never reaches the
		// ambiguity path -- the fixture uses "Apply" for that case instead.
		assert.equal(useless.length, 2, `expected both "click here" links, got ${useless.length}`);

		const ambiguous = result.findings.filter((f) => f.rule === "link-text-ambiguous");
		assert.equal(ambiguous.length, 1, "two 'Apply' links to different targets should be one finding");

		// A descriptive link, and one whose aria-label supplies the purpose, must pass.
		const flagged = JSON.stringify(result.findings);
		assert.ok(!flagged.includes("Book a campus tour"), "descriptive link text was flagged");
		assert.ok(!flagged.includes("prospectus"), "aria-label supplying purpose was flagged");
	});

	test("focusIndicators accepts a ring drawn on a sibling, and still catches none at all", async () => {
		const page = await open("sibling.html");
		const result = await focusIndicators(page, "sibling.html");
		await page.close();

		const flagged = result.findings.map((f) => f.selector ?? "").join(" ");
		// The visually-hidden input whose only indicator is on the adjacent label
		// must NOT be reported -- sampling the element and its ancestors alone
		// accused it, which would have hit every page using this pattern.
		assert.ok(!flagged.includes("#opt"), `sibling-drawn ring was reported as missing: ${flagged}`);
		assert.ok(flagged.includes("#dead"), `a control with no indicator anywhere was missed: ${flagged}`);
	});
});
