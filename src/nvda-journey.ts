// Experimental NVDA journey evidence. See docs/experiments/nvda-journey-pilot-2026-09-30.
//
// A journey is a short sequence of keyboard steps that a screen-reader user
// would take. NVDA itself receives every learner keystroke; the browser is read
// (URL, title, focused accessibility node, live-region text) to corroborate what
// NVDA reported. Marked setup steps may navigate through CDP. Nothing here
// clicks, focuses or navigates through the DOM.

import { PROJECT_URL, TOOL_NAME } from "./report.ts";
import type { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// Key names accepted by Guidepup's Windows keyboard (parseKey silently drops
// anything else, so journeys are validated against this list first).
const NAMED_KEYS: Record<string, string> = {
	Escape: "escape", Tab: "tab", Enter: "enter", Spacebar: "space", Backspace: "backspace",
	Home: "home", End: "end", PageUp: "pageUp", PageDown: "pageDown", Insert: "NVDA",
	ArrowUp: "upArrow", ArrowDown: "downArrow", ArrowLeft: "leftArrow", ArrowRight: "rightArrow",
	Control: "control", Shift: "shift", Alt: "alt", Application: "applications",
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `f${i + 1}`])),
};
/** Guidepup embeds text in a VBScript string before passing it to SendKeys. */
export function escapeSendKeysText(text: string): string {
	if (/["\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text)) fail("address contains characters that cannot be typed safely");
	return text.replace(/[+^%~(){}[\]]/g, (character) => `{${character}}`);
}

export type ExpectedVia = "focus" | "live" | "reading" | "any";

export interface SpokenExpectation {
	text: string;
	via: ExpectedVia;
}

export interface JourneyStep {
	id: string;
	intent: string;
	keys: string[];
	address?: string;
	/** Explicit canonical target when an address document redirects. */
	addressDestination?: string;
	/** CDP navigation simulates leaving/relaunching an LMS, not a learner action. */
	setup?: boolean;
	interKeyDelayMs?: number;
	requires?: { path?: string; fragment?: string; activeSlide?: string; focusedRole?: string };
	waitMs: number;
	waitFor?: { event: "media-ended" | "media-playing" | "slide-change" | "live-text"; match?: string; timeoutMs: number };
	capture?: boolean;
	snapshot?: boolean;
	expect: {
		spoken: SpokenExpectation[];
		notSpoken: string[];
		path?: string;
		fragment?: string;
		activeSlide?: string;
		maxWords?: number;
		/** notOn names an element (such as "body") that focus must not be left on. */
		focus?: { role?: string; name?: string; notOn?: string };
	};
}

export interface Journey {
	version: 1;
	name: string;
	start: string;
	steps: JourneyStep[];
}

function fail(message: string): never {
	throw new Error(`journey: ${message}`);
}

function stringList(value: unknown, where: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) fail(`${where} must be an array of non-empty strings`);
	return value as string[];
}

export function validateKey(key: string): void {
	const parts = key.split("+");
	if (parts.some((part) => !part)) fail(`key ${JSON.stringify(key)} has an empty part`);
	for (const part of parts) {
		if (!/^[a-z0-9]$/.test(part) && !Object.hasOwn(NAMED_KEYS, part)) {
			fail(`unknown key ${JSON.stringify(part)} in ${JSON.stringify(key)}; use lowercase letters, digits or ${Object.keys(NAMED_KEYS).join(", ")}`);
		}
	}
}

export function parseJourney(value: unknown): Journey {
	if (!value || typeof value !== "object") fail("must be a JSON object");
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1) fail("version must be 1");
	if (typeof raw.name !== "string" || !raw.name.trim()) fail("name is required");
	if (typeof raw.start !== "string" || !raw.start.trim()) fail("start must name the first page");
	if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail("steps must be a non-empty array");
	const ids = new Set<string>();
	const steps = raw.steps.map((item, index): JourneyStep => {
		if (!item || typeof item !== "object") fail(`step ${index + 1} must be an object`);
		const step = item as Record<string, unknown>;
		const where = `step ${JSON.stringify(step.id ?? index + 1)}`;
		if (typeof step.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(step.id)) fail(`${where} needs a lowercase id`);
		if (ids.has(step.id)) fail(`${where} repeats an id`);
		ids.add(step.id);
		if (typeof step.intent !== "string" || !step.intent.trim()) fail(`${where} needs an intent`);
		const keys = stringList(step.keys, `${where} keys`);
		keys.forEach(validateKey);
		if (step.address !== undefined) {
			if (typeof step.address !== "string" || !step.address) fail(`${where} address must be a non-empty page path`);
			escapeSendKeysText(step.address);
		}
		const waitMs = step.waitMs ?? 1500;
		if (typeof waitMs !== "number" || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120_000) fail(`${where} waitMs must be 0-120000`);
		if (step.setup !== undefined && (typeof step.setup !== "boolean" || !step.address)) fail(`${where} setup needs an address and must be boolean`);
		if (step.addressDestination !== undefined && (!step.address || typeof step.addressDestination !== "string" || !step.addressDestination.trim())) fail(`${where} addressDestination needs an address and a non-empty string`);
		if (step.interKeyDelayMs !== undefined && (typeof step.interKeyDelayMs !== "number" || !Number.isInteger(step.interKeyDelayMs) || step.interKeyDelayMs < 1 || step.interKeyDelayMs > 120_000)) fail(`${where} interKeyDelayMs must be 1-120000`);
		let requires: JourneyStep["requires"];
		if (step.requires !== undefined) {
			const requirement = step.requires as Record<string, unknown> | null;
			if (!requirement || typeof requirement !== "object" || Array.isArray(requirement) || !Object.keys(requirement).length) fail(`${where} requires must be a non-empty object`);
			for (const [field, value] of Object.entries(requirement)) {
				if (!["path", "fragment", "activeSlide", "focusedRole"].includes(field) || typeof value !== "string" || (field !== "fragment" && !value.trim())) fail(`${where} requires.${field} must be a supported string`);
				if (field === "fragment" && value !== "" && !value.startsWith("#")) fail(`${where} requires.fragment must be empty or start with #`);
			}
			requires = { ...requirement };
		}
		const expect = (step.expect ?? {}) as Record<string, unknown>;
		if (!expect || typeof expect !== "object" || Array.isArray(expect)) fail(`${where} expect must be an object`);
		for (const flag of ["capture", "snapshot"]) {
			if (step[flag] !== undefined && typeof step[flag] !== "boolean") fail(`${where} ${flag} must be boolean`);
		}
		let waitFor: JourneyStep["waitFor"];
		if (step.waitFor !== undefined) {
			const wait = step.waitFor as Record<string, unknown> | null;
			if (!wait || typeof wait !== "object" || Array.isArray(wait) || !["media-ended", "media-playing", "slide-change", "live-text"].includes(String(wait.event))) fail(`${where} waitFor needs a supported event`);
			if (typeof wait.timeoutMs !== "number" || !Number.isInteger(wait.timeoutMs) || wait.timeoutMs < 0 || wait.timeoutMs > 120_000) fail(`${where} waitFor.timeoutMs must be 0-120000`);
			if (wait.match !== undefined && (typeof wait.match !== "string" || !wait.match.trim())) fail(`${where} waitFor.match must be a non-empty string`);
			waitFor = { event: wait.event as NonNullable<JourneyStep["waitFor"]>["event"], timeoutMs: wait.timeoutMs, ...(wait.match === undefined ? {} : { match: wait.match as string }) };
		}
		for (const field of ["fragment", "activeSlide"]) {
			if (expect[field] !== undefined && (typeof expect[field] !== "string" || (field === "activeSlide" && !expect[field].trim()))) fail(`${where} expect.${field} must be a ${field === "activeSlide" ? "non-empty " : ""}string`);
		}
		if (expect.fragment !== undefined && expect.fragment !== "" && !(expect.fragment as string).startsWith("#")) fail(`${where} expect.fragment must be empty or start with #`);
		if (expect.maxWords !== undefined && (typeof expect.maxWords !== "number" || !Number.isInteger(expect.maxWords) || expect.maxWords < 0)) fail(`${where} expect.maxWords must be a non-negative integer`);
		const spoken = expect.spoken === undefined ? [] : Array.isArray(expect.spoken) ? expect.spoken : fail(`${where} expect.spoken must be an array`);
		const focus = expect.focus as JourneyStep["expect"]["focus"] | undefined;
		if (focus !== undefined) {
			if (!focus || typeof focus !== "object" || Array.isArray(focus) || !Object.keys(focus).length) fail(`${where} expect.focus needs role, name or notOn`);
			for (const [field, value] of Object.entries(focus)) {
				if (!["role", "name", "notOn"].includes(field) || typeof value !== "string" || !value.trim()) fail(`${where} expect.focus.${field} must be a supported non-empty string`);
			}
		}
		if (expect.path !== undefined && typeof expect.path !== "string") fail(`${where} expect.path must be a string`);
		return {
			id: step.id,
			intent: step.intent,
			keys,
			...(step.address === undefined ? {} : { address: step.address as string }),
			...(step.addressDestination === undefined ? {} : { addressDestination: step.addressDestination as string }),
			...(step.setup === undefined ? {} : { setup: step.setup as boolean }),
			...(step.interKeyDelayMs === undefined ? {} : { interKeyDelayMs: step.interKeyDelayMs as number }),
			...(requires === undefined ? {} : { requires }),
			waitMs,
			...(waitFor === undefined ? {} : { waitFor }),
			...(step.capture === undefined ? {} : { capture: step.capture as boolean }),
			...(step.snapshot === undefined ? {} : { snapshot: step.snapshot as boolean }),
			expect: {
				spoken: spoken.map((entry: unknown) => {
					if (typeof entry === "string" && entry.trim()) return { text: entry, via: "any" as const };
					const object = entry as Partial<SpokenExpectation> | null;
					if (!object || typeof object.text !== "string" || !object.text.trim() || !["focus", "live", "reading", "any"].includes(object.via ?? "any")) {
						fail(`${where} expect.spoken entries must be strings or {text, via: focus|live|reading|any}`);
					}
					return { text: object.text, via: object.via ?? "any" };
				}),
				notSpoken: stringList(expect.notSpoken, `${where} expect.notSpoken`),
				...(expect.path === undefined ? {} : { path: expect.path as string }),
				...(expect.fragment === undefined ? {} : { fragment: expect.fragment as string }),
				...(expect.activeSlide === undefined ? {} : { activeSlide: expect.activeSlide as string }),
				...(expect.maxWords === undefined ? {} : { maxWords: expect.maxWords as number }),
				...(focus === undefined ? {} : { focus }),
			},
		};
	});
	return { version: 1, name: raw.name, start: raw.start, steps };
}

/** NVDA gesture identifier parts for a Guidepup key, compared as a set. */
export function nvdaGestureParts(key: string): string[] {
	return key.split("+").map((part) => (NAMED_KEYS[part] ?? part).toLowerCase()).sort();
}

export function normalizeSpeech(value: string): string {
	return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function speechIncludes(speech: string, phrase: string): boolean {
	const needle = normalizeSpeech(phrase);
	return needle.length > 0 && ` ${normalizeSpeech(speech)} `.includes(` ${needle} `);
}

// ---------------------------------------------------------------------------
// NVDA log (level 12, Input/output)

export interface NvdaLogEntry {
	level: string;
	source: string;
	/** Milliseconds since local midnight, as NVDA prints it. */
	timeOfDayMs: number;
	message: string;
}

const LOG_HEADER = /^([A-Z]+) - (\S+) \((\d\d):(\d\d):(\d\d)\.(\d{3})\)/;

export function parseNvdaLog(text: string): NvdaLogEntry[] {
	const entries: NvdaLogEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		const header = LOG_HEADER.exec(line);
		if (header) {
			const [, level, source, h, m, s, ms] = header;
			entries.push({ level: level!, source: source!, timeOfDayMs: ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms), message: "" });
		} else if (entries.length) {
			const last = entries.at(-1)!;
			last.message = last.message ? `${last.message}\n${line}` : line;
		}
	}
	for (const entry of entries) entry.message = entry.message.replace(/\s+$/, "");
	return entries;
}

function unescapePython(body: string): string {
	return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, code: string) => {
		if (/^[xuU]/.test(code) && code.length > 1) return String.fromCodePoint(parseInt(code.slice(1), 16));
		return ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[code] ?? code;
	});
}

/**
 * Text items from NVDA's `Speaking [...]` repr. String literals nested inside
 * command objects, such as LangChangeCommand ('en'), are not speech and are skipped.
 */
export function speechTextFromRepr(repr: string): string[] {
	const start = repr.indexOf("[");
	const items: string[] = [];
	let depth = 0;
	for (let i = start + 1; i >= 1 && i < repr.length; i++) {
		const char = repr[i]!;
		if (char === "'" || char === '"') {
			let j = i + 1;
			let body = "";
			while (j < repr.length && repr[j] !== char) {
				body += repr[j] === "\\" ? repr[j]! + (repr[++j] ?? "") : repr[j];
				j++;
			}
			if (depth === 0) items.push(unescapePython(body));
			i = j;
		} else if (char === "(") depth++;
		else if (char === ")") depth = Math.max(0, depth - 1);
		else if (char === "]" && depth === 0) break;
	}
	return items.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export interface LogEvent {
	timeOfDayMs: number;
	kind: "input" | "speech" | "mode" | "typed";
	text: string;
}

export function logEvents(entries: NvdaLogEntry[]): LogEvent[] {
	const events: LogEvent[] = [];
	for (const entry of entries) {
		const input = /^Input: (.+)$/m.exec(entry.message);
		if (input) events.push({ timeOfDayMs: entry.timeOfDayMs, kind: "input", text: input[1]!.trim() });
		const speaking = /^Speaking (\[.*)$/ms.exec(entry.message);
		if (speaking) {
			const text = speechTextFromRepr(speaking[1]!).join(" ");
			if (text) events.push({ timeOfDayMs: entry.timeOfDayMs, kind: "speech", text });
		}
		// NVDA echoes characters that reach the page as text, which in a browser means focus mode.
		const typed = /^typed (?:word|character): (.*)$/m.exec(entry.message);
		if (typed) events.push({ timeOfDayMs: entry.timeOfDayMs, kind: "typed", text: typed[1]!.trim() });
		const mode = /\b(browseMode|focusMode)\.wav\b/.exec(entry.message);
		if (mode) events.push({ timeOfDayMs: entry.timeOfDayMs, kind: "mode", text: mode[1] === "focusMode" ? "focus" : "browse" });
	}
	return events;
}

export function timeOfDayMs(epochMs: number): number {
	const date = new Date(epochMs);
	return ((date.getHours() * 60 + date.getMinutes()) * 60 + date.getSeconds()) * 1000 + date.getMilliseconds();
}

export interface TimedLogEvent extends LogEvent { epochMs: number }

/** Anchor a date-less IO log near the run, then advance the local calendar at midnight. */
export function epochLogEvents(events: LogEvent[], anchorEpochMs: number): TimedLogEvent[] {
	if (!events.length) return [];
	const day = new Date(anchorEpochMs);
	day.setHours(0, 0, 0, 0);
	const onDay = (time: number) => {
		const date = new Date(day);
		date.setHours(Math.floor(time / 3_600_000), Math.floor(time / 60_000) % 60, Math.floor(time / 1000) % 60, time % 1000);
		return date.getTime();
	};
	const first = onDay(events[0]!.timeOfDayMs);
	if (first - anchorEpochMs > 43_200_000) day.setDate(day.getDate() - 1);
	else if (anchorEpochMs - first > 43_200_000) day.setDate(day.getDate() + 1);
	let previous = events[0]!.timeOfDayMs;
	return events.map((event) => {
		if (previous - event.timeOfDayMs > 43_200_000) day.setDate(day.getDate() + 1);
		previous = event.timeOfDayMs;
		return { ...event, epochMs: onDay(event.timeOfDayMs) };
	});
}

export interface SlideIdentity { id: string; name: string }
export type BrowserEvent = {
	epochMs: number;
	kind: "media";
	event: "play" | "playing" | "pause" | "ended" | "error" | "loadedmetadata" | "durationchange";
	/** Stable within a run, including across document navigations. */
	mediaId: string;
	src: string;
	currentTime: number;
	paused: boolean;
	muted: boolean;
	volume: number;
	playbackRate: number;
	/** Non-finite or unknown duration is null in JSON. */
	duration?: number | null;
	error: string | null;
} | {
	epochMs: number; kind: "navigation"; event: "hashchange" | "popstate" | "document-hidden" | "document-change"; url: string;
} | {
	epochMs: number; kind: "slide"; event: "slide-change"; slide: SlideIdentity | null;
} | {
	epochMs: number; kind: "live"; event: "live-text"; id: string; className: string; ariaLive: string | null; role: string | null; text: string; cleared: boolean;
};

export interface BrowserObservation { events: BrowserEvent[]; activeSlide: SlideIdentity | null }
export interface MediaInterval { startMs: number; endMs: number; mediaId: string; src: string }
export interface OrientationSnapshot {
	landmarks: Array<{ role: string; name: string }>;
	headings: Array<{ level: number | null; name: string }>;
	focusableCount: number;
}

/** Playing begins at `playing`, not `play`; pauses, errors, ends and navigation close it. */
export function narrationIntervals(events: BrowserEvent[], from: number, to: number): MediaInterval[] {
	const active = new Map<string, { startMs: number; src: string }>();
	const intervals: MediaInterval[] = [];
	const close = (id: string, end: number) => {
		const playing = active.get(id);
		if (!playing) return;
		const startMs = Math.max(from, playing.startMs), endMs = Math.min(to, end);
		if (endMs > startMs) intervals.push({ mediaId: id, src: playing.src, startMs, endMs });
		active.delete(id);
	};
	for (const event of [...events].sort((a, b) => a.epochMs - b.epochMs)) {
		if (event.epochMs > to) break;
		if (event.kind === "media") {
			if (event.event === "playing" && !active.has(event.mediaId)) active.set(event.mediaId, { startMs: event.epochMs, src: event.src });
			else if (["pause", "ended", "error"].includes(event.event)) close(event.mediaId, event.epochMs);
		} else if (event.kind === "navigation" && ["document-hidden", "document-change"].includes(event.event)) {
			for (const id of active.keys()) close(id, event.epochMs);
		}
	}
	for (const id of active.keys()) close(id, to);
	return intervals;
}

export interface SpeechEvent extends TimedLogEvent { normalizedText: string; wordCount: number }
export interface VerbosityMetrics {
	totalWords: number; eventCount: number;
	firstKeyToFirstSpeechMs: number | null; firstKeyToLastSpeechMs: number | null;
	repeatedPhrases: Array<{ phrase: string; count: number }>;
}

export function wordCount(text: string): number {
	const normalized = normalizeSpeech(text);
	return normalized ? normalized.split(" ").length : 0;
}

export function verbosityMetrics(phrases: string[], speech: SpeechEvent[], firstKeyMs?: number): VerbosityMetrics {
	const counts = new Map<string, number>();
	for (const phrase of phrases) {
		const normalized = normalizeSpeech(phrase);
		if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
	}
	// Latency uses requests at or after the first key, excluding page-load speech before it.
	const afterKey = firstKeyMs === undefined ? [] : speech.filter((event) => event.epochMs >= firstKeyMs);
	return {
		totalWords: phrases.reduce((sum, phrase) => sum + wordCount(phrase), 0), eventCount: phrases.length,
		firstKeyToFirstSpeechMs: afterKey.length ? afterKey[0]!.epochMs - firstKeyMs! : null,
		firstKeyToLastSpeechMs: afterKey.length ? afterKey.at(-1)!.epochMs - firstKeyMs! : null,
		repeatedPhrases: [...counts].filter(([, count]) => count > 1).map(([phrase, count]) => ({ phrase, count })),
	};
}

export interface OverlapSummary {
	/** Union of narration-playing windows containing requests. This is a timing proxy. */
	totalMs: number;
	/** Acoustic duration is unavailable in NVDA IO logs. */
	acousticOverlapMs: null;
	speechRequestsDuringNarration: number;
	/** Union of playing intervals containing speech requests, not speech/audio overlap duration. */
	narrationWindowMs: number;
	intervals: MediaInterval[];
}

export function computeOverlap(speech: SpeechEvent[], intervals: MediaInterval[]): OverlapSummary {
	const contains = (interval: MediaInterval, time: number) => time >= interval.startMs && time < interval.endMs;
	const hit = intervals.filter((interval) => speech.some((event) => contains(interval, event.epochMs)));
	let end = -Infinity, total = 0;
	for (const interval of [...hit].sort((a, b) => a.startMs - b.startMs)) {
		total += Math.max(0, interval.endMs - Math.max(end, interval.startMs));
		end = Math.max(end, interval.endMs);
	}
	return { totalMs: total, acousticOverlapMs: null, speechRequestsDuringNarration: speech.filter((event) => intervals.some((interval) => contains(interval, event.epochMs))).length, narrationWindowMs: total, intervals };
}

// ---------------------------------------------------------------------------
// Evidence and triage

export interface FocusedNode {
	role: string;
	name: string;
	description: string;
	states: string[];
	tag: string;
}

export interface Corroboration {
	url: string;
	topLevelUrl?: string;
	title: string;
	focused: FocusedNode | null;
	liveRegions: string[];
	/** document.hasFocus(): false when keyboard focus is in the browser's own UI, such as the address bar. */
	pageFocused: boolean;
	observerEvents?: BrowserEvent[];
	mediaIntervals?: MediaInterval[];
	activeSlide?: SlideIdentity | null;
	fragment?: string;
	orientation?: OrientationSnapshot;
}

export interface KeyRecord {
	key: string;
	relaySpeech: string;
	startedAt?: number;
	endedAt?: number;
	capture?: boolean;
	source?: "journey" | "address" | "harness";
	confirmation?: { status: "logged" | "unobservable-modifier" | "log-unavailable"; at: number };
}

export interface StepRecord {
	id: string;
	startedAt: number;
	endedAt: number;
	keys: KeyRecord[];
	address?: string;
	setup?: { method: "cdp"; url: string; verified?: boolean };
	requirements?: { ok: boolean; mismatches: string[]; observed: Corroboration };
	guard: { ok: boolean; detail: string };
	error?: string;
	corroboration?: Corroboration;
	screenshot?: string;
	waitFor?: { status: "matched" | "timeout"; startedAt: number; endedAt: number; matchedEvent?: BrowserEvent };
}

export type Classification = "expected" | "application-defect-candidate" | "compatibility-candidate" | "needs-review" | "inconclusive-automation" | "not-run";

export interface StepResult {
	step: JourneyStep;
	record?: StepRecord;
	speech: { source: "nvda-log" | "guidepup-relay" | "none"; phrases: string[]; events: SpeechEvent[] };
	verbosity: VerbosityMetrics;
	overlap: OverlapSummary;
	timeline: Array<{ epochMs: number; relativeMs: number; source: "nvda" | "browser"; event: SpeechEvent | BrowserEvent | InputEvent }>;
	inputEvents: InputEvent[];
	inputs: string[];
	harnessInputs: string[];
	modes: string[];
	checks: Array<{ expectation: string; met: boolean; detail: string }>;
	classification: Classification;
	reasons: string[];
}

export interface InputEvent extends TimedLogEvent { attribution: "journey" | "address" | "harness" | "unattributed"; keyIndex?: number }

/** NVDA 2026.2's IO log does not record a modifier pressed on its own, so its delivery cannot be verified. */
export function isLoneModifier(key: string): boolean {
	const parts = nvdaGestureParts(key);
	return parts.length === 1 && ["control", "shift", "alt", "windows"].includes(parts[0]!);
}

/** Consume gestures once in order. Captured deliberate Control needs two log entries. */
export function matchKeyDelivery(keys: KeyRecord[], events: TimedLogEvent[]): { delivered: number; events: InputEvent[] } {
	const inputs: InputEvent[] = events.filter((event) => event.kind === "input").map((event) => ({ ...event, attribution: "unattributed" }));
	const gesture = (text: string) => text.replace(/^[^:]*:/, "").split("+").map((part) => part.toLowerCase()).sort().join("+");
	let cursor = 0, delivered = 0;
	keys.forEach((key, keyIndex) => {
		// capture:false returns after relay dispatch, possibly before NVDA logs
		// receipt. Its upper bound is the already-filtered step window.
		const inWindow = (input: InputEvent) => (key.startedAt === undefined || input.epochMs >= key.startedAt) && (key.capture === false || key.endedAt === undefined || input.epochMs <= key.endedAt);
		const wanted = nvdaGestureParts(key.key).join("+");
		let found = inputs.findIndex((input, index) => index >= cursor && inWindow(input) && gesture(input.text) === wanted);
		if (key.capture) {
			const controls = inputs.map((input, index) => ({ input, index })).filter(({ input, index }) => index >= cursor && inWindow(input) && gesture(input.text) === "control");
			// Guidepup may repeat stopSpeech before its action. For a captured
			// deliberate Control, reserve the last Control in the call for the action.
			if (wanted === "control") found = controls.length >= 2 ? controls.at(-1)!.index : -1;
			for (const { input, index } of controls) {
				if (found >= 0 && index >= found) break;
				input.attribution = "harness"; input.keyIndex = keyIndex;
			}
		}
		if (found < 0) return;
		inputs[found]!.attribution = key.source ?? "journey";
		inputs[found]!.keyIndex = keyIndex;
		cursor = found + 1;
		if (key.source !== "address" && key.source !== "harness") delivered++;
	});
	// Old records have no capture windows. Preserve their Control annotation except consumed deliberate keys.
	if (keys.every((key) => key.capture === undefined)) {
		for (const input of inputs) if (input.attribution === "unattributed" && gesture(input.text) === "control") input.attribution = "harness";
	}
	return { delivered, events: inputs };
}

function focusText(focused: FocusedNode | null): string {
	return focused ? [focused.role, focused.name, focused.description, ...focused.states].join(" ") : "";
}

export function evaluateStep(step: JourneyStep, record: StepRecord | undefined, events: LogEvent[] | null): StepResult {
	const base = { step, record, checks: [] as StepResult["checks"], reasons: [] as string[] };
	if (!record) return { ...base, speech: { source: "none", phrases: [], events: [] }, verbosity: verbosityMetrics([], []), overlap: computeOverlap([], []), timeline: [], inputEvents: [], inputs: [], harnessInputs: [], modes: [], classification: "not-run", reasons: ["An earlier step stopped the run."] };

	const window = epochLogEvents(events ?? [], record.startedAt).filter((event) => event.epochMs >= record.startedAt && event.epochMs < record.endedAt);
	const deliveryKeys = record.keys.some((key) => key.source !== undefined) ? record.keys : step.keys.map((key) => ({ key, relaySpeech: "" }));
	const delivery = matchKeyDelivery(deliveryKeys, window);
	const harnessInputs = delivery.events.filter((event) => event.attribution === "harness").map((event) => event.text);
	const inputs = delivery.events.filter((event) => event.attribution !== "harness").map((event) => event.text);
	const speechEvents: SpeechEvent[] = window.filter((event) => event.kind === "speech").map((event) => ({ ...event, normalizedText: normalizeSpeech(event.text), wordCount: wordCount(event.text) }));
	const logSpeech = speechEvents.map((event) => event.text);
	const relaySpeech = record.keys.map((key) => key.relaySpeech).filter(Boolean);
	const speech = events ? { source: "nvda-log" as const, phrases: logSpeech, events: speechEvents } : { source: relaySpeech.length ? "guidepup-relay" as const : "none" as const, phrases: relaySpeech, events: [] };
	const modes = window.filter((event) => event.kind === "mode").map((event) => event.text);
	const addressStart = record.setup ? undefined : record.keys.find((key) => key.source === "address" && key.key === "Control+l")?.startedAt;
	// NVDA echoes the last typed word when Enter ends it, and nothing else is sent until the
	// step's next key, so the address window runs from Control+L to that key (or step end).
	const addressEnter = record.setup ? -1 : record.keys.findIndex((key) => key.source === "address" && key.key === "Enter");
	const addressEnd = addressEnter < 0 ? undefined : record.keys[addressEnter + 1]?.startedAt ?? record.endedAt;
	const typed = window.filter((event) => event.kind === "typed" && !(addressStart !== undefined && addressEnd !== undefined && event.epochMs >= addressStart && event.epochMs < addressEnd)).map((event) => event.text);
	const firstKeyMs = delivery.events.find((event) => event.attribution === "journey" || event.attribution === "address")?.epochMs ?? record.keys[0]?.startedAt;
	const timeline: StepResult["timeline"] = [
		...speechEvents.map((event) => ({ epochMs: event.epochMs, relativeMs: event.epochMs - record.startedAt, source: "nvda" as const, event })),
		...delivery.events.map((event) => ({ epochMs: event.epochMs, relativeMs: event.epochMs - record.startedAt, source: "nvda" as const, event })),
		...(record.corroboration?.observerEvents ?? []).map((event) => ({ epochMs: event.epochMs, relativeMs: event.epochMs - record.startedAt, source: "browser" as const, event })),
	].sort((a, b) => a.epochMs - b.epochMs);
	const result: StepResult = { ...base, speech, inputs, harnessInputs, modes, inputEvents: delivery.events, timeline,
		verbosity: verbosityMetrics(speech.phrases, speechEvents, firstKeyMs), overlap: computeOverlap(speechEvents, record.corroboration?.mediaIntervals ?? []), classification: "expected" };
	const spokenText = speech.phrases.join(" \n ");

	const automation: string[] = [];
	if (!record.guard.ok) automation.push(`Window guard failed: ${record.guard.detail}`);
	if (record.error) automation.push(`Driver error: ${record.error}`);
	if (record.corroboration && !record.corroboration.pageFocused) {
		automation.push("Keyboard focus was in the browser's own interface (such as the address bar), not the page, so the keys did not reach the course.");
	}
	// Typing an address into the address bar echoes too; that is the step working.
	if (typed.length) {
		automation.push(`NVDA echoed typed text (${typed.map((text) => JSON.stringify(text)).join(", ")}), so keys reached the page as typing rather than as NVDA commands. NVDA was probably left in focus mode; review the previous steps.`);
	}
	if (events && step.keys.length) {
		const verifiable = step.keys.filter((key) => !isLoneModifier(key)).length;
		const deliveredVerifiable = new Set(delivery.events.filter((event) => event.attribution === "journey" && event.keyIndex !== undefined && !isLoneModifier(deliveryKeys[event.keyIndex]!.key)).map((event) => event.keyIndex)).size;
		if (deliveredVerifiable < verifiable) {
			automation.push(`NVDA logged ${deliveredVerifiable} of ${verifiable} verifiable journey keys in order (${inputs.join(", ") || "none"}); lone modifiers are not logged by NVDA and are not counted.`);
		}
	}
	if (!events) automation.push("No NVDA input/output log; speech comes from Guidepup's relay and key delivery is unverified.");
	if (automation.length) {
		result.classification = "inconclusive-automation";
		result.reasons.push(...automation);
		return result;
	}

	const corroboration = record.corroboration;
	let review = false;
	if (step.expect.maxWords !== undefined) {
		const met = result.verbosity.totalWords <= step.expect.maxWords;
		result.checks.push({ expectation: `maxWords ${step.expect.maxWords}`, met, detail: `${result.verbosity.totalWords} normalized requested words` });
		if (!met) { review = true; result.reasons.push("Speech exceeded the word budget; review verbosity with a learner. This budget is not a conformance criterion."); }
	}
	if (record.waitFor) {
		const met = record.waitFor.status === "matched";
		result.checks.push({ expectation: `waitFor ${step.waitFor?.event}`, met, detail: met ? `matched after ${record.waitFor.endedAt - record.waitFor.startedAt} ms` : `timed out after ${record.waitFor.endedAt - record.waitFor.startedAt} ms` });
		if (!met) { review = true; result.reasons.push("The browser event wait timed out. Review the event condition and browser timeline."); }
	}
	const unmetSpoken: SpokenExpectation[] = [];
	for (const expectation of step.expect.spoken) {
		const met = speechIncludes(spokenText, expectation.text);
		result.checks.push({ expectation: `spoken (${expectation.via}): ${JSON.stringify(expectation.text)}`, met, detail: met ? "heard" : "not in captured speech" });
		if (!met) unmetSpoken.push(expectation);
	}
	for (const phrase of step.expect.notSpoken) {
		const met = !speechIncludes(spokenText, phrase);
		result.checks.push({ expectation: `not spoken: ${JSON.stringify(phrase)}`, met, detail: met ? "absent" : "heard" });
	}
	let taskFailed = false;
	if (step.expect.path !== undefined) {
		const path = corroboration ? new URL(corroboration.url).pathname : "";
		const met = Boolean(corroboration) && path.endsWith(step.expect.path);
		result.checks.push({ expectation: `page path ends with ${JSON.stringify(step.expect.path)}`, met, detail: corroboration ? path : "no browser corroboration" });
		taskFailed ||= !met;
	}
	if (step.expect.fragment !== undefined) {
		const fragment = corroboration ? new URL(corroboration.url).hash : "";
		const met = Boolean(corroboration) && fragment === step.expect.fragment;
		result.checks.push({ expectation: `fragment ${JSON.stringify(step.expect.fragment)}`, met, detail: corroboration ? fragment || "empty hash" : "no browser corroboration" });
		taskFailed ||= !met;
	}
	if (step.expect.activeSlide !== undefined) {
		const slide = corroboration?.activeSlide;
		const met = Boolean(slide && (slide.id === step.expect.activeSlide || normalizeSpeech(slide.name) === normalizeSpeech(step.expect.activeSlide)));
		result.checks.push({ expectation: `activeSlide ${JSON.stringify(step.expect.activeSlide)}`, met, detail: slide ? `${slide.id} ${JSON.stringify(slide.name)}` : "no active slide corroborated" });
		taskFailed ||= !met;
	}
	if (step.expect.focus) {
		const focused = corroboration?.focused ?? null;
		const roleMet = !step.expect.focus.role || focused?.role === step.expect.focus.role;
		const nameMet = !step.expect.focus.name || speechIncludes(focused?.name ?? "", step.expect.focus.name);
		const placeMet = !step.expect.focus.notOn || (focused !== null && focused.tag !== step.expect.focus.notOn);
		const met = roleMet && nameMet && placeMet;
		result.checks.push({ expectation: `focus ${JSON.stringify(step.expect.focus)}`, met, detail: focused ? `${focused.tag} ${focused.role} ${JSON.stringify(focused.name)}` : "nothing focused or not corroborated" });
		taskFailed ||= !met;
	}

	const failedNotSpoken = result.checks.some((check) => check.expectation.startsWith("not spoken") && !check.met);
	if (!unmetSpoken.length && !taskFailed && !failedNotSpoken) {
		if (review) result.classification = "needs-review";
		return result;
	}

	if (taskFailed) {
		result.classification = "application-defect-candidate";
		result.reasons.push("The keyboard task did not reach the expected page or focus although NVDA received the keys. Rule out a journey-authoring error before reporting it.");
		return result;
	}
	if (failedNotSpoken) result.reasons.push("NVDA spoke a phrase the journey marks as unwanted; review for duplicate or misleading speech.");
	const exposed = unmetSpoken.filter((expectation) => {
		if (!corroboration) return false;
		if (expectation.via === "focus") return speechIncludes(focusText(corroboration.focused), expectation.text);
		if (expectation.via === "live") return corroboration.liveRegions.some((region) => speechIncludes(region, expectation.text)) || (corroboration.observerEvents ?? []).some((event) => event.kind === "live" && speechIncludes(event.text, expectation.text));
		return false;
	});
	const notExposed = unmetSpoken.filter((expectation) => (expectation.via === "focus" || expectation.via === "live") && !exposed.includes(expectation));
	if (notExposed.length) {
		result.classification = "application-defect-candidate";
		result.reasons.push(`The page did not expose ${notExposed.map((e) => JSON.stringify(e.text)).join(", ")} through the ${[...new Set(notExposed.map((e) => e.via === "focus" ? "focused element" : "live regions"))].join(" or ")}, so NVDA had nothing to announce there.`);
	} else if (exposed.length) {
		result.classification = "compatibility-candidate";
		result.reasons.push(`The browser exposed ${exposed.map((e) => JSON.stringify(e.text)).join(", ")} where NVDA normally reports it, but NVDA did not speak it. Confirm with another browser and ARIA-AT support data before treating it as a course defect.`);
	} else {
		result.classification = "needs-review";
		if (unmetSpoken.length) result.reasons.push("Expected speech was not heard and the corroboration cannot say why. Review the speech and page state.");
	}
	return result;
}

// ---------------------------------------------------------------------------
// Runner

/** Common Guidepup operations implemented by NVDA and VoiceOver. */
export interface ScreenReaderDriver {
	start(options?: { capture?: boolean | "initial"; settings?: Record<string, unknown> }): Promise<void>;
	stop(): Promise<void>;
	press(key: string, options?: { capture?: boolean | "initial" }): Promise<unknown>;
	type(text: string, options?: { capture?: boolean | "initial" }): Promise<unknown>;
	getSettings(): Record<string, unknown>;
}

export interface NvdaDriver extends ScreenReaderDriver {
	readonly version: string;
}

// NVDA 2026.2 defaults (source/config/configSpec.py) for settings that change what
// a journey hears or how it behaves. Anything else Guidepup changes is listed separately.
const NVDA_DEFAULTS: Array<[string, unknown]> = [
	["virtualBuffers.autoSayAllOnPageLoad", true],
	["virtualBuffers.passThroughAudioIndication", true],
	["virtualBuffers.autoPassThroughOnFocusChange", true],
	["virtualBuffers.autoPassThroughOnCaretMove", false],
	["virtualBuffers.useScreenLayout", true],
	["speech.synth", "auto"],
	["speech.symbolLevel", 100],
	["keyboard.keyboardLayout", "desktop"],
	["keyboard.speakTypedCharacters", 1],
	["presentation.reportDynamicContentChanges", true],
	["general.loggingLevel", "INFO"],
	["speechViewer.showSpeechViewerAtStartup", false],
	["vision.NVDAHighlighter.enabled", false],
];

function settingAt(settings: Record<string, unknown>, path: string): unknown {
	return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), settings);
}

/** Settings in an NVDA config that differ from the defaults that matter for journeys. Missing keys use the default. */
export function settingDifferences(settings: Record<string, unknown>): string[] {
	const differences = NVDA_DEFAULTS.flatMap(([path, fallback]) => {
		const value = settingAt(settings, path);
		return value === undefined || value === fallback || String(value) === String(fallback) ? [] : [`${path}=${JSON.stringify(value)} (default ${JSON.stringify(fallback)})`];
	});
	const synth = String(settingAt(settings, "speech.synth") ?? "auto");
	const synthSettings = settingAt(settings, `speech.${synth}`);
	if (synthSettings && typeof synthSettings === "object") differences.push(`speech.${synth}=${JSON.stringify(synthSettings)}`);
	if (settingAt(settings, "remote.enabled") === true) differences.push("remote.enabled=true (Guidepup's Remote Access relay on 127.0.0.1)");
	return differences;
}

export function audioDuckingSetting(settings: Record<string, unknown>): unknown {
	return settingAt(settings, "audio.audioDuckingMode") ?? settingAt(settings, "speech.audioDuckingMode") ?? null;
}

export interface JourneyBrowser {
	open(url: string): Promise<void>;
	navigateSetup?(url: string, expectedDestination?: string): Promise<void>;
	/** pageFocus (default true) also requires keyboard focus in the page rather than the browser's own UI. */
	guard(origin: string, options?: { pageFocus?: boolean }): Promise<{ ok: boolean; detail: string }>;
	corroborate(options?: { since?: number; snapshot?: boolean }): Promise<Corroboration>;
	observe?(): Promise<BrowserObservation>;
	screenshot(name: string): Promise<string | undefined>;
	close(): Promise<void>;
}

export interface JourneyRunOptions {
	journey: Journey;
	origin: string;
	nvda: NvdaDriver;
	browser: JourneyBrowser;
	nvdaSettings: Record<string, unknown>;
	startupWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	onProgress?: (message: string) => void;
	/** A fresh IO-log read after each uncaptured key, when the runner has a log. */
	readNvdaLog?: () => Promise<string | null>;
	keyConfirmationTimeoutMs?: number;
	signal?: AbortSignal;
}

/** Keep our handlers installed even after Guidepup removes its own during teardown. */
export async function withJourneySignals<T>(action: (signal: AbortSignal) => Promise<T>, signals: Pick<EventEmitter, "on" | "off"> = process): Promise<T> {
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error("NVDA journey interrupted"));
	signals.on("SIGINT", interrupt);
	signals.on("SIGTERM", interrupt);
	try { return await action(controller.signal); }
	finally { signals.off("SIGINT", interrupt); signals.off("SIGTERM", interrupt); }
}

export interface JourneyRun {
	startedAt: number;
	endedAt: number;
	records: StepRecord[];
	effectiveSettings: Record<string, unknown> | null;
	stopped?: string;
}

export function verifyAddressDestination(actual: string, expected: string): { ok: boolean; detail: string } {
	try {
		const destination = new URL(actual), wanted = new URL(expected);
		if (!["http:", "https:"].includes(destination.protocol)) return { ok: false, detail: `browser error or unsupported destination: ${actual}` };
		if (destination.origin !== wanted.origin || destination.pathname !== wanted.pathname || destination.search !== wanted.search) {
			return { ok: false, detail: `destination mismatch: expected ${wanted.origin}${wanted.pathname}${wanted.search}, observed ${actual}` };
		}
		return { ok: true, detail: actual };
	} catch {
		return { ok: false, detail: `invalid destination: ${actual}` };
	}
}

export function checkStepRequirements(requires: JourneyStep["requires"], observed: Corroboration): { ok: boolean; mismatches: string[] } {
	const mismatches: string[] = [];
	if (!requires) return { ok: true, mismatches };
	let url: URL;
	try { url = new URL(observed.url); }
	catch { return { ok: false, mismatches: [`invalid observed URL: ${observed.url}`] }; }
	const actual = { path: url.pathname, fragment: url.hash, activeSlide: observed.activeSlide, focusedRole: observed.focused?.role };
	for (const [field, expected] of Object.entries(requires)) {
		const matches = field === "activeSlide" ? actual.activeSlide?.id === expected || actual.activeSlide?.name === expected
			: field === "path" ? actual.path === (expected.startsWith("/") ? expected : `/${expected}`)
			: actual[field as "fragment" | "focusedRole"] === expected;
		if (!matches) mismatches.push(`${field}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual[field as keyof typeof actual] ?? null)}`);
	}
	return { ok: mismatches.length === 0, mismatches };
}

/** Only a logged gesture in the new log slice confirms an uncaptured key. */
export function hasLoggedGesture(key: string, entries: NvdaLogEntry[]): boolean {
	const wanted = nvdaGestureParts(key).join("+");
	return logEvents(entries).some((event) => event.kind === "input" && event.text.replace(/^[^:]*:/, "").toLowerCase().split("+").sort().join("+") === wanted);
}

export function matchesWaitEvent(event: BrowserEvent, wait: NonNullable<JourneyStep["waitFor"]>): boolean {
	const type = event.kind === "media" ? `media-${event.event}` : event.event;
	if (type !== wait.event) return false;
	if (wait.match === undefined) return true;
	const text = event.kind === "media" ? event.src : event.kind === "slide" ? `${event.slide?.id ?? ""} ${event.slide?.name ?? ""}` : event.kind === "live" ? event.text : event.url;
	return text.includes(wait.match);
}

/** Poll only browser reads; waitFor replaces the fixed waitMs when supplied. */
export async function waitForBrowserEvent(browser: JourneyBrowser, wait: NonNullable<JourneyStep["waitFor"]>, since: number,
	sleep: (ms: number) => Promise<void>, now: () => number): Promise<NonNullable<StepRecord["waitFor"]>> {
	if (!browser.observe) throw new Error("browser adapter does not support waitFor observation");
	const startedAt = now(), deadline = startedAt + wait.timeoutMs;
	while (true) {
		const observation = await browser.observe();
		const matchedEvent = observation.events.find((event) => event.epochMs >= since && event.epochMs <= deadline && matchesWaitEvent(event, wait));
		const endedAt = now();
		if (matchedEvent) return { status: "matched", startedAt, endedAt, matchedEvent };
		if (endedAt >= deadline) return { status: "timeout", startedAt, endedAt };
		await sleep(Math.min(100, deadline - endedAt));
	}
}

export async function runJourney(options: JourneyRunOptions): Promise<JourneyRun> {
	const signal = options.signal;
	const assertActive = () => signal?.throwIfAborted();
	const sleep = async (ms: number) => {
		assertActive();
		if (!options.sleep) { await delay(ms, undefined, { signal }); return; }
		if (!signal) { await options.sleep(ms); return; }
		let interrupt: (() => void) | undefined;
		try {
			await Promise.race([new Promise<never>((_, reject) => {
				interrupt = () => reject(signal.reason);
				signal.addEventListener("abort", interrupt, { once: true });
			}), options.sleep(ms)]);
			assertActive();
		} finally { if (interrupt) signal.removeEventListener("abort", interrupt); }
	};
	const now = options.now ?? Date.now;
	const progress = options.onProgress ?? (() => {});
	const run: JourneyRun = { startedAt: now(), endedAt: 0, records: [], effectiveSettings: null };
	// "starting" covers a start() that fails or is interrupted part way; stop() then runs
	// best-effort so the start error stays the one reported.
	let nvdaState: "off" | "starting" | "started" = "off";
	let failure: unknown;
	try {
		assertActive();
		progress(`starting NVDA ${options.nvda.version}`);
		nvdaState = "starting";
		await options.nvda.start({ capture: true, settings: options.nvdaSettings });
		nvdaState = "started";
		assertActive();
		run.effectiveSettings = options.nvda.getSettings();
		await sleep(options.startupWaitMs ?? 3000);
		const startUrl = new URL(options.journey.start, `${options.origin}/`).href;
		if (new URL(startUrl).origin !== new URL(options.origin).origin) throw new Error(`journey start left the audited package: ${startUrl}`);
		progress(`opening ${startUrl}`);
		// The first step's window includes the page load so Say All on load is attributed to it.
		let windowStart = now();
		await options.browser.open(startUrl);

		for (const step of options.journey.steps) {
			assertActive();
			const startedAt = windowStart;
			windowStart = 0;
			const record: StepRecord = { id: step.id, startedAt: startedAt || now(), endedAt: 0, keys: [], guard: await options.browser.guard(options.origin) };
			if (step.address) record.address = new URL(step.address, startUrl).href;
			run.records.push(record);
			progress(`step ${step.id}: ${record.guard.ok ? step.keys.join(" ") || "(listen)" : `guard failed: ${record.guard.detail}`}`);
			if (!record.guard.ok) {
				record.endedAt = now();
				run.stopped = `Stopped before step ${step.id}: ${record.guard.detail}`;
				break;
			}
			try {
				if (step.requires) {
					const observed = await options.browser.corroborate();
					record.requirements = { ...checkStepRequirements(step.requires, observed), observed };
					if (!record.requirements.ok) throw new Error(`requires mismatch: ${record.requirements.mismatches.join("; ")}`);
				}
				const send = async (key: string, source: NonNullable<KeyRecord["source"]>, pageFocus: boolean) => {
					const baseline = options.readNvdaLog ? await options.readNvdaLog() : null;
					if (options.readNvdaLog && baseline === null) throw new Error(`NVDA IO log unavailable before ${key}`);
					const guard = await options.browser.guard(options.origin, { pageFocus });
					if (!guard.ok) throw new Error(`guard failed before ${key}: ${guard.detail}`);
					assertActive();
					const keyRecord: KeyRecord = { key, relaySpeech: "", startedAt: now(), capture: false, source };
					record.keys.push(keyRecord);
					try { await options.nvda.press(key, { capture: false }); }
					finally { keyRecord.endedAt = now(); }
					// Uncaptured Guidepup calls acknowledge dispatch before NVDA handles
					// the gesture. Never send the next key until pacing and IO receipt.
					await sleep(step.interKeyDelayMs ?? 250);
					if (isLoneModifier(key)) keyRecord.confirmation = { status: "unobservable-modifier", at: now() };
					else if (baseline === null) keyRecord.confirmation = { status: "log-unavailable", at: now() };
					else {
						const deadline = now() + (options.keyConfirmationTimeoutMs ?? 2000);
						while (true) {
							assertActive();
							const current = await options.readNvdaLog!();
							if (current === null || !current.startsWith(baseline)) throw new Error(`NVDA IO log disappeared or rotated after ${key}`);
							if (hasLoggedGesture(key, parseNvdaLog(current.slice(baseline.length)))) {
								keyRecord.confirmation = { status: "logged", at: now() }; break;
							}
							if (now() >= deadline) throw new Error(`NVDA did not log ${key} before the next key`);
							await sleep(Math.min(50, deadline - now()));
						}
					}
				};
				const press = async (key: string, source: "journey" | "address", pageFocus = true) => {
					// Guidepup capture sends unguarded Control gestures while it waits for silence.
					if (step.capture ?? true) await send("Control", "harness", pageFocus);
					await send(key, source, pageFocus);
				};
				if (record.address) {
					const target = new URL(record.address);
					if (target.origin !== new URL(options.origin).origin) throw new Error(`address left the audited package: ${record.address}`);
					const expectedDestination = step.addressDestination ? new URL(step.addressDestination, startUrl).href : record.address;
					if (new URL(expectedDestination).origin !== target.origin) throw new Error(`address destination left the audited package: ${expectedDestination}`);
					if (step.setup) {
						if (!options.browser.navigateSetup) throw new Error("browser adapter does not support setup navigation");
						record.setup = { method: "cdp", url: record.address };
						await options.browser.navigateSetup(record.address, expectedDestination);
					} else {
						escapeSendKeysText(step.address!);
						escapeSendKeysText(record.address);
						await press("Control+l", "address");
						const guard = await options.browser.guard(options.origin, { pageFocus: false });
						if (!guard.ok) throw new Error(`guard failed before typing the address: ${guard.detail}`);
						if ((await options.browser.corroborate()).pageFocused) throw new Error("address focus not corroborated: page still has keyboard focus after Control+L");
						for (const character of record.address) {
							const text = escapeSendKeysText(character);
							if ((await options.browser.corroborate()).pageFocused) throw new Error("address focus lost while typing");
							const typingGuard = await options.browser.guard(options.origin, { pageFocus: false });
							if (!typingGuard.ok) throw new Error(`guard failed while typing the address: ${typingGuard.detail}`);
							assertActive();
							await options.nvda.type(text, { capture: false });
							await sleep(50);
						}
						const enterGuard = await options.browser.guard(options.origin, { pageFocus: false });
						if (!enterGuard.ok || (await options.browser.corroborate()).pageFocused) throw new Error(`guard failed before address Enter: ${enterGuard.ok ? "address focus lost" : enterGuard.detail}`);
						await press("Enter", "address", false);
						await sleep(500);
					}
					const destination = await options.browser.corroborate();
					const verified = verifyAddressDestination(destination.topLevelUrl ?? destination.url, expectedDestination);
					if (!verified.ok) { record.corroboration = destination; throw new Error(verified.detail); }
					if (record.setup) record.setup.verified = true;
				}
				for (const key of step.keys) {
					await press(key, "journey");
				}
				// Listening steps only wait: Guidepup's capture would press Control first and cut Say All off.
				if (step.waitFor) record.waitFor = await waitForBrowserEvent(options.browser, step.waitFor, record.startedAt, sleep, now);
				else await sleep(step.waitMs);
				record.screenshot = await options.browser.screenshot(step.id);
				record.corroboration = await options.browser.corroborate({ since: record.startedAt, snapshot: step.snapshot });
			} catch (error) {
				record.error = signal?.aborted ? "NVDA journey interrupted" : error instanceof Error ? error.message : String(error);
				if (!signal?.aborted) {
					record.guard = await options.browser.guard(options.origin).catch(() => ({ ok: false, detail: "guard unavailable" }));
					record.corroboration ??= await options.browser.corroborate().catch(() => undefined);
				}
			}
			record.endedAt = now();
			if (record.error) {
				run.stopped = `Stopped during step ${step.id}: ${record.error}`;
				break;
			}
		}
	} catch (error) {
		if (signal?.aborted) run.stopped = "NVDA journey interrupted";
		else failure = error;
	} finally {
		const cleanupErrors: unknown[] = [];
		if (nvdaState !== "off") {
			try { await options.nvda.stop(); }
			catch (error) { if (nvdaState === "started") cleanupErrors.push(error); }
		}
		try { await options.browser.close(); }
		catch (error) { cleanupErrors.push(error); }
		if (signal?.aborted) run.stopped ??= "NVDA journey interrupted";
		run.endedAt = now();
		if (cleanupErrors.length) failure = Object.assign(new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupErrors], "NVDA journey cleanup failed"), { run });
	}
	if (failure !== undefined) throw failure;
	return run;
}

// ---------------------------------------------------------------------------
// Report

export interface JourneyEnvironment {
	windows: string;
	nvda: string;
	browser: string;
	guidepup: string;
	node: string;
	session: string;
	synthesizer: string;
	journeySha256: string;
	settingsNotDefault: string[];
	audioDucking?: unknown;
	autoplayPolicy?: string | null;
	browserArgs?: string[];
	dryRun?: boolean;
}

export function summarizeJourney(results: StepResult[]) {
	return {
		totalWords: results.reduce((sum, result) => sum + result.verbosity.totalWords, 0),
		speechEventCount: results.reduce((sum, result) => sum + result.verbosity.eventCount, 0),
		repeatedPhraseCount: results.reduce((sum, result) => sum + result.verbosity.repeatedPhrases.reduce((total, phrase) => total + phrase.count - 1, 0), 0),
		speechRequestsDuringNarration: results.reduce((sum, result) => sum + result.overlap.speechRequestsDuringNarration, 0),
		narrationWindowMsWithSpeechRequests: results.reduce((sum, result) => sum + result.overlap.totalMs, 0),
	};
}

export function renderJourneyMarkdown(journey: Journey, run: JourneyRun, results: StepResult[], environment: JourneyEnvironment): string {
	const counts = results.reduce<Record<string, number>>((all, result) => ({ ...all, [result.classification]: (all[result.classification] ?? 0) + 1 }), {});
	const totals = summarizeJourney(results);
	const lines = [
		"# NVDA journey evidence",
		"",
		`Generated by ${TOOL_NAME} (experimental), created by Ariel Harlap`,
		PROJECT_URL,
		"",
		"> Evidence only. A reviewer decides what is a finding.",
		"> A journey that meets its expectations is not a complete accessibility audit.",
		"> This file contains course text and NVDA speech. Keep it private.",
		"",
		`- Journey: ${journey.name} (sha256 ${environment.journeySha256})`,
		`- Pairing: NVDA ${environment.nvda} + ${environment.browser}; ${environment.windows}`,
		`- Driver: Guidepup ${environment.guidepup}; Node ${environment.node}; session ${environment.session}`,
		`- Speech: ${environment.synthesizer}`,
		`- Audio ducking setting: ${environment.audioDucking == null ? "not readable from effective config" : JSON.stringify(environment.audioDucking)}`,
		`- Autoplay policy: ${environment.autoplayPolicy ?? "browser default"}; extra browser args: ${JSON.stringify(environment.browserArgs ?? [])}`,
		...(environment.dryRun ? ["- Dry run: headless browser plumbing only, no NVDA or journey keys. Speech metrics are unavailable; zero means no captured speech."] : []),
		`- Settings that differ from NVDA defaults: ${environment.settingsNotDefault.join("; ") || "none recorded"}`,
		`- Run: ${new Date(run.startedAt).toISOString()} to ${new Date(run.endedAt).toISOString()}`,
		`- Outcomes: ${Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(", ")}`,
		`- Requested speech totals: ${totals.totalWords} words, ${totals.speechEventCount} events, ${totals.repeatedPhraseCount} repeated phrases beyond their first occurrence`,
		`- Narration timing totals: ${totals.speechRequestsDuringNarration} speech requests during playing, ${totals.narrationWindowMsWithSpeechRequests} ms in narration windows containing requests`,
		...(run.stopped ? [`- Stopped early: ${run.stopped}`] : []),
		"",
		"NVDA log time is a speech request time, not acoustic duration or proof that words were heard. Overlap totalMs is the union of narration-playing windows containing speech requests, clipped to each step. Acoustic overlap duration is unavailable. Media events do not prove audible output; mute, volume, ducking and buffering may affect it.",
		"Keys marked as harness input silence speech before captured journey keys. Deliberate Control uses journey attribution. Attribution consumes input entries in order within each driver call; the IO log does not label the sender.",
		"",
	];
	for (const result of results) {
		const { step, record } = result;
		lines.push(`## ${step.id}: ${result.classification}`, "", `Intent: ${step.intent}`, "");
		if (!record) {
			lines.push(...result.reasons.map((reason) => `- ${reason}`), "");
			continue;
		}
		lines.push(
			`- Keys: ${[...(record.address ? [`Control+l, type ${record.address}`] : []), ...step.keys].join(", ") || "none (listened)"}`,
			`- Capture: ${step.capture ?? true}; word budget: ${step.expect.maxWords ?? "none"}`,
			`- NVDA input log: ${result.inputs.join(", ") || "none"}${result.harnessInputs.length ? `; harness: ${result.harnessInputs.length} Control` : ""}`,
			`- Mode sounds: ${result.modes.join(", ") || "none in NVDA's log (NVDA 2026.2 does not log them at the Input/output level)"}`,
			`- Window guard: ${record.guard.ok ? "ok" : record.guard.detail}`,
			...(record.error ? [`- Error: ${record.error}`] : []),
			...(record.corroboration ? [
				`- Page: ${new URL(record.corroboration.url).pathname} ${JSON.stringify(record.corroboration.title)}`,
				`- Keyboard focus: ${record.corroboration.pageFocused ? "in the page" : "in the browser's own interface"}`,
				`- Focused (accessibility tree): ${record.corroboration.focused ? `${record.corroboration.focused.role} ${JSON.stringify(record.corroboration.focused.name)} ${record.corroboration.focused.states.join(" ")}`.trim() : "none"}`,
				`- Live regions: ${record.corroboration.liveRegions.map((text) => JSON.stringify(text)).join(", ") || "empty"}`,
				`- Fragment: ${new URL(record.corroboration.url).hash || "empty"}; active slide: ${JSON.stringify(record.corroboration.activeSlide ?? null)}`,
			] : []),
			`- Requested speech: ${result.verbosity.totalWords} words, ${result.verbosity.eventCount} events; first key to first/last speech: ${result.verbosity.firstKeyToFirstSpeechMs ?? "unavailable"}/${result.verbosity.firstKeyToLastSpeechMs ?? "unavailable"} ms`,
			`- Repeated normalized phrases: ${JSON.stringify(result.verbosity.repeatedPhrases)}`,
			`- Narration timing proxy: ${result.overlap.speechRequestsDuringNarration} speech requests during playing; ${result.overlap.totalMs} ms in narration windows containing requests; acoustic overlap unavailable`,
			...(record.waitFor ? [`- Event wait: ${record.waitFor.status}, ${record.waitFor.endedAt - record.waitFor.startedAt} ms`] : []),
			...(record.screenshot ? [`- Screenshot: ${record.screenshot}`] : []),
			...(record.setup ? [`- Setup via ${record.setup.method}: ${record.setup.url}; destination verified: ${record.setup.verified ?? false}. This is not a learner action.`] : []),
			...(record.requirements ? [`- Prerequisites: ${record.requirements.ok ? "met" : record.requirements.mismatches.join("; ")}`] : []),
			"",
			`Speech (${result.speech.source}):`,
			...(result.speech.phrases.length ? result.speech.phrases.map((phrase) => `  - ${JSON.stringify(phrase)}`) : ["  - none"]),
			"",
		);
		lines.push("Timeline, milliseconds relative to step start:", "");
		for (const interval of result.overlap.intervals) lines.push(`- Narration playing interval +${interval.startMs - record.startedAt} to +${interval.endMs - record.startedAt} ms: ${JSON.stringify(interval.src)} (${interval.mediaId})`);
		if (!result.timeline.length) lines.push("- No timed events captured.");
		for (const item of result.timeline) {
			const event = item.event;
			const detail = event.kind === "speech" ? `speech request, ${(event as SpeechEvent).wordCount} words: ${JSON.stringify(event.text)}` : event.kind === "input" ? `input ${(event as InputEvent).attribution}: ${event.text}` : JSON.stringify(event);
			lines.push(`- +${item.relativeMs} ms (${item.epochMs}) ${item.source}: ${detail}`);
		}
		lines.push("");
		if (record.corroboration?.orientation) {
			const snapshot = record.corroboration.orientation;
			lines.push("Orientation snapshot:", "", `- Focusable AX nodes: ${snapshot.focusableCount}`,
				...snapshot.landmarks.map((landmark) => `- Landmark ${landmark.role}: ${JSON.stringify(landmark.name)}`),
				...snapshot.headings.map((heading) => `- Heading level ${heading.level ?? "unknown"}: ${JSON.stringify(heading.name)}`), "");
		}
		if (result.checks.length) lines.push("Checks:", ...result.checks.map((check) => `  - ${check.met ? "met" : "NOT met"}: ${check.expectation} (${check.detail})`), "");
		if (result.reasons.length) lines.push(...result.reasons.map((reason) => `> ${reason}`), "");
	}
	lines.push(
		"## Not covered",
		"",
		"Other pages and paths, other NVDA settings (laptop layout, speech rate, verbosity), braille, other browsers, mouse and touch use, zoom and magnification, and anything this journey did not script.",
		"",
	);
	return lines.join("\n");
}
