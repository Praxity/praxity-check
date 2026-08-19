import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { platform } from "node:os";
import { promisify } from "node:util";

import type { DiscoveredPage } from "./discover.ts";
import { PROJECT_URL, TOOL_NAME } from "./report.ts";

const run = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GUIDEPUP_VERSION = "0.24.1";

async function appleScript(source: string, args: string[] = []): Promise<string> {
	const { stdout } = await run("osascript", ["-e", source, ...args], {
		encoding: "utf8",
		timeout: 15_000,
	});
	return stdout.trim();
}

function normalized(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function includesPhrase(value: string, expected: string): boolean {
	return normalized(value).includes(normalized(expected));
}

export function resolveScreenReaderPage(
	pages: DiscoveredPage[],
	origin: string,
	requested: string,
): { file: string; url: string } {
	const url = new URL(requested, `${origin}/`);
	if (url.origin !== origin) throw new Error("--page must name an HTML page inside the audited package");
	const page = pages.find((candidate) => new URL(candidate.url).pathname === url.pathname);
	if (!page) throw new Error(`--page did not match an auditable HTML file: ${requested}`);
	return { file: page.file, url: `${page.url}${url.search}${url.hash}` };
}

const OPEN_SAFARI_WINDOW = `on run argv
tell application "Safari"
  activate
  make new document with properties {URL:(item 1 of argv)}
  return id of front window as text
end tell
end run`;

const SAFARI_WINDOW_STATE = `on run argv
set targetID to item 1 of argv as integer
tell application "Safari"
  repeat with candidate in windows
    if id of candidate is targetID then
      return (URL of current tab of candidate) & linefeed & (name of current tab of candidate)
    end if
  end repeat
end tell
return ""
end run`;

const FRONT_SAFARI_WINDOW = `on run argv
set targetID to item 1 of argv as integer
tell application "Safari"
  repeat with candidate in windows
    if id of candidate is targetID then
      set index of candidate to 1
      activate
      return URL of current tab of candidate
    end if
  end repeat
end tell
return ""
end run`;

const CLOSE_SAFARI_WINDOW = `on run argv
set targetID to item 1 of argv as integer
tell application "Safari"
  repeat with candidate in windows
    if id of candidate is targetID then
      close candidate
      exit repeat
    end if
  end repeat
end tell
end run`;

const ACTIVATE_APP = `on run argv
tell application "System Events"
  if exists process (item 1 of argv) then set frontmost of process (item 1 of argv) to true
end tell
end run`;

const OUTPUT_TEXT = `on run argv
tell application "VoiceOver" to output (item 1 of argv)
end run`;

async function openSafariWindow(url: string): Promise<string> {
	const windowId = await appleScript(OPEN_SAFARI_WINDOW, [url]);
	for (let attempt = 0; attempt < 50; attempt++) {
		const state = await appleScript(SAFARI_WINDOW_STATE, [windowId]).catch(() => "");
		if (state.split("\n")[0] === url) return windowId;
		await delay(200);
	}
	throw new Error(`Safari did not load ${url}`);
}

async function safariState(windowId: string): Promise<{ url: string; title: string }> {
	const [url = "", title = ""] = (await appleScript(SAFARI_WINDOW_STATE, [windowId])).split("\n");
	return { url, title };
}

async function currentItem(): Promise<string> {
	return appleScript('tell application "VoiceOver" to return text under cursor of vo cursor');
}

async function currentPhrase(): Promise<string> {
	return appleScript('tell application "VoiceOver" to return content of last phrase');
}

async function guardWindow(windowId: string, expectedUrl: string): Promise<void> {
	const { url } = await safariState(windowId);
	const frontmost = await appleScript('tell application "System Events" to return name of first application process whose frontmost is true');
	if (url !== expectedUrl || frontmost !== "Safari") {
		throw new Error(`Safari page guard failed: expected ${expectedUrl}, got ${url || "no page"} in ${frontmost || "no app"}`);
	}
}

async function enterWebContent(
	voiceOver: Awaited<ReturnType<typeof loadVoiceOver>>,
	windowId: string,
	url: string,
	assertActive: () => void,
): Promise<string> {
	await appleScript(FRONT_SAFARI_WINDOW, [windowId]);
	await guardWindow(windowId, url);
	assertActive();
	await voiceOver.press("Control", { capture: false });
	await voiceOver.perform(voiceOver.keyboardCommands.openItemChooser, { capture: false, timeout: 5_000 });
	await delay(500);
	for (const character of "web content") {
		await voiceOver.type(character, { capture: false });
		await delay(100);
	}
	await voiceOver.press("Enter", { capture: false });
	await delay(200);
	const { title } = await safariState(windowId);
	await voiceOver.interact({ capture: false, timeout: 5_000 });
	await voiceOver.perform(voiceOver.keyboardCommands.moveToBeginningOfText, { capture: false, timeout: 5_000 });
	await voiceOver.press("Control", { capture: false });
	await voiceOver.perform(voiceOver.keyboardCommands.moveToBeginningOfText, { capture: false, timeout: 5_000 });
	await voiceOver.next({ capture: false, timeout: 5_000 });
	await guardWindow(windowId, url);
	return `${title} web content (selected by VoiceOver item chooser)`;
}

async function focusControl(
	voiceOver: Awaited<ReturnType<typeof loadVoiceOver>>,
	windowId: string,
	url: string,
	control: string,
	assertActive: () => void,
): Promise<string> {
	const visited: string[] = [];
	for (let attempt = 0; attempt < 12; attempt++) {
		assertActive();
		await guardWindow(windowId, url);
		await voiceOver.perform(voiceOver.keyboardCommands.findNextControl, { capture: false, timeout: 5_000 });
		await delay(200);
		const item = await currentItem();
		if (includesPhrase(item, control)) return item;
		if (item && !visited.includes(item)) visited.push(item);
	}
	throw new Error(`Keyboard navigation could not find a control matching ${JSON.stringify(control)}. Last stops: ${visited.slice(-10).map((item) => JSON.stringify(item)).join(", ") || "none"}`);
}

interface SpeechCapture {
	before: string;
	changes: Array<{ atMs: number; phrase: string }>;
	speechEventsMs: number[];
}

export function clusterSpeechEvents(events: number[]): number[] {
	return events.reduce<number[]>((groups, atMs) => {
		if (groups.length === 0 || atMs - (groups.at(-1) ?? 0) > 250) groups.push(atMs);
		return groups;
	}, []);
}

function eventsNearExpected(capture: SpeechCapture, expected: string, afterMs: number): number[] {
	const observedAt = capture.changes.find((change) => includesPhrase(change.phrase, expected))?.atMs;
	if (observedAt === undefined) return [];
	// ponytail: cluster the native log burst and bound it to the observed phrase.
	// Replace this if macOS exposes a supported text-bearing speech event stream.
	return clusterSpeechEvents(capture.speechEventsMs).filter((atMs) => atMs >= observedAt - 750 && atMs <= observedAt + afterMs);
}

async function captureSpeech(
	action: () => Promise<void>,
	durationMs: number,
	assertActive: () => void,
): Promise<SpeechCapture> {
	const starts: string[] = [];
	let pending = "";
	let markReady: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => { markReady = resolve; });
	const logger = spawn("/usr/bin/log", [
		"stream",
		"--style", "compact",
		"--level", "debug",
		"--predicate", 'process == "VoiceOver" AND category == "AXTTSCommon"',
	], { stdio: ["ignore", "pipe", "ignore"] });
	logger.stdout.setEncoding("utf8");
	logger.stdout.on("data", (chunk: string) => {
		markReady?.();
		markReady = undefined;
		const lines = (pending + chunk).split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			if (line.includes("BFMakeVoiceSpecForIdentifierString")) starts.push(line.slice(0, 23));
		}
	});

	try {
		await Promise.race([ready, delay(1_000)]);
		const startedAt = Date.now();
		const before = await currentPhrase();
		const changes: SpeechCapture["changes"] = [];
		let last = before;
		await action();
		const deadline = Date.now() + durationMs;
		while (Date.now() < deadline) {
			assertActive();
			const phrase = await currentPhrase().catch(() => "");
			if (phrase !== last) {
				changes.push({ atMs: Date.now() - startedAt, phrase });
				last = phrase;
			}
			await delay(50);
		}
		return {
			before,
			changes,
			speechEventsMs: starts
				.map((timestamp) => new Date(timestamp.replace(" ", "T")).getTime() - startedAt)
				.filter((atMs) => atMs >= 0),
		};
	} finally {
		logger.kill("SIGINT");
		await Promise.race([once(logger, "exit"), delay(1_000)]).catch(() => {});
	}
}

async function loadVoiceOver() {
	return (await import("@guidepup/guidepup")).voiceOver;
}

export interface ScreenReaderRunOptions {
	page: { file: string; url: string };
	control: string;
	expected: string;
}

export async function runScreenReader(options: ScreenReaderRunOptions): Promise<string> {
	if (platform() !== "darwin") throw new Error("screen-reader currently requires macOS, Safari, and VoiceOver");
	if (await appleScript('tell application "VoiceOver" to return running') === "true") {
		throw new Error("VoiceOver is already running. Stop it before this automated session so Praxity Accessibility Audit cannot take over or stop your existing session.");
	}

	const previousApp = await appleScript('tell application "System Events" to return name of first application process whose frontmost is true');
	const voiceOver = await loadVoiceOver();
	const windows: string[] = [];
	let voiceOverStarted = false;
	let interrupted = false;
	const interrupt = () => { interrupted = true; };
	const assertActive = () => {
		if (interrupted) throw new Error("screen-reader run interrupted");
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);

	try {
		await voiceOver.start({ capture: "initial" });
		voiceOverStarted = true;
		await delay(5_000);
		const calibration = await captureSpeech(async () => { await appleScript(OUTPUT_TEXT, [options.expected]); }, 3_000, assertActive);
		const calibrationObserved = [calibration.before, ...calibration.changes.map((change) => change.phrase)]
			.some((phrase) => includesPhrase(phrase, options.expected));
		const calibrationEvents = eventsNearExpected(calibration, options.expected, 1_250);
		assertActive();
		const calibrationClean = calibrationObserved && calibrationEvents.length === 1;

		const targetWindow = await openSafariWindow(options.page.url);
		windows.push(targetWindow);
		const pageGuard = await enterWebContent(voiceOver, targetWindow, options.page.url, assertActive);
		const currentControl = await focusControl(voiceOver, targetWindow, options.page.url, options.control, assertActive);
		await delay(3_500);
		await guardWindow(targetWindow, options.page.url);
		if (!includesPhrase(await currentItem(), options.control)) throw new Error("VoiceOver left the requested control before activation");

		const beforeState = await safariState(targetWindow);
		const action = await captureSpeech(
			async () => { await voiceOver.act({ capture: false, timeout: 5_000 }); },
			8_000,
			assertActive,
		);
		assertActive();
		await guardWindow(targetWindow, options.page.url);
		const afterItem = await currentItem();
		const afterState = await safariState(targetWindow);
		const actionObserved = [action.before, ...action.changes.map((change) => change.phrase)]
			.some((phrase) => includesPhrase(phrase, options.expected));
		const actionEvents = eventsNearExpected(action, options.expected, 6_000);
		const duplicateSignal = calibrationClean && actionObserved && actionEvents.length > calibrationEvents.length;
		const [macOS, safari] = await Promise.all([
			run("sw_vers", ["-productVersion"], { encoding: "utf8" }).then(({ stdout }) => stdout.trim()),
			appleScript('tell application "Safari" to return version'),
		]);

		const phraseLines = action.changes.length
			? action.changes.map((change) => `  - ${change.atMs} ms: ${JSON.stringify(change.phrase)}`)
			: ["  - No phrase changes captured."];
		return [
			"# Screen-reader evidence",
			"",
			`Generated by ${TOOL_NAME} — created by Ariel Harlap`,
			PROJECT_URL,
			"",
			"> Evidence only. Review it before treating it as an accessibility finding.",
			"> This file may contain course text and VoiceOver speech. Review it before sharing.",
			"",
			`- Page: \`${options.page.file}\``,
			`- Requested control: ${JSON.stringify(options.control)}`,
			`- VoiceOver item activated: ${JSON.stringify(currentControl)}`,
			"- Action: VoiceOver default action (VO-Space)",
			`- Expected phrase: ${JSON.stringify(options.expected)}`,
			`- Expected phrase observed: ${actionObserved ? "yes" : "no"}`,
			`- Speech-event clusters near the expected phrase: ${actionEvents.length} (${actionEvents.join(", ") || "none"} ms)`,
			`- All native speech log events after the action: ${action.speechEventsMs.length} (${action.speechEventsMs.join(", ") || "none"} ms)`,
			`- Clean comparison: ${calibrationClean ? `${calibrationEvents.length} speech event (${calibrationEvents.join(", ")} ms)` : "failed — duplicate speech cannot be evaluated"}`,
			`- Duplicate-speech signal: ${calibrationClean ? (duplicateSignal ? "yes — more speech events than the clean comparison" : "no") : "not evaluated"}`,
			`- VoiceOver item after capture: ${JSON.stringify(afterItem)}`,
			`- Page title before/after: ${JSON.stringify(beforeState.title)} → ${JSON.stringify(afterState.title)}`,
			`- Page guard: ${JSON.stringify(pageGuard)}`,
			`- Pairing: VoiceOver + Safari ${safari}; macOS ${macOS}; Guidepup ${GUIDEPUP_VERSION}`,
			"",
			"Phrase changes after the action:",
			...phraseLines,
			"",
			"A speech event contains no phrase text and may represent unrelated VoiceOver output. The clean comparison and bounded action reduce that risk; a reviewer still decides whether an extra event is duplicate speech.",
			"",
		].join("\n");
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		if (voiceOverStarted) await voiceOver.stop().catch(() => {});
		for (const windowId of windows) await appleScript(CLOSE_SAFARI_WINDOW, [windowId]).catch(() => {});
		if (previousApp && previousApp !== "Safari") await appleScript(ACTIVATE_APP, [previousApp]).catch(() => {});
	}
}
