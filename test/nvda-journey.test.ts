import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	evaluateStep,
	escapeSendKeysText,
	withJourneySignals,
	audioDuckingSetting,
	computeOverlap,
	epochLogEvents,
	matchKeyDelivery,
	matchesWaitEvent,
	narrationIntervals,
	renderJourneyMarkdown,
	summarizeJourney,
	waitForBrowserEvent,
	wordCount,
	checkStepRequirements,
	verifyAddressDestination,
	logEvents,
	nvdaGestureParts,
	parseJourney,
	parseNvdaLog,
	runJourney,
	settingDifferences,
	speechIncludes,
	speechTextFromRepr,
	timeOfDayMs,
	type Corroboration,
	type JourneyBrowser,
	type NvdaDriver,
	type StepRecord,
	type BrowserEvent,
	type SpeechEvent,
} from "../src/nvda-journey.ts";

const journey = (steps: unknown[]) => parseJourney({ version: 1, name: "Sample", start: "index.html", steps });

test("address verification rejects error pages, other origins, prefix origins and wrong paths", () => {
	const expected = "http://127.0.0.1:4000/lms.html";
	assert.equal(verifyAddressDestination(`${expected}#restored`, expected).ok, true);
	for (const actual of ["chrome-error://chromewebdata/", "https://google.com/search", "http://127.0.0.1:40001/lms.html", "http://127.0.0.1:4000/left.html", "invalid", `${expected}?wrong=1`]) {
		assert.equal(verifyAddressDestination(actual, expected).ok, false, actual);
	}
});

test("requires validates fields and compares path, fragment, slide identity and focused role", () => {
	const requires = { path: "check.html", fragment: "#slide-2", activeSlide: "Slide two", focusedRole: "radio" };
	assert.deepEqual(journey([{ id: "a", intent: "Go", requires, interKeyDelayMs: 300 }]).steps[0]!.requires, requires);
	assert.equal(checkStepRequirements(requires, corroboration({ url: "http://127.0.0.1:4000/check.html#slide-2", activeSlide: { id: "slide-2", name: "Slide two" } })).ok, true);
	assert.equal(checkStepRequirements(requires, corroboration()).mismatches.length, 2);
	assert.equal(checkStepRequirements({ activeSlide: "slide-2" }, corroboration({ activeSlide: { id: "slide-2", name: "Slide two" } })).ok, true);
	for (const extra of [{ requires: null }, { requires: [] }, { requires: {} }, { requires: { typo: "a" } }, { requires: { focusedRole: "" } }, { requires: { fragment: "wrong" } }, { interKeyDelayMs: 0 }, { interKeyDelayMs: -1 }, { setup: true }]) {
		assert.throws(() => journey([{ id: "a", intent: "Go", ...extra }]), /journey:/);
	}
});

async function syntheticRun(steps: unknown[], overrides: Partial<Parameters<typeof runJourney>[0]> = {}) {
	let clock = at("14:00:00");
	const sent: Array<{ key: string; at: number }> = [], typed: string[] = [];
	const nvda: NvdaDriver = { version: "synthetic", start: async () => {}, stop: async () => {}, getSettings: () => ({}),
		press: async (key) => { sent.push({ key, at: clock }); }, type: async (text) => { typed.push(text); } };
	const browser: JourneyBrowser = { open: async () => {}, close: async () => {}, guard: async () => ({ ok: true, detail: "ok" }), screenshot: async () => undefined, corroborate: async () => corroboration() };
	const run = await runJourney({ journey: overrides.journey ?? journey(steps), origin: "http://127.0.0.1:4000", nvda, browser, nvdaSettings: {}, startupWaitMs: 0, sleep: async (ms) => { clock += ms; }, now: () => clock, ...overrides });
	return { run, sent, typed };
}

test("a failed NVDA start is reported as itself, and NVDA still gets a best-effort stop", async () => {
	let stopped = false;
	const nvda: NvdaDriver = { version: "test", getSettings: () => ({}), press: async () => {}, type: async () => {},
		start: async () => { throw new Error("NVDA cannot be started"); },
		stop: async () => { stopped = true; throw new Error("NVDA is not running"); } };
	await assert.rejects(syntheticRun([{ id: "a", intent: "Listen", waitMs: 0 }], { nvda }), (error: unknown) => {
		assert.ok(error instanceof Error && !(error instanceof AggregateError), "the stop error must not replace the start error");
		assert.equal(error.message, "NVDA cannot be started");
		return true;
	});
	assert.equal(stopped, true);
});

test("an unmet prerequisite stops before any keys and preserves the first mismatch", async () => {
	const { run, sent } = await syntheticRun([{ id: "dependent", intent: "Go", keys: ["Enter"], requires: { path: "other.html" } }, { id: "later", intent: "Later", keys: ["Tab"] }]);
	assert.deepEqual(sent, []);
	assert.equal(run.records.length, 1);
	assert.equal(run.records[0]!.requirements?.ok, false);
	assert.match(run.stopped!, /requires mismatch: path/);
});

test("uncaptured keys are paced by default and by per-step delay", async () => {
	for (const delay of [undefined, 400]) {
		const { sent, run } = await syntheticRun([{ id: "a", intent: "Navigate", keys: ["h", "h", "Enter"], capture: false, interKeyDelayMs: delay, waitMs: 0 }]);
		assert.equal(run.stopped, undefined);
		assert.equal(sent[1]!.at - sent[0]!.at, delay ?? 250);
		assert.equal(sent[2]!.at - sent[1]!.at, delay ?? 250);
	}
});

test("capture silencing and journey keys each require a fresh guard and never use Guidepup capture", async () => {
	for (const interrupted of [false, true]) {
		const calls: string[] = [];
		let foreground = true;
		const nvda: NvdaDriver = { version: "test", start: async () => {}, stop: async () => {}, getSettings: () => ({}), type: async () => {},
			press: async (key, options) => {
				assert.equal(options?.capture, false);
				assert.equal(calls.at(-1), "guard");
				calls.push(key);
				if (key === "Control" && interrupted) foreground = false;
				return { spokenPhrase: "relay text must not be used" };
			} };
		const browser: JourneyBrowser = { open: async () => {}, close: async () => {}, screenshot: async () => undefined, corroborate: async () => corroboration(),
			guard: async () => { calls.push("guard"); return { ok: foreground, detail: "dialog took foreground" }; } };
		const { run } = await syntheticRun([{ id: "a", intent: "Navigate", keys: ["Tab"], waitMs: 0 }], { nvda, browser });
		const keys = run.records[0]!.keys;
		assert.deepEqual(keys.map(({ key, source, capture, relaySpeech }) => ({ key, source, capture, relaySpeech })), [
			{ key: "Control", source: "harness", capture: false, relaySpeech: "" },
			...(interrupted ? [] : [{ key: "Tab", source: "journey", capture: false, relaySpeech: "" }]),
		]);
		if (interrupted) assert.match(run.stopped!, /guard failed before Tab/);
		else {
			assert.equal(run.stopped, undefined);
			const result = evaluateStep(journey([{ id: "a", intent: "Navigate", keys: ["Tab"] }]).steps[0]!, run.records[0], keys.map((key) => ({ kind: "input", text: `kb(desktop):${key.key.toLowerCase()}`, timeOfDayMs: timeOfDayMs(key.startedAt!) })));
			assert.deepEqual(result.harnessInputs, ["kb(desktop):control"]);
			assert.deepEqual(result.inputs, ["kb(desktop):tab"]);
			assert.equal(result.classification, "expected");
		}
	}
});

test("signals interrupt waits and retain cleanup handlers until the browser and lock are released", async () => {
	for (const phase of ["before-start", "startup", "listen", "event", "default-sleep"] as const) {
		const signals = new EventEmitter();
		const lock = await mkdtemp(join(tmpdir(), "praxity-nvda-signal-"));
		let waitFinished = false, closed = false, stopped = false;
		let guidepupHandler: (() => void) | undefined;
		const nvda: NvdaDriver = { version: "test", start: async () => {
			guidepupHandler = () => { signals.off("SIGINT", guidepupHandler!); signals.off("SIGTERM", guidepupHandler!); };
			signals.on("SIGINT", guidepupHandler); signals.on("SIGTERM", guidepupHandler);
		}, stop: async () => { stopped = true; signals.emit("SIGTERM"); assert.equal(signals.listenerCount("SIGTERM"), 1); },
			getSettings: () => ({}), press: async () => assert.fail("no keys after interruption"), type: async () => assert.fail("no typing after interruption") };
		const browser: JourneyBrowser = { open: async () => {}, guard: async () => ({ ok: true, detail: "ok" }), screenshot: async () => undefined, corroborate: async () => corroboration(),
			observe: async () => ({ events: [], activeSlide: null }), close: async () => { closed = true; signals.emit("SIGINT"); assert.equal(signals.listenerCount("SIGINT"), 1); } };
		try {
			const result = await withJourneySignals(async (signal) => {
				try {
					if (phase === "before-start") signals.emit("SIGINT");
					return await syntheticRun([{ id: "a", intent: "Listen", waitMs: 120000, ...(phase === "event" ? { waitFor: { event: "media-ended", timeoutMs: 120000 } } : {}) }, { id: "later", intent: "Later", keys: ["Tab"] }], {
						nvda, browser, signal, startupWaitMs: phase === "startup" ? 120000 : 0,
						onProgress: (message) => { if (phase === "default-sleep" && message.startsWith("step a:")) setTimeout(() => signals.emit("SIGINT"), 10); },
						sleep: phase === "default-sleep" ? undefined : async (ms) => {
							if (!ms) return;
							signals.emit("SIGINT");
							await new Promise((resolve) => setTimeout(resolve, 100));
							waitFinished = true;
						},
					});
				} finally {
					assert.equal(signals.listenerCount("SIGINT"), 1);
					await rm(lock, { recursive: true });
				}
			}, signals);
			assert.match(result.run.stopped!, /interrupted/);
			assert.equal(closed, true);
			assert.equal(stopped, phase !== "before-start");
			assert.equal(waitFinished, false, "cleanup completes without waiting for the injected sleep");
			assert.equal(signals.listenerCount("SIGINT"), 0);
			assert.equal(signals.listenerCount("SIGTERM"), 0);
			await assert.rejects(import("node:fs/promises").then(({ stat }) => stat(lock)), { code: "ENOENT" });
		} finally { await rm(lock, { recursive: true, force: true }); }
	}
});

test("address typing escapes SendKeys syntax and refuses unsafe VBScript characters", async () => {
	assert.equal(escapeSendKeysText("+^%~(){}[]"), "{+}{^}{%}{~}{(}{)}{{}{}}{[}{]}");
	for (const character of ['"', "\0", "\t", "\n", "\r", "\x1f", "\x7f", "\x85", "\u2028", "\u2029"]) {
		assert.throws(() => escapeSendKeysText(`a${character}b`), /cannot be typed safely/);
		assert.throws(() => journey([{ id: "a", intent: "Go", address: `a${character}b` }]), /cannot be typed safely/);
	}
	let pageFocused = true;
	const typed: string[] = [], calls: string[] = [];
	const nvda: NvdaDriver = { version: "test", start: async () => {}, stop: async () => {}, getSettings: () => ({}),
		press: async (key) => { pageFocused = key === "Enter"; }, type: async (text) => { assert.equal(calls.at(-1), "guard"); calls.push("type"); typed.push(text); } };
	const browser: JourneyBrowser = { open: async () => {}, close: async () => {}, screenshot: async () => undefined,
		guard: async () => { calls.push("guard"); return { ok: true, detail: "ok" }; },
		corroborate: async () => { calls.push("read"); return corroboration({ pageFocused, url: "http://127.0.0.1:4000/lesson%20one+two(3)[4]%.html" }); } };
	const { run } = await syntheticRun([{ id: "a", intent: "Address", address: "lesson one+two(3)[4]%.html", capture: false, waitMs: 0 }], { nvda, browser });
	assert.equal(run.stopped, undefined);
	assert.equal(typed.join(""), "http://127.0.0.1:4000/lesson{%}20one{+}two{(}3{)}{[}4{]}{%}.html");
});

test("relative addresses and redirect destinations resolve in the journey start directory", async () => {
	for (const setup of [false, true]) {
		let pageFocused = true;
		const typed: string[] = [], navigated: string[][] = [], opened: string[] = [];
		const nvda: NvdaDriver = { version: "test", start: async () => {}, stop: async () => {}, getSettings: () => ({}),
			press: async (key) => { pageFocused = key === "Enter"; }, type: async (text) => { typed.push(text); } };
		const browser: JourneyBrowser = { open: async (url) => { opened.push(url); }, close: async () => {}, guard: async () => ({ ok: true, detail: "ok" }), screenshot: async () => undefined,
			navigateSetup: async (url, destination) => { navigated.push([url, destination!]); }, corroborate: async () => corroboration({ pageFocused, url: "https://example.com/course/canonical.html" }) };
		const effective = { ...journey([{ id: "a", intent: "Address", address: "next.html", addressDestination: "canonical.html", setup, capture: false, waitMs: 0 }]), start: "https://example.com/course/index.html" };
		const { run } = await syntheticRun([], { journey: effective, origin: "https://example.com", nvda, browser });
		assert.equal(run.stopped, undefined);
		assert.deepEqual(opened, ["https://example.com/course/index.html"]);
		assert.equal(run.records[0]!.address, "https://example.com/course/next.html");
		if (setup) assert.deepEqual(navigated, [["https://example.com/course/next.html", "https://example.com/course/canonical.html"]]);
		else assert.equal(typed.join(""), "https://example.com/course/next.html");
		for (const changed of [{ address: "https://other.example/next.html" }, { addressDestination: "https://other.example/canonical.html" }]) {
			const refused = await syntheticRun([], { journey: { ...effective, steps: [{ ...effective.steps[0]!, ...changed }] }, origin: "https://example.com", nvda, browser });
			assert.match(refused.run.stopped!, /left the audited package/);
		}
	}
});

test("uncaptured keys wait for IO receipt before the next key and stop on missing receipt", async () => {
	let log = "", reads = 0;
	const { run, sent } = await syntheticRun([{ id: "a", intent: "Navigate", keys: ["h", "Tab"], capture: false, waitMs: 0 }], {
		readNvdaLog: async () => {
			reads++;
			if (reads === 3) log = "IO - inputCore.InputManager.executeGesture (14:00:00.300) - winInputHook (2):\nInput: kb(desktop):h\n";
			return log;
		}, keyConfirmationTimeoutMs: 150,
	});
	assert.deepEqual(sent.map(({ key }) => key), ["h", "Tab"]);
	assert.equal(sent[1]!.at - sent[0]!.at, 300);
	assert.equal(run.records[0]!.keys[0]!.confirmation?.status, "logged");
	assert.match(run.stopped!, /NVDA did not log Tab/);
	const missing = await syntheticRun([{ id: "a", intent: "Go", keys: ["Enter", "Tab"], capture: false }], { readNvdaLog: async () => "", keyConfirmationTimeoutMs: 100 });
	assert.deepEqual(missing.sent.map(({ key }) => key), ["Enter"]);
	const unavailable = await syntheticRun([{ id: "a", intent: "Go", keys: ["h", "Tab"], capture: false }], { readNvdaLog: async () => null });
	assert.deepEqual(unavailable.sent, []);
	assert.match(unavailable.run.stopped!, /IO log unavailable before h/);
});

test("keyboard address entry refuses page focus and paces characters after focus leaves the page", async () => {
	const refused = await syntheticRun([{ id: "a", intent: "Address", address: "check.html", capture: false }]);
	assert.deepEqual(refused.typed, []);
	assert.match(refused.run.stopped!, /page still has keyboard focus/);
	let clock = at("14:00:00"), pageFocused = true;
	const characters: Array<{ text: string; at: number }> = [];
	const nvda: NvdaDriver = { version: "synthetic", start: async () => {}, stop: async () => {}, getSettings: () => ({}), press: async (key) => { pageFocused = key === "Enter"; }, type: async (text) => { characters.push({ text, at: clock }); } };
	const browser: JourneyBrowser = { open: async () => {}, close: async () => {}, guard: async () => ({ ok: true, detail: "ok" }), screenshot: async () => undefined, corroborate: async () => corroboration({ pageFocused }) };
	const { run } = await syntheticRun([{ id: "a", intent: "Address", address: "check.html", capture: false }], { nvda, browser, now: () => clock, sleep: async (ms) => { clock += ms; } });
	assert.equal(run.stopped, undefined);
	assert.equal(characters.map(({ text }) => text).join(""), "http://127.0.0.1:4000/check.html");
	assert.equal(characters[1]!.at - characters[0]!.at, 50);
});

test("setup uses CDP, records no address keys and stops at a wrong destination", async () => {
	const navigated: string[] = [];
	const browser: JourneyBrowser = { open: async () => {}, close: async () => {}, guard: async () => ({ ok: true, detail: "ok" }), screenshot: async () => undefined,
		navigateSetup: async (url) => { navigated.push(url); }, corroborate: async () => corroboration({ topLevelUrl: "chrome-error://chromewebdata/" }) };
	const { run, sent, typed } = await syntheticRun([{ id: "a", intent: "Relaunch", address: "lms.html", setup: true }, { id: "b", intent: "Later", keys: ["Tab"] }], { browser });
	assert.deepEqual(navigated, ["http://127.0.0.1:4000/lms.html"]);
	assert.deepEqual(sent, []); assert.deepEqual(typed, []);
	assert.equal(run.records.length, 1);
	assert.equal(run.records[0]!.setup?.method, "cdp");
	assert.match(run.stopped!, /browser error/);
});

test("keyboard address typing stops if foreground changes or address focus returns to the page", async () => {
	for (const focusLost of [false, true]) {
		let moved = false;
		const typed: string[] = [], sent: string[] = [];
		const browser: JourneyBrowser = { open: async () => {}, close: async () => {}, screenshot: async () => undefined,
			guard: async () => ({ ok: !(moved && !focusLost), detail: "foreground changed" }), corroborate: async () => corroboration({ pageFocused: moved && focusLost }) };
		const nvda: NvdaDriver = { version: "test", start: async () => {}, stop: async () => {}, getSettings: () => ({}), press: async (key) => { sent.push(key); }, type: async (text) => { typed.push(text); moved = true; } };
		const { run } = await syntheticRun([{ id: "a", intent: "Address", address: "check.html", capture: false }], { browser, nvda });
		assert.deepEqual(typed, ["h"]);
		assert.deepEqual(sent, ["Control+l"]);
		assert.match(run.stopped!, focusLost ? /focus lost/ : /foreground changed/);
	}
});

test("a key exception stops even when the guard still passes", async () => {
	const nvda: NvdaDriver = { version: "synthetic", start: async () => {}, stop: async () => {}, getSettings: () => ({}), type: async () => {}, press: async () => { throw new Error("relay failed"); } };
	const { run } = await syntheticRun([{ id: "a", intent: "Go", keys: ["Enter"] }, { id: "b", intent: "Later", keys: ["Tab"] }], { nvda });
	assert.equal(run.records.length, 1);
	assert.equal(run.records[0]!.guard.ok, true);
	assert.match(run.stopped!, /relay failed/);
});

test("journey keys are validated because Guidepup drops unknown key names silently", () => {
	for (const key of ["constructor", "toString", "__proto__"]) assert.throws(() => journey([{ id: "a", intent: "Go", keys: [key] }]), /unknown key/);
	assert.throws(() => journey([{ id: "a", intent: "Go", keys: ["Insert+Space"] }]), /unknown key "Space"/);
	assert.throws(() => journey([{ id: "a", intent: "Go", keys: ["Ctrl+Home"] }]), /unknown key "Ctrl"/);
	assert.throws(() => journey([{ id: "a", intent: "Go", keys: ["H"] }]), /unknown key "H"/);
	assert.equal(journey([{ id: "a", intent: "Go", address: "a+b.html" }]).steps[0]!.address, "a+b.html");
	const parsed = journey([{ id: "a", intent: "Go", keys: ["Insert+Spacebar", "Shift+k", "1"], expect: { spoken: ["Next", { text: "Checked", via: "focus" }] } }]);
	assert.deepEqual(parsed.steps[0]!.expect.spoken, [{ text: "Next", via: "any" }, { text: "Checked", via: "focus" }]);
	assert.equal(parsed.steps[0]!.waitMs, 1500);
});

test("journey focus expectations require supported non-empty string fields", () => {
	for (const focus of [null, [], {}, { role: 1 }, { name: false }, { notOn: {} }, { role: "" }, { name: " " }, { role: "button", typo: "x" }]) {
		assert.throws(() => journey([{ id: "a", intent: "Focus", expect: { focus } }]), /journey:.*expect.focus/);
	}
	assert.deepEqual(journey([{ id: "a", intent: "Focus", expect: { focus: { role: "button", name: "Next", notOn: "body" } } }]).steps[0]!.expect.focus, { role: "button", name: "Next", notOn: "body" });
});

test("key names map to NVDA gesture identifiers", () => {
	assert.deepEqual(nvdaGestureParts("Insert+F7"), ["f7", "nvda"]);
	assert.deepEqual(nvdaGestureParts("Shift+Tab"), ["shift", "tab"]);
	assert.deepEqual(nvdaGestureParts("Spacebar"), ["space"]);
});

const LOG = `INFO - __main__ (14:00:00.000) - MainThread (1):
Starting NVDA version 2026.2
IO - inputCore.InputManager.executeGesture (14:00:01.100) - winInputHook (2):
Input: kb(desktop):r
IO - speech.speech.speak (14:00:01.150) - MainThread (1):
Speaking [LangChangeCommand ('en_GB'), 'You changed a heading.', 'grouping', 'Rename the project folder.', "radio button  not checked", '1 of 4', CancellableSpeech (still valid)]
IO - inputCore.InputManager.executeGesture (14:00:02.000) - winInputHook (2):
Input: kb(desktop):control
IO - nvwave.playWaveFile (14:00:02.100) - MainThread (1):
playing C:\\nvda\\waves\\focusMode.wav
IO - speech.speech.speakTypedCharacters (14:00:04.500) - MainThread (1):
typed word: b
IO - speech.speech.speak (14:00:05.000) - MainThread (1):
Speaking ['it\\'s later']`;

test("NVDA input/output log yields inputs, speech text and mode sounds", () => {
	const entries = parseNvdaLog(LOG);
	assert.equal(entries.length, 7);
	assert.equal(entries[1]!.timeOfDayMs, (14 * 3600 + 1) * 1000 + 100);
	assert.deepEqual(speechTextFromRepr("[LangChangeCommand ('en'), 'a', BreakCommand(time=100), \"b\\n c\"]"), ["a", "b c"]);
	assert.deepEqual(logEvents(entries).map((event) => [event.kind, event.text]), [
		["input", "kb(desktop):r"],
		["speech", "You changed a heading. grouping Rename the project folder. radio button not checked 1 of 4"],
		["input", "kb(desktop):control"],
		["mode", "focus"],
		["typed", "b"],
		["speech", "it's later"],
	]);
});

test("speech matching uses whole normalized words", () => {
	assert.ok(speechIncludes("Rename the project folder. radio button not checked", "radio button, not checked"));
	assert.ok(!speechIncludes("unchecked", "checked"));
});

function at(hhmmss: string): number {
	const [h, m, s] = hhmmss.split(":").map(Number);
	const date = new Date(2026, 8, 30, h, m);
	return date.getTime() + s! * 1000;
}

const corroboration = (overrides: Partial<Corroboration> = {}): Corroboration => ({
	url: "http://127.0.0.1:4000/check.html",
	title: "Check",
	focused: { tag: "input", role: "radio", name: "Rename the project folder.", description: "", states: ["checked=false"] },
	liveRegions: [],
	pageFocused: true,
	...overrides,
});

const record = (overrides: Partial<StepRecord> = {}): StepRecord => ({
	id: "find-radio",
	startedAt: at("14:00:01.000"),
	endedAt: at("14:00:04.000"),
	keys: [{ key: "r", relaySpeech: "relay text" }],
	guard: { ok: true, detail: "Check - Chrome" },
	corroboration: corroboration(),
	...overrides,
});

test("delivery excludes lone modifiers using recorded indices after address keys", () => {
	const step = journey([{ id: "a", intent: "Navigate", address: "check.html", keys: ["Tab", "Tab", "Control"] }]).steps[0]!;
	const keys: StepRecord["keys"] = [
		{ key: "Control+l", source: "address", capture: false, relaySpeech: "" },
		{ key: "Enter", source: "address", capture: false, relaySpeech: "" },
		{ key: "Tab", source: "journey", capture: false, relaySpeech: "" },
		{ key: "Tab", source: "journey", capture: false, relaySpeech: "" },
		{ key: "Control", source: "journey", capture: false, relaySpeech: "" },
	];
	const events = ["control+l", "enter", "tab", "tab"].map((text, index) => ({ kind: "input" as const, text: `kb(desktop):${text}`, timeOfDayMs: timeOfDayMs(at("14:00:01.100") + index * 100) }));
	const result = evaluateStep(step, record({ keys, address: "http://127.0.0.1:4000/check.html" }), events);
	assert.equal(result.classification, "expected");
	assert.deepEqual(result.inputEvents.filter((event) => event.attribution === "journey").map((event) => event.keyIndex), [2, 3]);
	const missing = evaluateStep(step, record({ keys }), events.slice(0, -1));
	assert.equal(missing.classification, "inconclusive-automation");
	assert.match(missing.reasons.join(" "), /logged 1 of 2/);
});

test("typed echoes are exempt only between typed address Control+l and Enter", () => {
	const step = journey([{ id: "a", intent: "Address", address: "check.html" }]).steps[0]!;
	const observed = record({ address: "http://127.0.0.1:4000/check.html", keys: [
		{ key: "Control+l", source: "address", capture: false, relaySpeech: "", startedAt: at("14:00:01.200") },
		{ key: "Enter", source: "address", capture: false, relaySpeech: "", startedAt: at("14:00:02.000") },
	] });
	const echo = (time: string) => [{ kind: "typed" as const, text: "h", timeOfDayMs: timeOfDayMs(at(time)) }];
	assert.equal(evaluateStep(step, observed, echo("14:00:01.500")).classification, "expected");
	for (const time of ["14:00:01.100", "14:00:02.000", "14:00:02.500"]) {
		const result = evaluateStep(step, observed, echo(time));
		assert.equal(result.classification, "inconclusive-automation", time);
		assert.match(result.reasons.join(" "), /typed text/);
	}
	const setup = evaluateStep({ ...step, setup: true }, { ...observed, keys: [], setup: { method: "cdp", url: observed.address! } }, echo("14:00:01.500"));
	assert.equal(setup.classification, "inconclusive-automation");
	assert.match(setup.reasons.join(" "), /typed text/);
});

test("a step is expected only when NVDA received the key and spoke the task facts", () => {
	assert.equal(timeOfDayMs(at("14:00:01.000")), (14 * 3600 + 1) * 1000);
	const events = logEvents(parseNvdaLog(LOG));
	const [step] = journey([{ id: "find-radio", intent: "Find the first answer", keys: ["r"], expect: { spoken: ["not checked", "1 of 4"], focus: { role: "radio" } } }]).steps;
	const result = evaluateStep(step!, record(), events);
	assert.equal(result.classification, "expected");
	assert.equal(result.speech.source, "nvda-log");
	assert.deepEqual(result.inputs, ["kb(desktop):r"]);
	assert.deepEqual(result.harnessInputs, ["kb(desktop):control"]);
	assert.deepEqual(result.modes, ["focus"]);
	assert.ok(!result.speech.phrases.includes("it's later"), "speech after the step window is not attributed to it");
});

test("automation problems are inconclusive, never defects", () => {
	const events = logEvents(parseNvdaLog(LOG));
	const [step] = journey([{ id: "submit", intent: "Submit", keys: ["Enter"], expect: { spoken: ["Incorrect"] } }]).steps;
	const missingKey = evaluateStep(step!, record(), events);
	assert.equal(missingKey.classification, "inconclusive-automation");
	assert.match(missingKey.reasons.join(" "), /logged 0 of 1/);
	const guard = evaluateStep(step!, record({ guard: { ok: false, detail: "foreground window belongs to process 9" } }), null);
	assert.equal(guard.classification, "inconclusive-automation");
	assert.equal(evaluateStep(step!, undefined, events).classification, "not-run");
	const [task] = journey([{ id: "find-radio", intent: "Move", keys: ["r"], expect: { path: "next.html" } }]).steps;
	const addressBar = evaluateStep(task!, record({ corroboration: corroboration({ pageFocused: false }) }), events);
	assert.equal(addressBar.classification, "inconclusive-automation", "keys typed into the address bar are not a course defect");
	assert.match(addressBar.reasons.join(" "), /browser's own interface/);
	const typing = evaluateStep(task!, record({ startedAt: at("14:00:04.200"), endedAt: at("14:00:04.800") }), events);
	assert.equal(typing.classification, "inconclusive-automation", "letters typed into the page in focus mode are not a course defect");
	assert.match(typing.reasons.join(" "), /typed text \("b"\)/);
	const [address] = journey([{ id: "find-radio", intent: "Open", address: "check.html" }]).steps;
	const typedAddress = evaluateStep(address!, record({ keys: [
		{ key: "Control+l", source: "address", capture: false, relaySpeech: "", startedAt: at("14:00:04.200") },
		{ key: "Enter", source: "address", capture: false, relaySpeech: "", startedAt: at("14:00:04.700") },
	], address: "http://127.0.0.1:4000/check.html", startedAt: at("14:00:04.200"), endedAt: at("14:00:04.800") }), events);
	assert.equal(typedAddress.classification, "expected", "typing an address into the address bar is the step working");
	const [recover] = journey([{ id: "find-radio", intent: "Try again", keys: ["r"], expect: { focus: { notOn: "body" } } }]).steps;
	const lost = evaluateStep(recover!, record({ corroboration: corroboration({ focused: { tag: "body", role: "none", name: "", description: "", states: [] } }) }), events);
	assert.equal(lost.classification, "application-defect-candidate", "focus dropped to the page body is a defect candidate even when NVDA says nothing");
	assert.equal(evaluateStep(recover!, record(), events).classification, "expected");
});

test("missing speech is triaged against what the browser exposed", () => {
	const [step] = journey([{ id: "find-radio", intent: "Submit", keys: ["r"], expect: { spoken: [{ text: "Feedback: Incorrect", via: "live" }] } }]).steps;
	const events = logEvents(parseNvdaLog(LOG));
	const exposed = evaluateStep(step!, record({ corroboration: corroboration({ liveRegions: ["Feedback: Incorrect. Try again."] }) }), events);
	assert.equal(exposed.classification, "compatibility-candidate");
	const hidden = evaluateStep(step!, record(), events);
	assert.equal(hidden.classification, "application-defect-candidate");
	const [reading] = journey([{ id: "find-radio", intent: "Read", keys: ["r"], expect: { spoken: [{ text: "Attempt 1 of 2", via: "reading" }] } }]).steps;
	assert.equal(evaluateStep(reading!, record(), events).classification, "needs-review");
	const [task] = journey([{ id: "find-radio", intent: "Move", keys: ["r"], expect: { path: "next.html" } }]).steps;
	assert.equal(evaluateStep(task!, record(), events).classification, "application-defect-candidate");
});

test("without an NVDA log the relay speech is used and delivery is unverified", () => {
	const [step] = journey([{ id: "find-radio", intent: "Find", keys: ["r"], expect: { spoken: ["relay text"] } }]).steps;
	const result = evaluateStep(step!, record(), null);
	assert.equal(result.classification, "inconclusive-automation");
	assert.equal(result.speech.source, "guidepup-relay");
	assert.match(result.reasons.join(" "), /unverified/);
});

test("setting differences name what departs from NVDA defaults", () => {
	assert.deepEqual(settingDifferences({ keyboard: { speakTypedCharacters: 1 } }), []);
	assert.deepEqual(settingDifferences({ keyboard: { speakTypedCharacters: 2 } }), ["keyboard.speakTypedCharacters=2 (default 1)"]);
	assert.deepEqual(settingDifferences({ virtualBuffers: { autoSayAllOnPageLoad: false }, speech: { synth: "oneCore", oneCore: { rate: 100 } }, remote: { enabled: true } }), [
		"virtualBuffers.autoSayAllOnPageLoad=false (default true)",
		"speech.synth=\"oneCore\" (default \"auto\")",
		"speech.oneCore={\"rate\":100}",
		"remote.enabled=true (Guidepup's Remote Access relay on 127.0.0.1)",
	]);
});

test("the runner stops at the first failed window guard and always stops NVDA and the browser", async () => {
	const calls: string[] = [];
	let clock = at("14:00:00.000");
	const nvda: NvdaDriver = {
		version: "test",
		start: async () => { calls.push("start"); },
		stop: async () => { calls.push("stop"); },
		press: async (key) => { calls.push(`press ${key}`); return { spokenPhrase: `said ${key}` }; },
		type: async (text) => { calls.push(`type ${text}`); },
		getSettings: () => ({}),
	};
	let guards = 0;
	const browser: JourneyBrowser = {
		open: async (url) => { calls.push(`open ${url}`); },
		navigateSetup: async (url) => { calls.push(`setup ${url}`); },
		guard: async (_origin, options) => {
			calls.push(`guard${options?.pageFocus === false ? " without page focus" : ""}`);
			return ++guards > 4 ? { ok: false, detail: "someone clicked elsewhere" } : { ok: true, detail: "ok" };
		},
		corroborate: async () => corroboration(),
		screenshot: async () => undefined,
		close: async () => { calls.push("close"); },
	};
	const run = await runJourney({
		journey: journey([
			{ id: "load", intent: "Listen", waitMs: 10 },
			{ id: "open", intent: "Open", address: "check.html", setup: true, keys: ["1"] },
			{ id: "next", intent: "Next", keys: ["h"] },
		]),
		origin: "http://127.0.0.1:4000",
		nvda,
		browser,
		nvdaSettings: {},
		startupWaitMs: 0,
		sleep: async () => {},
		now: () => (clock += 100),
	});
	assert.deepEqual(calls, [
		"start", "open http://127.0.0.1:4000/index.html", "guard",
		"guard", "setup http://127.0.0.1:4000/check.html", "guard", "press Control", "guard", "press 1",
		"guard", "stop", "close",
	]);
	assert.equal(run.records.length, 3);
	assert.deepEqual(run.records[1]!.keys.map((key) => key.relaySpeech), ["", ""]);
	assert.equal(run.records[1]!.setup?.verified, true);
	assert.match(run.stopped ?? "", /before step next: someone clicked elsewhere/);
	assert.ok(run.records[0]!.startedAt < run.records[0]!.endedAt);
});

test("runner exposes both cleanup failures and preserves an earlier startup error", async () => {
	for (const startupError of [false, true]) {
		const calls: string[] = [];
		const nvda: NvdaDriver = { version: "test", start: async () => {}, stop: async () => { calls.push("nvda stop"); throw new Error("NVDA cleanup failed"); }, type: async () => {}, press: async () => {}, getSettings: () => ({}) };
		const browser: JourneyBrowser = { open: async () => { if (startupError) throw new Error("Browser startup failed"); }, guard: async () => ({ ok: true, detail: "ok" }), corroborate: async () => corroboration(), screenshot: async () => undefined, close: async () => { calls.push("browser close"); throw new Error("Browser cleanup failed"); } };
		await assert.rejects(syntheticRun([{ id: "a", intent: "Listen", waitMs: 0 }], { nvda, browser }), (error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(error.errors.map((entry: Error) => entry.message), [...(startupError ? ["Browser startup failed"] : []), "NVDA cleanup failed", "Browser cleanup failed"]);
			assert.ok("run" in error, "cleanup errors retain the run evidence");
			const retained = error.run as { records: Array<{ id: string }> };
			assert.deepEqual(retained.records.map((entry) => entry.id), startupError ? [] : ["a"]);
			return true;
		});
		assert.deepEqual(calls, ["nvda stop", "browser close"]);
	}
});

test("fileVersion reads a Windows file version from a path with spaces and punctuation", { skip: process.platform !== "win32" }, async () => {
	const { fileVersion } = await import("../src/nvda-windows.ts");
	const dir = await mkdtemp(join(tmpdir(), "praxity check's nvda "));
	try {
		const copy = join(dir, "node (copy).exe");
		await copyFile(process.execPath, copy);
		assert.equal(await fileVersion(copy), process.version.slice(1));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

const timedSpeech = (epochMs: number, text: string): SpeechEvent => ({ epochMs, timeOfDayMs: timeOfDayMs(epochMs), kind: "speech", text, normalizedText: text.toLowerCase(), wordCount: wordCount(text) });
const media = (epochMs: number, event: "playing" | "pause" | "ended" | "error" | "play", mediaId = "audio-1"): BrowserEvent => ({ epochMs, kind: "media", event, mediaId, src: `http://localhost/${mediaId}.wav`, currentTime: 0, paused: event !== "playing", muted: false, volume: 1, playbackRate: 1, error: null });

test("new journey fields validate strictly and preserve the existing defaults", () => {
	const [step] = journey([{ id: "listen", intent: "Observe", capture: false, snapshot: true, waitFor: { event: "live-text", match: "Ready", timeoutMs: 500 }, expect: { fragment: "#slide-2", activeSlide: "Slide two", maxWords: 0 } }]).steps;
	assert.equal(step!.capture, false);
	assert.equal(step!.snapshot, true);
	assert.deepEqual(step!.waitFor, { event: "live-text", match: "Ready", timeoutMs: 500 });
	assert.equal(step!.expect.fragment, "#slide-2");
	assert.equal(step!.expect.activeSlide, "Slide two");
	assert.equal(step!.expect.maxWords, 0);
	for (const event of ["media-ended", "media-playing", "slide-change", "live-text"]) assert.doesNotThrow(() => journey([{ id: "a", intent: "Wait", waitFor: { event, timeoutMs: 0 } }]));
	for (const bad of [
		{ capture: "false" }, { snapshot: 1 }, { waitFor: null }, { waitFor: [] },
		{ waitFor: { event: "speech", timeoutMs: 5 } }, { waitFor: { event: "media-ended" } },
		{ waitFor: { event: "media-playing", timeoutMs: -1 } }, { waitFor: { event: "media-playing", timeoutMs: 120001 } },
		{ waitFor: { event: "slide-change", timeoutMs: 1.5 } }, { waitFor: { event: "live-text", timeoutMs: 0, match: " " } },
		{ waitFor: { event: "live-text", timeoutMs: 1, match: 3 } },
		{ expect: { fragment: 4 } }, { expect: { fragment: "slide-2" } }, { expect: { activeSlide: "" } },
		{ expect: { activeSlide: 3 } }, { expect: { maxWords: -1 } }, { expect: { maxWords: 1.5 } }, { expect: { maxWords: "3" } }, { expect: [] },
	]) assert.throws(() => journey([{ id: "a", intent: "Bad", ...bad }]), /journey:/, JSON.stringify(bad));
	const [old] = journey([{ id: "a", intent: "Old" }]).steps;
	assert.equal(old!.capture, undefined);
	assert.equal(old!.waitFor, undefined);
	assert.equal(old!.waitMs, 1500);
	assert.doesNotThrow(() => journey([{ id: "a", intent: "No fragment", expect: { fragment: "" } }]));
});

test("speech timeline crosses midnight and uses disjoint step windows", () => {
	const start = at("23:59:59.000"), end = start + 3000;
	const events = [
		{ timeOfDayMs: 86_398_000, kind: "speech" as const, text: "Before" },
		{ timeOfDayMs: 86_399_500, kind: "speech" as const, text: "First" },
		{ timeOfDayMs: 500, kind: "speech" as const, text: "Second" },
		{ timeOfDayMs: 2000, kind: "speech" as const, text: "Next step" },
	];
	assert.deepEqual(epochLogEvents(events, start).map((event) => event.epochMs), [start - 1000, start + 500, start + 1500, end]);
	const [step] = journey([{ id: "listen", intent: "Listen" }]).steps;
	const result = evaluateStep(step!, record({ startedAt: start, endedAt: end, keys: [] }), events);
	assert.deepEqual(result.speech.phrases, ["First", "Second"]);
	assert.deepEqual(result.speech.events.map((event) => event.epochMs), [start + 500, start + 1500]);
	assert.deepEqual(result.timeline.map((item) => item.relativeMs), [500, 1500]);
	assert.deepEqual(evaluateStep(step!, record({ startedAt: end, endedAt: end + 1000, keys: [] }), events).speech.phrases, ["Next step"]);
});

test("verbosity normalizes Unicode words, repeats and key-to-speech latency", () => {
	assert.equal(wordCount(" Hello, WORLD! déjà-vu 42 "), 5);
	assert.equal(wordCount("..."), 0);
	const start = at("14:00:01.000");
	const events = [
		{ timeOfDayMs: timeOfDayMs(start + 100), kind: "input" as const, text: "kb(desktop):r" },
		{ timeOfDayMs: timeOfDayMs(start + 150), kind: "speech" as const, text: "Hello, world!" },
		{ timeOfDayMs: timeOfDayMs(start + 450), kind: "speech" as const, text: "HELLO world." },
		{ timeOfDayMs: timeOfDayMs(start + 600), kind: "speech" as const, text: "Next" },
	];
	const [step] = journey([{ id: "a", intent: "Read", keys: ["r"] }]).steps;
	const result = evaluateStep(step!, record({ keys: [{ key: "r", relaySpeech: "", startedAt: start + 100 }] }), events);
	assert.deepEqual(result.speech.events.map((event) => event.wordCount), [2, 2, 1]);
	assert.deepEqual(result.verbosity, { totalWords: 5, eventCount: 3, firstKeyToFirstSpeechMs: 50, firstKeyToLastSpeechMs: 500, repeatedPhrases: [{ phrase: "hello world", count: 2 }] });
	assert.equal(summarizeJourney([result]).totalWords, 5);
	assert.equal(summarizeJourney([result]).repeatedPhraseCount, 1);
});

test("maxWords is a review budget and preserves defect and automation precedence", () => {
	const [step] = journey([{ id: "a", intent: "Listen", expect: { maxWords: 1 } }]).steps;
	const events = [{ timeOfDayMs: timeOfDayMs(at("14:00:02")), kind: "speech" as const, text: "Two words" }];
	const result = evaluateStep(step!, record({ keys: [] }), events);
	assert.equal(result.classification, "needs-review");
	assert.equal(result.checks[0]!.met, false);
	assert.equal(evaluateStep({ ...step!, expect: { ...step!.expect, maxWords: 2 } }, record({ keys: [] }), events).classification, "expected");
	assert.equal(evaluateStep({ ...step!, expect: { ...step!.expect, fragment: "#missing" } }, record({ keys: [] }), events).classification, "application-defect-candidate");
	assert.equal(evaluateStep(step!, record({ guard: { ok: false, detail: "failed" } }), events).classification, "inconclusive-automation");
});

test("narration intervals carry across steps and overlap counts request starts once", () => {
	const events = [media(50, "play"), media(100, "playing"), media(200, "playing"), media(700, "pause"), media(900, "playing"), media(1000, "ended"), media(1100, "playing"), { epochMs: 1200, kind: "navigation" as const, event: "document-hidden" as const, url: "http://localhost/next" }];
	const intervals = narrationIntervals(events, 300, 1300);
	assert.deepEqual(intervals.map((interval) => [interval.startMs, interval.endMs]), [[300, 700], [900, 1000], [1100, 1200]]);
	const overlap = computeOverlap([timedSpeech(300, "At start"), timedSpeech(699, "During"), timedSpeech(700, "At pause"), timedSpeech(950, "Later")], intervals);
	assert.equal(overlap.speechRequestsDuringNarration, 3);
	assert.equal(overlap.totalMs, 500);
	assert.equal(overlap.acousticOverlapMs, null);
	const concurrent = [...intervals, { startMs: 500, endMs: 800, mediaId: "audio-2", src: "other.wav" }];
	assert.equal(computeOverlap([timedSpeech(600, "One request")], concurrent).totalMs, 500, "concurrent media windows are unioned");
	assert.equal(computeOverlap([timedSpeech(600, "One request")], concurrent).speechRequestsDuringNarration, 1);
	assert.equal(computeOverlap([], intervals).totalMs, 0);
	assert.deepEqual(narrationIntervals([media(100, "playing"), media(400, "error")], 0, 500).map((interval) => [interval.startMs, interval.endMs]), [[100, 400]]);
});

test("key delivery consumes repeated gestures in order", () => {
	const input = (text: string, epochMs: number) => ({ epochMs, timeOfDayMs: epochMs, kind: "input" as const, text: `kb(desktop):${text}` });
	const keys = ["r", "r", "enter"].map((key) => ({ key: key === "enter" ? "Enter" : key, relaySpeech: "" }));
	assert.equal(matchKeyDelivery(keys, [input("r", 1), input("enter", 2)]).delivered, 2);
	assert.equal(matchKeyDelivery(keys, [input("enter", 1), input("r", 2), input("r", 3)]).delivered, 2);
	assert.equal(matchKeyDelivery(keys, [input("r", 1), input("r", 2), input("enter", 3)]).delivered, 3);
	const [step] = journey([{ id: "a", intent: "Repeat", keys: ["r", "r"] }]).steps;
	assert.equal(evaluateStep(step!, record(), [{ timeOfDayMs: timeOfDayMs(at("14:00:02")), kind: "input", text: "kb(desktop):r" }]).classification, "inconclusive-automation");
});

test("a lone Control is not required in NVDA's input log", () => {
	const [step] = journey([{ id: "a", intent: "Stop speech, go to top, next landmark", keys: ["Control", "Control+Home", "d"] }]).steps;
	const events = [
		{ timeOfDayMs: timeOfDayMs(at("14:00:02")), kind: "input" as const, text: "kb(desktop):control+home" },
		{ timeOfDayMs: timeOfDayMs(at("14:00:03")), kind: "input" as const, text: "kb(desktop):d" },
	];
	assert.notEqual(evaluateStep(step!, record(), events).classification, "inconclusive-automation");
	const [missing] = journey([{ id: "b", intent: "Go to top, next landmark", keys: ["Control", "Control+Home", "d"] }]).steps;
	assert.equal(evaluateStep(missing!, record(), [events[0]!]).classification, "inconclusive-automation", "a missing real gesture still fails delivery");
});

test("deliberate Control is distinct from capture Control within call windows", () => {
	const input = (epochMs: number) => ({ epochMs, timeOfDayMs: epochMs, kind: "input" as const, text: "kb(desktop):control" });
	const keys = [{ key: "Control", relaySpeech: "", capture: true, source: "journey" as const, startedAt: 10, endedAt: 30 }];
	const delivered = matchKeyDelivery(keys, [input(1), input(15), input(20), input(40)]);
	assert.equal(delivered.delivered, 1);
	assert.deepEqual(delivered.events.map((event) => event.attribution), ["unattributed", "harness", "journey", "unattributed"]);
	assert.equal(matchKeyDelivery(keys, [input(15)]).delivered, 0, "capture Control cannot prove deliberate delivery");
	assert.equal(matchKeyDelivery([{ ...keys[0]!, capture: false }], [input(15)]).events[0]!.attribution, "journey");
	assert.deepEqual(matchKeyDelivery(keys, [input(15), input(20), input(25)]).events.map((event) => event.attribution), ["harness", "harness", "journey"], "Guidepup can repeat stopSpeech before its deliberate action");
	assert.equal(matchKeyDelivery([{ ...keys[0]!, capture: false }], [input(40)]).delivered, 1, "uncaptured delivery can be logged after the relay call returns");
});

test("fragment and slide checks use the observer's current identity", () => {
	const [step] = journey([{ id: "a", intent: "Orient", expect: { fragment: "#slide-2", activeSlide: "Slide two" } }]).steps;
	const observed = record({ keys: [], corroboration: corroboration({ url: "http://localhost/deck.html#slide-2", activeSlide: { id: "slide-2", name: "Slide two" } }) });
	assert.equal(evaluateStep(step!, observed, []).classification, "expected");
	assert.equal(evaluateStep({ ...step!, expect: { ...step!.expect, activeSlide: "slide-2" } }, observed, []).classification, "expected");
	assert.equal(evaluateStep({ ...step!, expect: { ...step!.expect, activeSlide: "slide" } }, observed, []).classification, "application-defect-candidate", "slide names match wholly, not a fragment");
	assert.equal(evaluateStep(step!, record({ keys: [] }), []).classification, "application-defect-candidate");
	assert.equal(evaluateStep(step!, record({ keys: [], corroboration: undefined }), []).checks.every((check) => check.met), false);
});

test("waitFor polls without keys, ignores older events and records timeout or early match", async () => {
	let clock = 1000;
	const delays: number[] = [];
	let reads = 0;
	const browser: JourneyBrowser = { open: async () => {}, guard: async () => ({ ok: true, detail: "ok" }), corroborate: async () => corroboration(), screenshot: async () => undefined, close: async () => {}, observe: async () => { reads++; return { events: [media(999, "ended")], activeSlide: null }; } };
	const sleep = async (ms: number) => { clock += ms; delays.push(ms); };
	const timeout = await waitForBrowserEvent(browser, { event: "media-ended", timeoutMs: 250 }, 1000, sleep, () => clock);
	assert.equal(timeout.status, "timeout");
	assert.equal(timeout.endedAt - timeout.startedAt, 250);
	assert.deepEqual(delays, [100, 100, 50]);
	assert.equal(reads, 4);
	browser.observe = async () => ({ events: [media(clock, "playing")], activeSlide: null });
	const matched = await waitForBrowserEvent(browser, { event: "media-playing", match: "audio-1.wav", timeoutMs: 1000 }, clock, sleep, () => clock);
	assert.equal(matched.status, "matched");
	assert.equal(matched.endedAt - matched.startedAt, 0);
	const [step] = journey([{ id: "a", intent: "Wait", waitFor: { event: "media-ended", timeoutMs: 250 } }]).steps;
	assert.equal(evaluateStep(step!, record({ keys: [], waitFor: timeout }), []).classification, "needs-review");
	assert.ok(matchesWaitEvent({ epochMs: 1, kind: "slide", event: "slide-change", slide: { id: "two", name: "Slide two" } }, { event: "slide-change", match: "two", timeoutMs: 1 }));
	assert.ok(matchesWaitEvent({ epochMs: 1, kind: "live", event: "live-text", id: "status", className: "", ariaLive: "polite", role: "status", text: "Ready", cleared: false }, { event: "live-text", match: "Ready", timeoutMs: 1 }));
	await assert.rejects(waitForBrowserEvent({ ...browser, observe: undefined }, { event: "media-ended", timeoutMs: 0 }, clock, sleep, () => clock), /does not support/);
});

test("runJourney passes capture and snapshot options and replaces fixed wait with event wait", async () => {
	let clock = at("14:00:00"), observedCapture: unknown;
	const waits: number[] = [];
	const nvda: NvdaDriver = { version: "synthetic", start: async () => {}, stop: async () => {}, type: async () => {}, getSettings: () => ({}), press: async (_key, options) => { observedCapture = options?.capture; clock += 10; } };
	let captureOptions: unknown;
	const browser: JourneyBrowser = { open: async () => {}, guard: async () => ({ ok: true, detail: "ok" }), corroborate: async (options) => { captureOptions = options; return corroboration(); }, screenshot: async () => undefined, close: async () => {}, observe: async () => ({ events: [], activeSlide: null }) };
	const run = await runJourney({ journey: journey([{ id: "listen", intent: "Stop then listen", keys: ["Control"], capture: false, snapshot: true, waitMs: 5000, waitFor: { event: "media-ended", timeoutMs: 150 } }]), origin: "http://localhost", nvda, browser, nvdaSettings: {}, startupWaitMs: 0, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
	assert.equal(observedCapture, false);
	assert.deepEqual(waits, [0, 250, 100, 50]);
	assert.deepEqual(captureOptions, { since: run.records[0]!.startedAt, snapshot: true });
	assert.equal(run.records[0]!.waitFor?.status, "timeout");
	assert.equal(run.records[0]!.keys[0]!.source, "journey");
	assert.equal(run.records[0]!.keys[0]!.capture, false);
	assert.equal(run.records[0]!.keys[0]!.endedAt! - run.records[0]!.keys[0]!.startedAt!, 10);
});

test("transient live text remains corroboration after the region clears", () => {
	const [step] = journey([{ id: "a", intent: "Listen", expect: { spoken: [{ text: "Ready", via: "live" }] } }]).steps;
	const result = evaluateStep(step!, record({ keys: [], corroboration: corroboration({ observerEvents: [
		{ epochMs: at("14:00:02"), kind: "live", event: "live-text", id: "status", className: "notice", ariaLive: "polite", role: "status", text: "Ready", cleared: false },
		{ epochMs: at("14:00:03"), kind: "live", event: "live-text", id: "status", className: "notice", ariaLive: "polite", role: "status", text: "", cleared: true },
	] }) }), []);
	assert.equal(result.classification, "compatibility-candidate");
	assert.equal(result.timeline.length, 2);
});

test("orientation keeps all exposed AX landmarks and headings", async () => {
	const { orientationFromAxNodes } = await import("../src/nvda-windows.ts");
	const result = orientationFromAxNodes([
		{ role: { value: "main" }, name: { value: "Lesson" }, properties: [{ name: "focusable", value: { value: true } }] },
		{ role: { value: "navigation" }, name: { value: "Pages" } },
		{ role: { value: "region" }, name: { value: "Audio" } },
		{ role: { value: "heading" }, name: { value: "Introduction" }, properties: [{ name: "level", value: { value: 2 } }] },
		{ role: { value: "heading" }, name: { value: "Hidden" }, ignored: true },
	]);
	assert.deepEqual(result, { landmarks: [{ role: "main", name: "Lesson" }, { role: "navigation", name: "Pages" }, { role: "region", name: "Audio" }], headings: [{ level: 2, name: "Introduction" }], focusableCount: 1 });
});

test("audio ducking records readable effective config values including zero", () => {
	assert.equal(audioDuckingSetting({ audio: { audioDuckingMode: 0 } }), 0);
	assert.equal(audioDuckingSetting({ audio: { audioDuckingMode: 2 } }), 2);
	assert.equal(audioDuckingSetting({ speech: { audioDuckingMode: 1 } }), 1);
	assert.equal(audioDuckingSetting({}), null);
});

test("Markdown renders relative timeline, verbosity, intervals and orientation", () => {
	const parsed = journey([{ id: "listen", intent: "Observe", snapshot: true }]);
	const observed = record({ keys: [], corroboration: corroboration({ orientation: { landmarks: [{ role: "main", name: "Lesson" }], headings: [{ level: 1, name: "Start" }], focusableCount: 2 }, mediaIntervals: [{ startMs: at("14:00:01"), endMs: at("14:00:03"), mediaId: "a", src: "audio.wav" }] }) });
	const result = evaluateStep(parsed.steps[0]!, observed, [{ timeOfDayMs: timeOfDayMs(at("14:00:02")), kind: "speech", text: "Synthetic speech" }]);
	const markdown = renderJourneyMarkdown(parsed, { records: [observed], startedAt: observed.startedAt, endedAt: observed.endedAt, effectiveSettings: null }, [result], { windows: "test", nvda: "test", browser: "test", guidepup: "test", node: "test", session: "test", synthesizer: "test", journeySha256: "test", settingsNotDefault: [], autoplayPolicy: "no-user-gesture-required", browserArgs: ["--synthetic"], audioDucking: 0 });
	assert.match(markdown, /\+1000 ms.*speech request, 2 words/);
	assert.match(markdown, /2 words, 1 events/);
	assert.match(markdown, /NVDA log time is a speech request time, not acoustic duration/);
	assert.match(markdown, /Narration playing interval \+0 to \+2000 ms/);
	assert.match(markdown, /Landmark main: "Lesson"/);
	assert.match(markdown, /Audio ducking setting: 0/);
});

test("headless synthetic course observer captures startup, navigation, media and cleared live text", { skip: !process.env.PRAXITY_NVDA_TEST_BROWSER }, async () => {
	const { ChromiumJourneyBrowser } = await import("../src/nvda-windows.ts");
	const { serve } = await import("../src/serve.ts");
	const dir = await mkdtemp(join(tmpdir(), "praxity-nvda-synthetic-"));
	const html = `<!doctype html><title>Synthetic deck</title><nav><a data-deck-page="one" aria-current="page" href="#one">Slide one</a></nav><main aria-label="Lesson"><article data-deck-slide="one" id="one" aria-label="Slide one"><h1>One</h1></article><article data-deck-slide="two" id="two" aria-label="Slide two" hidden inert><h2>Two</h2></article><audio id="audio" src="clip.wav"></audio><div role="status" id="status" aria-live="polite"></div><button>Play</button></main><script>
	const audio = document.getElementById('audio'); audio.dispatchEvent(new Event('playing'));
	setTimeout(() => { one.hidden = true; one.inert = true; two.hidden = false; two.inert = false; location.hash = 'two'; document.getElementById('status').textContent = 'Ready'; }, 200);
	async function waitForFixture(name) { while (!(await fetch(name, {cache:'no-store'})).ok) await new Promise(resolve => setTimeout(resolve, 50)); }
	setTimeout(async () => {
	  document.getElementById('status').textContent = ''; audio.dispatchEvent(new Event('pause')); audio.dispatchEvent(new Event('ended'));
	  await waitForFixture('panel-ready.json'); document.querySelector('main').inert = true; document.getElementById('status').textContent = 'Panel opened';
	  await waitForFixture('navigation-ready.json'); location.href = 'second.html';
	}, 400);
	</script>`;
	await writeFile(join(dir, "index.html"), html);
	await writeFile(join(dir, "second.html"), `<!doctype html><title>Second</title><article data-deck-slide="three" id="three" aria-label="Slide three"><h1>Three</h1></article><div role="status">Next</div>`);
	const server = await serve(dir);
	const browser = new ChromiumJourneyBrowser({ executable: process.env.PRAXITY_NVDA_TEST_BROWSER!, screenshots: dir, args: ["--headless=new", "--mute-audio", "--disable-background-networking", ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
	try {
		const start = Date.now();
		await browser.open(`${server.origin}/index.html`);
		const sleep = async (ms: number) => { await new Promise((resolve) => setTimeout(resolve, ms)); };
		assert.equal((await waitForBrowserEvent(browser, { event: "media-ended", timeoutMs: 5000 }, start, sleep, Date.now)).status, "matched");
		const observed = await browser.corroborate({ since: start, snapshot: true });
		assert.equal(observed.activeSlide?.id, "two");
		assert.equal(observed.activeSlide?.name, "Slide two");
		assert.equal(observed.fragment, "#two");
		assert.ok(observed.observerEvents?.some((event) => event.kind === "media" && event.event === "playing"), "startup media event precedes DOMContentLoaded");
		assert.ok(observed.observerEvents?.some((event) => event.kind === "media" && event.event === "pause"));
		assert.ok(observed.observerEvents?.some((event) => event.kind === "navigation" && event.event === "hashchange"));
		assert.ok(observed.observerEvents?.some((event) => event.kind === "live" && event.text === "Ready"));
		assert.ok(observed.observerEvents?.some((event) => event.kind === "live" && event.id === "status" && event.cleared));
		assert.ok(observed.orientation?.landmarks.some((node) => node.role === "main"));
		assert.equal(observed.orientation?.headings[0]?.name, "Two");
		assert.ok(observed.mediaIntervals?.length);
		await writeFile(join(dir, "panel-ready.json"), "{}");
		const panel = await waitForBrowserEvent(browser, { event: "live-text", match: "Panel opened", timeoutMs: 5000 }, start, sleep, Date.now);
		assert.equal(panel.status, "matched");
		assert.equal((await browser.corroborate()).activeSlide?.id, "two", "making the workspace inert does not change the logical current slide");
		await writeFile(join(dir, "navigation-ready.json"), "{}");
		const changed = await waitForBrowserEvent(browser, { event: "slide-change", match: "three", timeoutMs: 5000 }, start, sleep, Date.now);
		assert.equal(changed.status, "matched", "the observer also runs on subsequent documents");
		const next = await browser.corroborate({ since: start, snapshot: true });
		assert.equal(next.activeSlide?.id, "three");
		assert.ok(next.observerEvents?.some((event) => event.kind === "navigation" && event.event === "document-change" && event.url.endsWith("/second.html")));
		assert.ok(next.observerEvents?.some((event) => event.kind === "media" && event.event === "playing"), "the archive survives document navigation");
		assert.equal(next.orientation?.headings[0]?.name, "Three");
	} finally {
		await browser.close();
		await server.close();
		await rm(dir, { recursive: true, force: true });
	}
});
