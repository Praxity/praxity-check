import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";

export interface Finding {
	/** Plain language, what is wrong. Leads the report. */
	what: string;
	page: string;
	selector?: string;
	/** The measured value: a ratio, a focus sequence, a rectangle. */
	evidence: string;
	fix: string;
	lens: "a11y";
	confidence: "high" | "medium" | "low";
	basis: string;
	/** Stable id, for deduplicating one defect that appears on many pages. */
	rule: string;
}

/** Unresolved evidence that must never gate or be described as a violation. */
export interface ReviewItem {
	what: string;
	page: string;
	selector?: string;
	evidence: string;
	lens: "a11y";
	basis: string;
	rule: string;
}

/** No silent truncation: whatever a cap drops gets said out loud (spec §7). */
export interface CheckResult {
	findings: Finding[];
	needsReview?: ReviewItem[];
	notes: string[];
}

export interface Triage {
	ok: boolean;
	reason?: string;
}

const NO_MOTION = `*, *::before, *::after {
	animation-duration: 0s !important;
	animation-delay: 0s !important;
	transition-duration: 0s !important;
	caret-color: transparent !important;
}`;

/** Cost is one evaluate per page now, but keep the cap so a huge page stays bounded. */
const MAX_FOCUS_CHECKS = 60;
/** Enough to show a page is riddled with them without walking forever. */
const MAX_TRAPS = 5;
/**
 * `dataset.praxAuditId` writes the attribute `data-prax-audit-id` -- camel case
 * on the property, kebab case on the attribute. Querying the camel-case form
 * matches nothing and every lookup returns null, which reads as "no problems
 * found" rather than as a failure. Both spellings are named here so they cannot
 * drift apart again.
 */
const MARK = "praxAuditId";
const MARK_ATTR = "data-prax-audit-id";


/** A source-backed CSS selector, verified unique before it leaves the page. */
export const UNIQUE_SELECTOR = `(el) => {
	if (!el) return "";
	const parts = [];
	for (let node = el; node; node = node.parentElement) {
		if (node.id) {
			const byId = CSS.escape(node.localName) + "#" + CSS.escape(node.id);
			if (document.querySelectorAll(byId).length === 1) {
				parts.unshift(byId);
				const candidate = parts.join(" > ");
				if (document.querySelectorAll(candidate).length === 1) return candidate;
			}
		}
		let part = CSS.escape(node.localName);
		if (node.parentElement) {
			const siblings = Array.from(node.parentElement.children).filter((other) => other.localName === node.localName);
			if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
		}
		parts.unshift(part);
		const candidate = parts.join(" > ");
		if (document.querySelectorAll(candidate).length === 1) return candidate;
	}
	return "";
}`;

const FOCUSABLE =
	'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** Shared browser-side colour math. Canvas normalises every CSS colour syntax Chromium accepts. */
const COLOR_HELPERS = `(() => {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	const cache = new Map();
	const parse = (value) => {
		const text = value.trim();
		if (cache.has(text)) return cache.get(text);
		if (!context || !CSS.supports("color", text)) { cache.set(text, undefined); return undefined; }
		context.clearRect(0, 0, 1, 1);
		context.fillStyle = text;
		context.fillRect(0, 0, 1, 1);
		const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
		const parsed = [r, g, b, a / 255];
		cache.set(text, parsed);
		return parsed;
	};
	const paint = (value, under, opacity = 1) => {
		const color = parse(value);
		if (!color) return undefined;
		const alpha = Math.max(0, Math.min(1, color[3] * opacity));
		return color.slice(0, 3).map((channel, i) => channel * alpha + (under[i] || 0) * (1 - alpha));
	};
	const contrast = (a, b) => {
		const luminance = (color) => color.map((value) => value / 255).map((value) =>
			value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
		).reduce((sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] || 0), 0);
		const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (values[0] + 0.05) / (values[1] + 0.05);
	};
	const background = (start) => {
		const layers = [];
		for (let el = start; el; el = el.parentElement) {
			const style = getComputedStyle(el);
			if (style.backgroundImage !== "none") return undefined;
			const color = parse(style.backgroundColor);
			if (color) layers.unshift(color);
		}
		return layers.reduce((under, layer) => paint("rgba(" + layer.join(",") + ")", under) || under, [255, 255, 255]);
	};
	const colors = (value) => (value.match(/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^)]*\\)|#[\\da-f]{3,8}\\b|\\b[a-z]+\\b/gi) || [])
		.filter((token) => parse(token));
	return { parse, paint, contrast, background, colors };
})()`;

/**
 * Wait for a launcher shell to actually render. Course players commonly ship an
 * empty container that a bundle fills after the load event. Auditing at load
 * can therefore report an empty page for a course that renders moments later.
 *
 * This is not a launch adapter -- it does not supply an LMS API or drive
 * in-content navigation. It only declines to give up before the first paint.
 */
export async function settle(page: Page, maxMs = 8000): Promise<string | undefined> {
	const deadline = Date.now() + maxMs;
	await page.waitForLoadState("networkidle", { timeout: maxMs }).catch(() => {});

	let previous: { text: number; elements: number } | undefined;
	let stableSince = Date.now();
	while (Date.now() < deadline) {
		const current = await page.evaluate(() => ({
			text: (document.body?.innerText ?? "").length,
			elements: document.body?.querySelectorAll("*").length ?? 0,
		}));
		if (previous && current.text === previous.text && current.elements === previous.elements) {
			if (Date.now() - stableSince >= 1000) return undefined;
		} else {
			previous = current;
			stableSince = Date.now();
		}
		await page.waitForTimeout(250);
	}
	return `rendering did not keep stable text and element counts for 1s before the ${maxMs}ms settle deadline — result may be partial`;
}

const SCOPE_CONTROLS = `${FOCUSABLE}, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="slider"]`;

/** Report controls in DOM subtrees the custom checks deliberately do not enter. */
export async function scopeCoverage(page: Page, pageId: string): Promise<CheckResult> {
	const scope = await page.evaluate((controls) => {
		let sameOriginFrames = 0;
		let framesWithControls = 0;
		let openShadowRoots = 0;
		let shadowsWithControls = 0;

		const visit = (root: Document | ShadowRoot) => {
			for (const el of Array.from(root.querySelectorAll("*"))) {
				if (el instanceof HTMLIFrameElement && el.contentDocument) {
					sameOriginFrames++;
					if (el.contentDocument.querySelector(controls)) framesWithControls++;
				}
				if (el.shadowRoot) {
					openShadowRoots++;
					if (el.shadowRoot.querySelector(controls)) shadowsWithControls++;
					visit(el.shadowRoot);
				}
			}
		};
		visit(document);
		return { sameOriginFrames, framesWithControls, openShadowRoots, shadowsWithControls };
	}, SCOPE_CONTROLS);

	if (scope.framesWithControls === 0 && scope.shadowsWithControls === 0) return { findings: [], notes: [] };
	return {
		findings: [],
		notes: [
			`custom checks examined only the light DOM on ${pageId}; ${scope.framesWithControls} of ${scope.sameOriginFrames} same-origin iframe(s) and ${scope.shadowsWithControls} of ${scope.openShadowRoots} open shadow root(s) contain controls outside their scope — result is partial`,
		],
	};
}

/**
 * Harness artifacts are not findings. Each symptom below has
 * already produced a confident false bug report somewhere.
 */
export async function triage(page: Page, status: number | null, blockedRequests = 0): Promise<Triage> {
	if (status !== null && status >= 400) return { ok: false, reason: `server returned ${status}` };

	const shape = await page.evaluate(() => {
		// A frame covering most of the viewport means the course is in there and
		// this page is a launcher. Rustici's SCORM Driver is the common case, and
		// auditing it reports Rustici's shell defects as the course's.
		const area = window.innerWidth * window.innerHeight;
		const dominantFrame = Array.from(document.querySelectorAll("iframe")).some((frame) => {
			const rect = frame.getBoundingClientRect();
			return area > 0 && (rect.width * rect.height) / area > 0.5;
		});
		return {
			text: (document.body?.innerText ?? "").trim().length,
			landmarks: document.querySelectorAll("main, [role=main], h1, h2, h3").length,
			frames: document.querySelectorAll("iframe").length,
			dominantFrame,
		};
	});

	if (shape.dominantFrame) {
		return {
			ok: false,
			reason: "a full-size iframe holds the course; this page is a launcher — audit the framed document directly",
		};
	}

	// Some packages stream their content from the vendor's CDN rather than
	// shipping it. Blocking that (the default) leaves an empty shell, and axe's
	// document-level rules then fire on nothing -- reporting the tool's own
	// network policy as the course's defects.
	if (blockedRequests > 0 && shape.text < 200) {
		return {
			ok: false,
			reason: `content is loaded from a remote origin and ${blockedRequests} request(s) were blocked; rerun with --allow-network if you trust this package`,
		};
	}

	if (shape.text < 40 && shape.landmarks === 0) {
		// The saved Claude artifact is exactly this: a frame shell whose real
		// content sits in an iframe the scanner cannot reach.
		return {
			ok: false,
			reason:
				shape.frames > 0
					? `no content of its own; ${shape.frames} iframe(s) hold it — audit the framed document directly`
					: "page rendered empty",
		};
	}
	return { ok: true };
}


/**
 * 2.5.8 has a User Agent Control exception: a target whose size the browser
 * decides and the author never touches does not fail. axe reports these anyway.
 * A bare `<input type="checkbox">` renders 13x13 with no author rule touching
 * it, and six such findings were confirmed false -- one adjudicator caught them
 * and gave this reason, two others missed it, and inspecting the stylesheets
 * showed zero author rules matching the element.
 *
 * Deliberately narrow: only native form controls whose *own* size properties no
 * author rule sets. Links and buttons are sized by author content and stay in
 * scope, and an author who styles a checkbox at all loses the exception.
 */
const UA_SIZED_CONTROLS = `(() => {
	const sized = ["width","height","min-width","min-height","padding","font-size","transform","zoom","appearance","scale"];
	let unreadable = 0;
	const rules = Array.from(document.styleSheets).flatMap((sheet) => {
		try { return Array.from(sheet.cssRules); } catch { unreadable++; return []; }
	}).filter((r) => r.selectorText && r.style);
	// A stylesheet we cannot read might be the one sizing the control. Claiming
	// the exemption anyway would silently suppress a real 2.5.8 failure, so an
	// unreadable sheet withdraws the exemption entirely.
	if (unreadable > 0) return [];
	const out = [];
	for (const el of document.querySelectorAll("input, select, textarea, progress, meter")) {
		if (el.hasAttribute("style") && sized.some((p) => el.style.getPropertyValue(p))) continue;
		let unmatchable = false;
		const authored = rules.some((r) => {
			try { if (!el.matches(r.selectorText)) return false; } catch { unmatchable = true; return false; }
			return sized.some((p) => r.style.getPropertyValue(p));
		});
		// Same reasoning: a selector we could not evaluate may be the author rule.
		if (unmatchable) continue;
		if (!authored) out.push(el.tagName.toLowerCase() + "|" + (el.getAttribute("name") || "") + "|" + (el.id || ""));
	}
	return out;
})()`;

export async function runAxe(page: Page, pageId: string): Promise<CheckResult> {
	const results = await new AxeBuilder({ page })
		.options({
			rules: {
				// Both ship disabled by default and both belong in the automated checks.
				"target-size": { enabled: true },
				"heading-order": { enabled: true },
			},
		})
		.analyze();
	const axeTargets = [...results.violations, ...results.incomplete].flatMap((rule) =>
		rule.nodes.map((node) => node.target.join(" "))
	);
	const axeSelectors = await page.evaluate(
		([targets, locate]) => targets.map((target) => {
			try {
				const el = document.querySelector(target);
				return el ? ((0, eval)(locate)(el) as string) : "";
			} catch {
				return "";
			}
		}),
		[axeTargets, UNIQUE_SELECTOR] as const,
	);
	const selectorByTarget = new Map<string, string>();
	axeTargets.forEach((target, index) => {
		const selector = axeSelectors[index];
		if (selector) selectorByTarget.set(target, selector);
	});

	const uaSized = new Set(await page.evaluate(UA_SIZED_CONTROLS) as string[]);
	const exemptByUserAgent = async (target: string): Promise<boolean> => {
		if (uaSized.size === 0) return false;
		try {
			return await page.evaluate(
				([sel, keys]) => {
					const el = document.querySelector(sel);
					if (!el) return false;
					const id = el.tagName.toLowerCase() + "|" + (el.getAttribute("name") || "") + "|" + (el.id || "");
					return keys.includes(id);
				},
				[target, [...uaSized]] as const,
			);
		} catch {
			// Fail closed: an element we cannot query is not proven exempt, so the
			// finding stands rather than being silently dropped.
			return false;
		}
	};

	const findings: Finding[] = [];
	const needsReview: ReviewItem[] = [];
	const map = (rules: typeof results.violations, confidence?: "high") => {
		for (const rule of rules) {
			// Automated findings are normative failures (spec §5). axe also ships
			// best-practice advice -- `region`, `landmark-one-main` and friends --
			// which is useful but is not a WCAG failure. Reporting it at high
			// confidence produced 84 high-confidence findings against the W3C's own
			// Before-After demo pages, which W3C's published reports record as
			// having no failures. Kept, demoted, out of the headline count.
			const normative = !rule.tags.includes("best-practice");
			for (const node of rule.nodes) {
				// 2.5.8 User Agent Control: a target the browser sizes and the author
				// never touches does not fail. axe reports these anyway.
				if (rule.id === "target-size" && uaExempt.has(node.target.join(" "))) continue;
				// Glyph-only controls belong to 1.4.11 and are measured by nonTextContrast.
				if (
					rule.id === "color-contrast" &&
					/content contains only non-text characters/i.test(node.failureSummary ?? "")
				)
					continue;
				const target = node.target.join(" ");
				const evidence = `${(node.failureSummary ?? rule.description).replace(/\s+/g, " ").trim()}${selectorByTarget.has(target) ? "" : `; axe target ${JSON.stringify(target)} could not be resolved to one light-DOM element`}`;
				if (!confidence) {
					needsReview.push({
						what: `${rule.help} could not be determined automatically.`,
						page: pageId,
						selector: selectorByTarget.get(target),
						evidence,
						lens: "a11y",
						basis: basisFor(rule.tags),
						rule: `axe:${rule.id}`,
					});
					continue;
				}
				findings.push({
					what: rule.help,
					page: pageId,
					selector: selectorByTarget.get(target),
					evidence,
					fix: rule.helpUrl,
					lens: "a11y",
					confidence: normative ? confidence : "low",
					basis: basisFor(rule.tags),
					rule: `axe:${rule.id}`,
				});
			}
		}
	};

	const uaExempt = new Set<string>();
	for (const rule of [...results.violations, ...results.incomplete]) {
		if (rule.id !== "target-size") continue;
		for (const node of rule.nodes) {
			const sel = node.target.join(" ");
			if (await exemptByUserAgent(sel)) uaExempt.add(sel);
		}
	}

	// axe's own split is categorical: violations are findings; incomplete results
	// need review and never gate, regardless of the selected confidence floor.
	map(results.violations, "high");
	map(results.incomplete);
	return { findings, needsReview, notes: [] };
}

function basisFor(tags: string[]): string {
	const tag = tags.find((t) => /^wcag\d{3,4}$/.test(t));
	if (!tag) return tags.includes("best-practice") ? "axe-core best practice" : "axe-core rule";
	const level = tags.some((t) => t.endsWith("aaa"))
		? "AAA"
		: tags.some((t) => t.endsWith("aa"))
			? "AA"
			: "A";
	return `WCAG ${tag.slice(4).split("").join(".")} (${level})`;
}

interface ListenerTarget {
	selector: string;
	label: string;
	tag: string;
	role: string;
	tabindex: boolean;
	visible: boolean;
	containsControl: boolean;
	staticGraphic: boolean;
	essentialKey: boolean;
	listeners: Array<{ type: string; source: string }>;
}

interface ListenerSnapshot {
	elements: ListenerTarget[];
	document: Array<{ type: string; source: string }>;
	window: Array<{ type: string; source: string }>;
	hasShortcutControl: boolean;
	hasUndo: boolean;
}

/** Chromium exposes registered listeners to its command-line API without page mutation. */
const LISTENER_PROBE = `((selector) => {
	const read = (target) => Object.entries(getEventListeners(target)).flatMap(([type, entries]) =>
		entries.map((entry) => ({ type, source: String(entry.listener) }))
	);
	const controls = Array.from(document.querySelectorAll("button, input, select, textarea, [role=button], a[href]"));
	const label = (el) => (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").trim();
	const usable = (el) => {
		const style = getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !el.disabled && (el.matches("button, input, select, textarea, a[href]") || el.tabIndex >= 0);
	};
	return {
		elements: Array.from(document.querySelectorAll("body *")).map((el) => {
			const style = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return {
				selector: selector(el),
				label: label(el).replace(/\\s+/g, " ").slice(0, 80),
				tag: el.localName,
				role: el.getAttribute("role") || "",
				tabindex: el.hasAttribute("tabindex"),
				visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && !el.closest("[inert], [aria-hidden=true]"),
				containsControl: el.querySelector("button, input, select, textarea, [role=button], a[href]") !== null,
				staticGraphic: el.closest('[role="img"][aria-label]') !== null && el.querySelector("canvas") !== null && el.closest("figure")?.querySelector("table") !== null,
				essentialKey: el.closest('[aria-label*="keyboard" i], [aria-label*="keypad" i]') !== null,
				listeners: read(el),
			};
		}).filter((item) => item.listeners.length > 0),
		document: read(document),
		window: read(window),
		hasShortcutControl: controls.some((el) => usable(el) && /(?:disable|turn off|remap|configure).*(?:shortcut|hotkey)|(?:shortcut|hotkey).*(?:disable|turn off|remap|configure)/i.test(label(el))),
		hasUndo: controls.some((el) => usable(el) && /\\bundo\\b/i.test(label(el))),
	};
})(${UNIQUE_SELECTOR})`;

type ListenerInspection = { snapshot?: ListenerSnapshot; note?: string };

async function inspectListeners(
	page: Page,
): Promise<ListenerInspection> {
	const session = await page.context().newCDPSession(page);
	try {
		const response = (await session.send("Runtime.evaluate", {
			expression: LISTENER_PROBE,
			includeCommandLineAPI: true,
			returnByValue: true,
		})) as { result?: { value?: ListenerSnapshot }; exceptionDetails?: { text?: string } };
		if (response.exceptionDetails || !response.result?.value) {
			throw new Error(response.exceptionDetails?.text ?? "listener probe returned no value");
		}
		return { snapshot: response.result.value };
	} catch (error) {
		return { note: `interaction listeners could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		await session.detach();
	}
}

/**
 * Conservative 2.1.1 proxy: direct click handlers on visible div/span controls
 * only. Native controls, delegated containers, named roles, tab stops, and
 * controls with their own key handler are left alone rather than guessed at.
 */
export async function mouseOnlyControls(page: Page, pageId: string): Promise<CheckResult> {
	return mouseOnlyControlsFrom(await inspectListeners(page), pageId);
}

function mouseOnlyControlsFrom(inspected: ListenerInspection, pageId: string): CheckResult {
	if (!inspected.snapshot) return { findings: [], notes: inspected.note ? [inspected.note] : [] };

	const documentKeyTypes = new Set(
		[...inspected.snapshot.document, ...inspected.snapshot.window]
			.map((listener) => listener.type)
			.filter((type) => type === "keydown" || type === "keypress" || type === "keyup"),
	);
	const findings = inspected.snapshot.elements
		.filter((el) => {
			const types = new Set(el.listeners.map((listener) => listener.type));
			const keyboardOnElement = ["keydown", "keypress", "keyup"].some((type) => types.has(type));
			if (!el.visible || el.containsControl || el.staticGraphic || !types.has("click") || keyboardOnElement) return false;

			// Case 1: a plain div or span with a click handler. Tab never reaches it.
			if ((el.tag === "div" || el.tag === "span") && !el.tabindex && !el.role) return true;

			// Case 2: it claims to be a button or link and is focusable, but nothing
			// handles Enter or Space -- so a screen reader announces an operable
			// control that does nothing. Worse than case 1, because it looks correct.
			// Skipped when the document delegates keyboard events, since the handler
			// may legitimately live on an ancestor.
			const delegatesKeys = [...documentKeyTypes].length > 0;
			return (el.role === "button" || el.role === "link") && el.tabindex && !delegatesKeys;
		})
		.map<Finding>((el) => ({
			what: "This clickable control cannot receive or respond to keyboard input.",
			page: pageId,
			selector: el.selector,
			evidence: `${el.label ? `accessible name ${JSON.stringify(el.label)}; ` : ""}${el.role
				? `role="${el.role}" with a click listener and no Enter/Space handling anywhere`
				: "visible div/span has a direct click listener, but no native semantics, role, tabindex, or keyboard listener"}`,
			fix: "Use a button or link. If that is impossible, add the correct role, keyboard focus, and Enter/Space handling.",
			lens: "a11y",
			confidence: "medium",
			basis: "WCAG 2.1.1 Keyboard (A)",
			rule: "mouse-only-control",
		}));
	return { findings, notes: [] };
}

function bareCharacter(source: string): string | undefined {
	// A modifier or focus/target guard may make the shortcut conforming. Static
	// source inspection cannot prove its branch, so precision wins and we skip it.
	if (/\b(?:ctrlKey|altKey|metaKey|activeElement|currentTarget|target|closest|matches|tagName|contentEditable)\b/.test(source)) {
		return undefined;
	}
	const direct = source.match(/\b\w+\.key(?:\.toLowerCase\(\))?\s*={2,3}\s*(["'`])([^"'`\r\n])\1/);
	if (direct?.[2] && !/\s/u.test(direct[2])) return direct[2];
	if (!/switch\s*\([^)]*\.key/.test(source)) return undefined;
	const branch = source.match(/case\s*(["'`])([^"'`\r\n])\1/);
	return branch?.[2] && !/\s/u.test(branch[2]) ? branch[2] : undefined;
}

export async function characterKeyShortcuts(page: Page, pageId: string): Promise<CheckResult> {
	return characterKeyShortcutsFrom(await inspectListeners(page), pageId);
}

function characterKeyShortcutsFrom(inspected: ListenerInspection, pageId: string): CheckResult {
	if (!inspected.snapshot) return { findings: [], notes: inspected.note ? [inspected.note] : [] };
	if (inspected.snapshot.hasShortcutControl) return { findings: [], notes: [] };

	const findings: Finding[] = [];
	for (const listener of [...inspected.snapshot.document, ...inspected.snapshot.window]) {
		if (!/^(?:keydown|keypress|keyup)$/.test(listener.type)) continue;
		const key = bareCharacter(listener.source);
		if (!key) continue;
		findings.push({
			what: `The document uses the printable character “${key}” as a keyboard shortcut with no visible way to change it.`,
			page: pageId,
			evidence: `${listener.type} listener on document/window compares event.key with ${JSON.stringify(key)} without a modifier or focus guard`,
			fix: "Let users turn the shortcut off or remap it to include Ctrl/Alt, or make it active only while its component has focus.",
			lens: "a11y",
			confidence: "medium",
			basis: "WCAG 2.1.4 Character Key Shortcuts (A)",
			rule: "character-key-shortcut",
		});
	}
	return { findings, notes: [] };
}

/**
 * A down listener is not itself a failure (dragging starts that way). Only
 * direct completion calls with no same-target up/cancel path are reported.
 */
/**
 * 2.5.2 is about the *action* completing on the down event, not about a fixed
 * list of APIs. Clearing a field on `pointerdown` is as unrecoverable as
 * submitting on it -- the bench case `onpointerdown="draft.value=''"` destroyed
 * a learner's answer and the original pattern, which only matched navigation and
 * submission calls, ignored it.
 *
 * Deliberately excludes down handlers that only set a class, style or attribute
 * for press feedback: that is the legitimate and by far the commonest use, and
 * flagging it would drown the real cases (spec §7).
 */
const DOWN_ACTION =
	/\.(?:click|submit|requestSubmit|dispatchEvent|showModal|close|remove|delete|reset|play|pause)\s*\(|\b(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\s*\(|window\.open\s*\(|fetch\s*\(|history\.(?:pushState|replaceState|back)\s*\()|\.(?:value|checked|selectedIndex|textContent|innerHTML|innerText)\s*=(?!=)/;
const RELEASE: Record<string, string[]> = {
	mousedown: ["mouseup"],
	pointerdown: ["pointerup", "pointercancel"],
	touchstart: ["touchend", "touchcancel"],
};

export async function pointerCancellation(page: Page, pageId: string): Promise<CheckResult> {
	return pointerCancellationFrom(await inspectListeners(page), pageId);
}

function pointerCancellationFrom(inspected: ListenerInspection, pageId: string): CheckResult {
	if (!inspected.snapshot) return { findings: [], notes: inspected.note ? [inspected.note] : [] };
	if (inspected.snapshot.hasUndo) return { findings: [], notes: [] };

	const findings: Finding[] = [];
	for (const el of inspected.snapshot.elements) {
		if (!el.visible || el.essentialKey) continue;
		const types = new Set(el.listeners.map((listener) => listener.type));
		for (const [down, releases] of Object.entries(RELEASE)) {
			const source = el.listeners.find((listener) => listener.type === down && DOWN_ACTION.test(listener.source));
			if (!source || releases.some((release) => types.has(release))) continue;
			findings.push({
				what: `This control completes its action on ${down}, before the pointer can be moved away to cancel.`,
				page: pageId,
				selector: el.selector,
				evidence: `${el.label ? `accessible name ${JSON.stringify(el.label)}; ` : ""}${down} directly invokes an activation API; no ${releases.join(" or ")} handler or visible Undo mechanism was found`,
				fix: "Complete activation on click or the corresponding up event, and allow moving off the target to cancel.",
				lens: "a11y",
				confidence: "medium",
				basis: "WCAG 2.5.2 Pointer Cancellation (A)",
				rule: "pointer-down-activation",
			});
			break;
		}
	}
	return { findings, notes: [] };
}

/** One CDP snapshot feeds the three listener analyses. */
export async function interactionChecks(page: Page, pageId: string): Promise<CheckResult> {
	const inspected = await inspectListeners(page);
	if (!inspected.snapshot) return { findings: [], notes: inspected.note ? [inspected.note] : [] };
	const results = [
		mouseOnlyControlsFrom(inspected, pageId),
		characterKeyShortcutsFrom(inspected, pageId),
		pointerCancellationFrom(inspected, pageId),
	];
	return {
		findings: results.flatMap((result) => result.findings),
		notes: results.flatMap((result) => result.notes),
	};
}

/**
 * CSS animations are automatic by definition; transitions are included only
 * while running. Preload/progress motion and motion without parallel page
 * content implement the criterion's essential/not-part-of-the-page exceptions.
 */
export async function pauseStopHide(page: Page, pageId: string): Promise<CheckResult> {
	const motion = await page.evaluate((locate) => {
		type Motion = { selector: string; kind: string; duration: string };
		const out: Motion[] = [];
		const seen = new Set<string>();
		const selector = (0, eval)(locate) as (el: Element) => string;
		const visible = (el: Element) => {
			const style = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
		};
		const label = (el: Element) => ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
		const controls = Array.from(document.querySelectorAll("button, input[type=button], input[type=checkbox], [role=button], a[href]"));
		const hasMechanism = controls.some((el) => visible(el) && !el.hasAttribute("disabled") && (el.matches("button, input, a[href]") || (el as HTMLElement).tabIndex >= 0) && /\b(?:pause|stop|hide|freeze)\b/i.test(label(el)));
		const essential = (el: Element) => el.closest('[aria-busy="true"], [role="progressbar"]') !== null;
		const parallel = (target: Element) => Array.from(document.querySelectorAll("body *")).some((el) =>
			el !== target && !target.contains(el) && !el.contains(target) && visible(el) && (label(el).length > 0 || el.matches("img, video, canvas, svg, button, input, select, textarea"))
		);
		const add = (el: Element, kind: string, duration: string) => {
			const key = `${selector(el)}|${kind}`;
			if (seen.has(key) || hasMechanism || essential(el) || !parallel(el)) return;
			seen.add(key);
			out.push({ selector: selector(el), kind, duration });
		};
		const milliseconds = (value: string) => {
			const number = Number.parseFloat(value);
			return value.trim().endsWith("ms") ? number : number * 1000;
		};

		for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
			if (!visible(el)) continue;
			const style = getComputedStyle(el);
			const names = style.animationName.split(",").map((value) => value.trim());
			const durations = style.animationDuration.split(",").map(milliseconds);
			const iterations = style.animationIterationCount.split(",").map((value) => value.trim() === "infinite" ? Infinity : Number.parseFloat(value));
			const states = style.animationPlayState.split(",").map((value) => value.trim());
			for (let i = 0; i < names.length; i++) {
				const total = (durations[i % durations.length] ?? 0) * (iterations[i % iterations.length] ?? 1);
				if (names[i] !== "none" && states[i % states.length] !== "paused" && total > 5000) {
					add(el, "CSS animation", total === Infinity ? "infinite" : `${Math.round(total)}ms`);
				}
			}
		}

		for (const animation of document.getAnimations()) {
			if (animation.constructor.name !== "CSSTransition" || animation.playState === "paused" || animation.playState === "finished") continue;
			const effect = animation.effect;
			if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof Element)) continue;
			const duration = effect.getComputedTiming().duration;
			if (typeof duration === "number" && duration > 5000) add(effect.target, "CSS transition", `${Math.round(duration)}ms`);
		}

		for (const marquee of Array.from(document.querySelectorAll("marquee"))) {
			const loop = marquee.getAttribute("loop");
			if (visible(marquee) && (loop === null || Number(loop) <= 0)) add(marquee, "marquee", "infinite");
		}

		const carousels = document.querySelectorAll(
			'[data-bs-ride="carousel"], [data-ride="carousel"], [aria-roledescription="carousel"][autoplay], [class*="carousel" i][data-autoplay="true"]',
		);
		for (const carousel of Array.from(carousels)) {
			if (visible(carousel)) add(carousel, "auto-advancing carousel", "automatic updates");
		}
		return out;
	}, UNIQUE_SELECTOR);

	return {
		findings: motion.map((item) => ({
			what: `This ${item.kind} runs automatically without a pause, stop, or hide control.`,
			page: pageId,
			selector: item.selector,
			evidence: `${item.kind}, ${item.duration}, visible beside other page content; no pause/stop/hide control found`,
			fix: item.kind === "auto-advancing carousel"
				? "Provide a keyboard-operable pause, stop, or hide control, or let the user control the update frequency."
				: "Provide a keyboard-operable pause, stop, or hide control, or stop the motion within five seconds.",
			lens: "a11y",
			confidence: "medium",
			basis: "WCAG 2.2.2 Pause, Stop, Hide (A)",
			rule: "pause-stop-hide",
		})),
		notes: [],
	};
}

/** `<audio>` only: observe more than three seconds of playback, then require a sound control. */
export async function audioAutoplay(page: Page, pageId: string): Promise<CheckResult> {
	if (await page.locator("audio").count() === 0) return { findings: [], notes: [] };
	await page.waitForFunction(
		() => Array.from(document.querySelectorAll<HTMLAudioElement>("audio")).every((audio) => audio.readyState >= 1 || audio.error !== null),
		undefined,
		{ timeout: 1500 },
	).catch(() => {});

	const before = await page.evaluate(([focusable, locate]) => {
		const selector = (0, eval)(locate) as (el: Element) => string;
		const controls = Array.from(document.querySelectorAll<HTMLElement>(focusable));
		const usable = (el: HTMLElement) => {
			const style = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return el.tabIndex >= 0 && !el.matches(":disabled") && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
		};
		return Array.from(document.querySelectorAll<HTMLAudioElement>("audio")).map((audio, index) => {
			const external = controls.find((control) => {
				if (!usable(control)) return false;
				const name = (control.getAttribute("aria-label") || control.innerText || control.getAttribute("title") || "").trim();
				const namesSoundControl = /\b(?:pause|stop|mute|volume)\b/i.test(name);
				const relation = audio.id && control.getAttribute("aria-controls")?.split(/\s+/).includes(audio.id);
				return namesSoundControl && (relation || document.querySelectorAll("audio").length === 1);
			});
			return {
				index,
				selector: selector(audio),
				autoplay: audio.autoplay,
				paused: audio.paused,
				muted: audio.muted,
				volume: audio.volume,
				currentTime: audio.currentTime,
				duration: audio.duration,
				loop: audio.loop,
				controls: audio.controls,
				external: external ? (external.getAttribute("aria-label") || external.innerText || external.getAttribute("title") || "").trim() : "",
				error: audio.error?.message ?? "",
			};
		});
	}, [FOCUSABLE, UNIQUE_SELECTOR] as const);

	const active = before.filter((audio) =>
		!audio.paused && !audio.muted && audio.volume > 0 &&
		(audio.loop || audio.duration > 3) && !audio.controls && !audio.external
	);
	if (active.length > 0) await page.waitForTimeout(3100);
	const after = active.length > 0
		? await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAudioElement>("audio")).map((audio) => ({
			paused: audio.paused,
			currentTime: audio.currentTime,
		})))
		: [];

	const findings: Finding[] = [];
	const notes: string[] = [];
	for (const audio of before) {
		if (audio.muted || audio.volume === 0 || audio.controls || audio.external) continue;
		if (!audio.loop && !(audio.duration > 3)) {
			if (!Number.isFinite(audio.duration)) notes.push(`audio autoplay duration could not be measured for ${audio.selector || `audio ${audio.index + 1}`} on ${pageId}${audio.error ? `: ${audio.error}` : ""}`);
			continue;
		}
		if (audio.paused) {
			if (audio.autoplay) notes.push(`audio ${audio.selector || audio.index + 1} declares autoplay but Chromium blocked playback on ${pageId} — 1.4.2 was not observed`);
			continue;
		}
		const final = after[audio.index];
		const observed = final && (final.currentTime >= 3 || (!final.paused && final.currentTime !== audio.currentTime) || (audio.loop && !final.paused));
		if (!observed) continue;
		findings.push({
			what: "Audio plays automatically for more than three seconds without a sound control.",
			page: pageId,
			selector: audio.selector || undefined,
			evidence: `autoplay=${audio.autoplay}, paused=${audio.paused}, muted=${audio.muted}, volume=${audio.volume}, duration=${Number.isFinite(audio.duration) ? `${audio.duration.toFixed(2)}s` : "unknown"}, currentTime ${audio.currentTime.toFixed(2)}s→${final?.currentTime.toFixed(2) ?? "unknown"}s after 3.1s; no native or named external sound control`,
			fix: "Do not autoplay the audio, stop it within three seconds, or provide a keyboard-operable pause/stop or independent volume control.",
			lens: "a11y", confidence: "high",
			basis: "WCAG 1.4.2 Audio Control (A)",
			rule: "audio-autoplay",
		});
	}
	return { findings, notes };
}

/** Tag every focusable so identity survives a round trip through evaluate(). */
async function markFocusables(page: Page): Promise<number> {
	return page.evaluate(
		([selector, mark]) => {
			const all = document.querySelectorAll<HTMLElement>(selector);
			all.forEach((el, i) => {
				el.dataset[mark] = String(i);
			});
			return all.length;
		},
		[FOCUSABLE, MARK] as const,
	);
}

/**
 * Tab through the page recording where focus lands. Catches what axe has no rule
 * for: a trap Tab cannot leave, and a page Tab cannot enter at all.
 */
export async function keyboardWalk(page: Page, pageId: string): Promise<CheckResult> {
	const findings: Finding[] = [];
	const notes: string[] = [];
	const trapped = new Set<string>();
	const total = await markFocusables(page);
	if (total === 0) return { findings, notes };

	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

	const order: string[] = [];
	for (let i = 0; i < total + 2; i++) {
		await page.keyboard.press("Tab");
		const at = await page.evaluate(
			([mark, attr, locate]) => {
				const el = document.activeElement as HTMLElement | null;
				if (!el || el === document.body) return null;
				// Identity, not appearance. Tab reaches things the focusable selector
				// does not list -- `<video controls>` is the common one -- and giving
				// every unmarked element the same synthetic `<tag>` id made two
				// different videos in a row look like one element focus never left.
				// That fabricated four keyboard traps on a clean course.
				if (el.dataset[mark] === undefined) {
					el.dataset[mark] = `u${document.querySelectorAll(`[${attr}]`).length}`;
				}
				return {
					id: el.dataset[mark] as string,
					tag: el.tagName.toLowerCase(),
					label: (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80),
					where: (0, eval)(locate)(el) as string,
				};
			},
			[MARK, MARK_ATTR, UNIQUE_SELECTOR] as const,
		);
		if (!at) break;

		// `<video controls>` and `<audio controls>` hold focus on the host while Tab
		// moves between their play, timeline and volume buttons -- those live in a
		// user-agent shadow root Chromium will not let us read, so focus is moving
		// and we cannot see it. Counting the repeat invented four keyboard traps on
		// a course that has none.
		const mediaControls = at.tag === "video" || at.tag === "audio";
		if (!mediaControls && order.length >= 2 && order.at(-1) === at.id && order.at(-2) === at.id) {
			findings.push({
				what: "Keyboard focus is stuck here — pressing Tab does not move on.",
				page: pageId,
				selector: at.where || undefined,
				evidence: `${at.label ? `accessible name ${JSON.stringify(at.label)}; ` : ""}Tab pressed 3 times, focus never left element ${at.id}`,
				fix: "Let Tab leave the component, and close it on Escape.",
				lens: "a11y",
				confidence: "high",
				basis: "WCAG 2.1.2 No Keyboard Trap (A)",
				rule: "keyboard-trap",
			});
			// Step over the trap and keep walking. Returning here meant a page with
			// two traps only ever reported one -- and when the player itself
			// contains one (LiaScript does), every trap in the authored content
			// downstream of it became invisible.
			trapped.add(at.id);
			if (trapped.size >= MAX_TRAPS) {
				notes.push(`tab walk stopped on ${pageId} after ${MAX_TRAPS} traps`);
				break;
			}
			const resumed = await page.evaluate(
				([attr, seen]) => {
					const all = Array.from(document.querySelectorAll<HTMLElement>(`[${attr}]`));
					const next = all.find((el) => !seen.includes(el.getAttribute(attr) ?? ""));
					if (!next) return false;
					next.focus();
					return document.activeElement === next;
				},
				[MARK_ATTR, [...trapped, ...order]] as const,
			);
			if (!resumed) {
				notes.push(`tab walk stopped on ${pageId}: no reachable control past the trap`);
				break;
			}
			order.push(at.id);
			continue;
		}
		order.push(at.id);
	}

	if (order.length === 0) {
		findings.push({
			what: "Tab reaches none of this page's controls.",
			page: pageId,
			evidence: `${total} focusable elements in the DOM, 0 reached by Tab`,
			fix: "Check for a container intercepting keydown, or content removed from the tab order.",
			lens: "a11y",
			confidence: "high",
			basis: "WCAG 2.1.1 Keyboard (A)",
			rule: "keyboard-unreachable",
		});
	}
	return { findings, notes };
}

/** Probe actual overflow with the browser's own keyboard scrolling behavior. */
export async function keyboardScrollableRegions(page: Page, pageId: string): Promise<CheckResult> {
	const candidates = await page.evaluate(([focusable, locate]) => {
		const selector = (0, eval)(locate) as (el: Element) => string;
		return Array.from(document.querySelectorAll<HTMLElement>("body *")).flatMap((el, index) => {
			if (el.matches("html, body")) return [];
			const style = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return [];
			const vertical = /^(?:auto|scroll)$/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
			const horizontal = /^(?:auto|scroll)$/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
			if (!vertical && !horizontal) return [];
			el.dataset.praxAuditScrollId = String(index);
			return [{
				id: index,
				selector: selector(el),
				vertical,
				horizontal,
				dimensions: `${el.clientWidth}×${el.clientHeight} viewport, ${el.scrollWidth}×${el.scrollHeight} content`,
				focusable,
			}];
		});
	}, [FOCUSABLE, UNIQUE_SELECTOR] as const);

	const findings: Finding[] = [];
	const notes: string[] = [];
	const limit = Math.min(candidates.length, 30);
	if (candidates.length > limit) notes.push(`keyboard-scroll check covered ${limit} of ${candidates.length} regions on ${pageId}`);
	const pageScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));

	for (const candidate of candidates.slice(0, limit)) {
		const region = page.locator(`[data-prax-audit-scroll-id="${candidate.id}"]`);
		const setup = await region.evaluate((el, focusable) => {
			const region = el as HTMLElement;
			const original = { top: region.scrollTop, left: region.scrollLeft };
			region.scrollTo(0, 0);
			const usable = (node: HTMLElement) => {
				const style = getComputedStyle(node);
				const rect = node.getBoundingClientRect();
				return !node.matches(":disabled, [inert] *") && node.tabIndex >= 0 && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
			};
			const descendants = Array.from(region.querySelectorAll<HTMLElement>(focusable)).filter(usable);
			const regionCanFocus = (region.tabIndex >= 0 || region.hasAttribute("tabindex")) && !region.matches(":disabled, [inert] *");
			const target = regionCanFocus ? region : descendants[0];
			const last = descendants.at(-1);
			if (!target) (document.activeElement as HTMLElement | null)?.blur();
			else target.focus({ preventScroll: true });
			return {
				original,
				focusTarget: target ? (target.getAttribute("aria-label") || target.innerText || target.tagName).replace(/\s+/g, " ").trim().slice(0, 50) : "none",
				regionFocused: target === region && document.activeElement === region,
				lastMarker: last ? descendants.indexOf(last) : -1,
			};
		}, candidate.focusable);

		let worked = false;
		const keys: string[] = [];
		if (!setup.regionFocused && setup.lastMarker >= 0) {
			worked = await region.evaluate((el, [focusable, marker]) => {
				const region = el as HTMLElement;
				const targets = Array.from(region.querySelectorAll<HTMLElement>(focusable)).filter((node) => node.tabIndex >= 0);
				(document.activeElement as HTMLElement | null)?.blur();
				region.scrollTo(0, 0);
				targets[marker]?.focus();
				return region.scrollTop > 0 || region.scrollLeft > 0;
			}, [candidate.focusable, setup.lastMarker] as const);
			if (worked) keys.push("focus reached hidden descendant");
		}

		for (const key of candidate.vertical ? ["PageDown", "ArrowDown"] : ["ArrowRight"]) {
			if (worked) break;
			keys.push(key);
			await page.keyboard.press(key);
			await page.waitForTimeout(50);
			worked = await region.evaluate((el) => el.scrollTop > 0 || el.scrollLeft > 0);
		}
		const after = await region.evaluate((el, original) => {
			const region = el as HTMLElement;
			const at = { top: region.scrollTop, left: region.scrollLeft };
			region.scrollTo(original.left, original.top);
			return at;
		}, setup.original);
		if (worked) continue;

		findings.push({
			what: "This scrollable region does not respond to keyboard scrolling.",
			page: pageId,
			selector: candidate.selector || undefined,
			evidence: `${candidate.dimensions}; focus target: ${JSON.stringify(setup.focusTarget)}; ${keys.join(" then ")} left scroll at ${after.left},${after.top}`,
			fix: "Put the region in the tab order (usually tabindex=\"0\") and preserve native arrow/Page Down scrolling.",
			lens: "a11y", confidence: "medium",
			basis: "WCAG 2.1.1 Keyboard (A)",
			rule: "scroll-region-keyboard",
		});
	}

	await page.evaluate(({ x, y }) => { (document.activeElement as HTMLElement | null)?.blur(); scrollTo(x, y); }, pageScroll);
	return { findings, notes };
}

/**
 * Does anything about this control change when it takes focus?
 *
 * This was a pixel comparison until a real course proved it unusable: headless
 * Chromium does not *paint* focus rings even though `:focus-visible` matches and
 * the computed outline changes. Verified on the same button in one run --
 * headless: screenshots byte-identical; headed: different. It produced 15
 * confident findings against correctly-built Mantine controls, penalising the
 * very `:focus-visible` pattern that is best practice. Running headed to fix it
 * would demand a display in CI.
 *
 * So: compare computed style instead. Reading `outline` alone would miss
 * box-shadow rings, background and border changes, pseudo-element indicators and
 * ancestor `:focus-within`, so all of those are sampled too. W3C specifies a
 * rendered outcome and this is a proxy for it, so findings stay medium.
 */
export async function focusIndicators(page: Page, pageId: string): Promise<CheckResult> {
	const findings: Finding[] = [];
	const notes: string[] = [];
	await page.addStyleTag({ content: NO_MOTION });

	const total = await markFocusables(page);
	const limit = Math.min(total, MAX_FOCUS_CHECKS);
	if (total > limit) notes.push(`focus-indicator check covered ${limit} of ${total} controls on ${pageId}`);

	const results = await page.evaluate(
		([attr, count, locate]) => {
			const paintedColor = (value: string): string => {
				const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
				return channels.length > 3 && channels[3] === 0 ? "transparent" : value;
			};
			const identity = (value: string): boolean => {
				if (value === "none") return true;
				const body = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")"));
				const numbers = body.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
				return (
					(numbers.length === 6 && numbers.every((n, i) => n === [1, 0, 0, 1, 0, 0][i])) ||
					(numbers.length === 16 && numbers.every((n, i) => n === (i % 5 === 0 ? 1 : 0)))
				);
			};
			const shadow = (value: string): string => {
				if (value === "none") return "";
				const colors = Array.from(value.matchAll(/rgba?\([^)]+\)/g), (match) => paintedColor(match[0]));
				if (colors.length > 0 && colors.every((color) => color === "transparent")) return "";
				const lengths = value.match(/-?\d+(?:\.\d+)?px/g)?.map(Number.parseFloat) ?? [];
				return !value.includes("inset") && lengths.length > 0 && lengths.every((length) => length === 0) ? "" : value;
			};
			const filter = (value: string): string => {
				if (value === "none") return "";
				const effects = value.match(/[a-z-]+\([^)]+\)/g) ?? [];
				return effects.length > 0 && effects.every((effect) => /^(?:blur\(0px\)|brightness\((?:1|100%)\)|contrast\((?:1|100%)\)|grayscale\((?:0|0%)\)|hue-rotate\(0deg\)|invert\((?:0|0%)\)|opacity\((?:1|100%)\)|saturate\((?:1|100%)\)|sepia\((?:0|0%)\))$/.test(effect)) ? "" : value;
			};
			// Element, three ancestors (for :focus-within), and both pseudo-elements.
			const snapshot = (el: HTMLElement): string => {
				const parts: string[] = [];
				// Element, ancestors, siblings and a few descendants. The custom
				// checkbox pattern -- visually-hidden input, ring drawn on the adjacent
				// label via `#opt:focus-visible + label::before` -- puts the only
				// indicator on a sibling. Sampling the element and its ancestors alone
				// reported no visible focus indicator for a control that is plainly focused, which
				// would have accused every page using that very common pattern.
				const nodes: HTMLElement[] = [];
				let up: HTMLElement | null = el;
				for (let depth = 0; up && depth < 4; depth++, up = up.parentElement) nodes.push(up);
				for (const sib of Array.from(el.parentElement?.children ?? [])) {
					if (sib !== el && sib instanceof HTMLElement) nodes.push(sib);
				}
				for (const kid of Array.from(el.querySelectorAll<HTMLElement>("*")).slice(0, 8)) nodes.push(kid);

				for (const node of nodes) {
					for (const pseudo of [null, "::before", "::after"]) {
						const style = getComputedStyle(node, pseudo);
						// A non-generated pseudo-element has computed styles but paints
						// nothing. Including those values made inherited focus changes look
						// like indicators that do not exist.
						if (
							pseudo &&
							(style.content === "none" || style.content === "normal" || style.display === "none")
						) continue;

						const border = ["Top", "Right", "Bottom", "Left"]
							.map((side) => {
								const width = style[`border${side}Width` as keyof CSSStyleDeclaration];
								const kind = style[`border${side}Style` as keyof CSSStyleDeclaration];
								if (kind === "none" || kind === "hidden" || Number.parseFloat(String(width)) === 0) return "";
								const color = paintedColor(String(style[`border${side}Color` as keyof CSSStyleDeclaration]));
								return color === "transparent" ? "" : `${width} ${kind} ${color}`;
							})
							.join(";");
						const outline =
							style.outlineStyle === "none" || Number.parseFloat(style.outlineWidth) === 0 || paintedColor(style.outlineColor) === "transparent"
								? ""
								: `${style.outlineWidth} ${style.outlineStyle} ${paintedColor(style.outlineColor)} ${style.outlineOffset}`;
						parts.push(
							outline,
							shadow(style.boxShadow),
							paintedColor(style.backgroundColor),
							style.backgroundImage === "none" ? "" : style.backgroundImage,
							border,
							paintedColor(style.color),
							style.textDecorationLine === "none" ? "" : style.textDecoration,
							identity(style.transform) ? "" : style.transform,
							filter(style.filter),
							style.opacity,
						);
						if (pseudo) parts.push(style.content, style.width, style.height);
					}
				}
				return parts.join("|");
			};

			const out: Array<{ index: number; changed: boolean; label: string; where: string }> = [];
			for (let i = 0; i < count; i++) {
				const el = document.querySelector<HTMLElement>(`[${attr}="${i}"]`);
				if (!el) continue;
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				if (getComputedStyle(el).visibility === "hidden") continue;

				(document.activeElement as HTMLElement | null)?.blur();
				const before = snapshot(el);
				el.focus();
				if (document.activeElement !== el) continue;
				const after = snapshot(el);
				out.push({
					index: i,
					changed: before !== after,
					label: (el.getAttribute("aria-label") || el.innerText || el.tagName).trim().slice(0, 40),
					where: (0, eval)(locate)(el) as string,
				});
			}
			return out;
		},
		[MARK_ATTR, limit, UNIQUE_SELECTOR] as const,
	);

	for (const result of results) {
		if (result.changed) continue;
		findings.push({
			what: "This control has no visible focus indicator.",
			page: pageId,
			selector: result.where || undefined,
			evidence: `no computed style change on focus for "${result.label}" (element, ancestors, and pseudo-elements)`,
			fix: "Give it a visible focus indicator; never remove the browser default without replacing it.",
			lens: "a11y",
			confidence: "medium",
			basis: "WCAG 2.4.7 Focus Visible (AA)",
			rule: "focus-visible",
		});
	}

	// A check that examines nothing returns the same empty result as a clean page.
	// It has already happened once (a selector that matched no element), so the
	// difference is reported rather than inferred.
	if (limit > 0 && results.length === 0) {
		notes.push(
			`focus-indicator check sampled 0 of ${limit} controls on ${pageId} — treat as not run, not as clean`,
		);
	}
	return { findings, notes };
}

interface StateContrastSnapshot {
	selector: string;
	label: string;
	text?: { ratio: number; threshold: number; foreground: string; background: string };
	cues: Array<{ name: string; ratio: number; signature: string }>;
	cueSignature: string;
	manual: boolean;
}

const STATE_CONTRAST_SNAPSHOT = `((el, colorHelpers, locate) => {
	const { parse, paint, contrast, background, colors } = (0, eval)(colorHelpers);
	const selector = (0, eval)(locate);
	const style = getComputedStyle(el);
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
	let manual = false;
	const rgb = (value) => "rgb(" + value.map((channel) => Math.round(channel)).join(" ") + ")";

	const textNodes = [el, ...el.querySelectorAll("*")].filter((node) => {
		const ownText = Array.from(node.childNodes).some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent || "").trim());
		return ownText || (node === el && node.matches("input:not([type=checkbox]):not([type=radio])") && (node.value || node.placeholder));
	});
	const text = textNodes.flatMap((node) => {
		const nodeStyle = getComputedStyle(node);
		const under = background(node);
		if (!under || nodeStyle.backgroundImage !== "none" || Number(nodeStyle.opacity) < 1) { manual = true; return []; }
		const foreground = paint(nodeStyle.color, under);
		if (!foreground) { manual = true; return []; }
		const size = Number.parseFloat(nodeStyle.fontSize);
		const weight = Number.parseInt(nodeStyle.fontWeight, 10) || 400;
		const threshold = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
		return [{ ratio: contrast(foreground, under), threshold, foreground: rgb(foreground), background: rgb(under) }];
	}).sort((a, b) => a.ratio / a.threshold - b.ratio / b.threshold)[0];

	const outer = background(el.parentElement);
	const cues = [];
	if (!outer || style.backgroundImage !== "none") manual = true;
	else {
		const inside = paint(style.backgroundColor, outer) || outer;
		const ownBackground = parse(style.backgroundColor);
		if (ownBackground && ownBackground[3] > 0) cues.push({
			name: "background edge", ratio: contrast(inside, outer), signature: style.backgroundColor,
		});
		for (const side of ["Top", "Right", "Bottom", "Left"]) {
			if (style["border" + side + "Style"] === "none" || style["border" + side + "Style"] === "hidden" || Number.parseFloat(style["border" + side + "Width"]) === 0) continue;
			const value = style["border" + side + "Color"];
			const declared = parse(value);
			if (!declared || declared[3] === 0) continue;
			const overOuter = paint(value, outer);
			const overInner = paint(value, inside);
			if (overOuter && overInner) cues.push({
				name: side.toLowerCase() + " border",
				ratio: Math.min(contrast(overOuter, outer), contrast(overInner, inside)),
				signature: style["border" + side + "Width"] + " " + style["border" + side + "Style"] + " " + value,
			});
		}
		if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) {
			const color = paint(style.outlineColor, outer);
			if (color) cues.push({
				name: "outline", ratio: contrast(color, outer),
				signature: style.outlineWidth + " " + style.outlineStyle + " " + style.outlineColor + " " + style.outlineOffset,
			});
		}
		for (const value of colors(style.boxShadow)) {
			const color = paint(value, outer);
			if (color) cues.push({ name: "box shadow", ratio: contrast(color, outer), signature: style.boxShadow });
		}
	}

	return {
		selector: selector(el),
		label: (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.tagName).replace(/\\s+/g, " ").trim().slice(0, 80),
		text, cues,
		cueSignature: [
			style.backgroundColor, style.backgroundImage,
			style.borderTop, style.borderRight, style.borderBottom, style.borderLeft,
			style.outline, style.boxShadow,
		].join("|"),
		manual,
	};
})`;

async function stateContrastSnapshots(
	page: Page,
	count: number,
	focus: boolean,
): Promise<Array<StateContrastSnapshot | null>> {
	return page.evaluate(
		([attr, limit, shouldFocus, probe, colorHelpers, locate]) => {
			const snapshot = (0, eval)(probe) as (el: HTMLElement, colors: string, selector: string) => StateContrastSnapshot | null;
			const out: Array<StateContrastSnapshot | null> = [];
			for (let i = 0; i < limit; i++) {
				const el = document.querySelector<HTMLElement>(`[${attr}="${i}"]`);
				if (!el) { out.push(null); continue; }
				if (shouldFocus) {
					(document.activeElement as HTMLElement | null)?.blur();
					el.focus({ preventScroll: true });
					if (document.activeElement !== el) { out.push(null); continue; }
				}
				out.push(snapshot(el, colorHelpers, locate));
			}
			return out;
		},
		[MARK_ATTR, count, focus, STATE_CONTRAST_SNAPSHOT, COLOR_HELPERS, UNIQUE_SELECTOR] as const,
	);
}

/** Measure authored hover/focus colours rather than assuming the default state represents them. */
export async function stateContrast(page: Page, pageId: string): Promise<CheckResult> {
	await page.addStyleTag({ content: NO_MOTION });
	const total = await markFocusables(page);
	const limit = Math.min(total, MAX_FOCUS_CHECKS);
	const notes = total > limit ? [`state-contrast check covered ${limit} of ${total} controls on ${pageId}`] : [];
	if (limit === 0) return { findings: [], notes };

	const original = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
	const base = await stateContrastSnapshots(page, limit, false);
	const hover: Array<StateContrastSnapshot | null> = [];
	for (let i = 0; i < limit; i++) {
		const target = page.locator(`[${MARK_ATTR}="${i}"]`);
		try {
			await target.hover({ force: true, timeout: 500 });
			hover.push(await target.evaluate(
				(el, [probe, colors, locate]) => ((0, eval)(probe) as (node: HTMLElement, helpers: string, selector: string) => StateContrastSnapshot | null)(el as HTMLElement, colors, locate),
				[STATE_CONTRAST_SNAPSHOT, COLOR_HELPERS, UNIQUE_SELECTOR] as const,
			));
		} catch {
			hover.push(null);
		}
	}
	await page.mouse.move(0, 0);
	const focus = await stateContrastSnapshots(page, limit, true);
	await page.evaluate(({ x, y }) => { (document.activeElement as HTMLElement | null)?.blur(); scrollTo(x, y); }, original);

	const findings: Finding[] = [];
	const needsReview: ReviewItem[] = [];
	const reviewed = new Set<string>();
	for (let i = 0; i < limit; i++) {
		const before = base[i];
		if (!before) continue;
		for (const [state, after] of [["hover", hover[i]], ["focus", focus[i]]] as const) {
			if (!after) continue;
			if (before.manual || after.manual) {
				const selector = after.selector || before.selector;
				const key = `${state}\n${selector}`;
				if (!reviewed.has(key)) {
					reviewed.add(key);
					needsReview.push({
						what: `This control's ${state} contrast could not be determined automatically.`,
						page: pageId,
						selector: selector || undefined,
						evidence: `${state}; image, gradient, or opacity-backed colour compositing requires review`,
						lens: "a11y",
						basis: "WCAG 1.4.3 / 1.4.11 (AA)",
						rule: "state-contrast-compositing",
					});
				}
			}
			if (
				before.text && after.text &&
				before.text.ratio >= before.text.threshold &&
				after.text.ratio < after.text.threshold
			) findings.push({
				what: `This control's text falls to ${after.text.ratio.toFixed(2)}:1 contrast on ${state}.`,
				page: pageId,
				selector: after.selector || undefined,
				evidence: `${state}; ${after.text.foreground} on ${after.text.background}; ${after.text.ratio.toFixed(2)}:1 (required: ${after.text.threshold}:1; default: ${before.text.ratio.toFixed(2)}:1)`,
				fix: `Keep the ${state} text and background colors at or above ${after.text.threshold}:1 contrast.`,
				lens: "a11y", confidence: "medium",
				basis: "WCAG 1.4.3 Contrast (Minimum) (AA)",
				rule: "state-text-contrast",
			});

			// Hover text still has to meet 1.4.3. A visual hover treatment is not,
			// by itself, information required to identify the component or its state;
			// treating every subtle hover fill as 1.4.11 produced 160 false defects
			// on one real export.
			if (state === "hover" || before.cueSignature === after.cueSignature) continue;
			const beforeCues = new Map(before.cues.map((cue) => [cue.name, cue.signature]));
			const changed = after.cues
				.filter((cue) => beforeCues.get(cue.name) !== cue.signature)
				.sort((a, b) => b.ratio - a.ratio)[0];
			if (changed && changed.ratio >= 3) continue;
			findings.push({
				what: "This control does not have a focus indicator with at least 3:1 contrast.",
				page: pageId,
				selector: after.selector || undefined,
				evidence: changed
					? `${state}; strongest changed cue is ${changed.name} at ${changed.ratio.toFixed(2)}:1 (required: 3:1)`
					: `${state}; authored paint changed but no contrasting boundary, outline, background edge, or shadow was measurable`,
				fix: `Give the ${state} state a boundary, outline, background edge, or shadow with at least 3:1 contrast against adjacent colors.`,
				lens: "a11y", confidence: "medium",
				basis: "WCAG 1.4.11 Non-text Contrast (AA)",
				rule: "state-non-text-contrast",
			});
		}
	}
	return { findings, needsReview, notes };
}

/**
 * 1.4.11 is a rendered-result criterion. Solid CSS boundaries and SVG paint
 * are measurable without guessing at raster pixels; semantic importance and
 * complex paint remain manual judgements, so findings are medium confidence.
 */
export async function nonTextContrast(page: Page, pageId: string): Promise<CheckResult> {
	const measured = await page.evaluate(([locate, colorHelpers]) => {
		type RGB = [number, number, number];
		type RGBA = [number, number, number, number];
		type Kind = "component" | "graphic";
		type Issue = { kind: Kind; selector: string; ratio: number; detail: string };
		type Manual = { kind: Kind; selector: string; reason: string };
		(document.activeElement as HTMLElement | null)?.blur();
		const { parse, paint, contrast, background, colors } = (0, eval)(colorHelpers) as {
			parse: (value: string) => RGBA | undefined;
			paint: (value: string, under: RGB, opacity?: number) => RGB | undefined;
			contrast: (a: RGB, b: RGB) => number;
			background: (start: Element | null) => RGB | undefined;
			colors: (value: string) => string[];
		};
		const selector = (0, eval)(locate) as (el: Element) => string;
		const manual = new Map<string, Manual>();
		const review = (kind: Kind, el: Element, reason: string) => {
			const where = selector(el);
			manual.set(`${kind}\n${where}\n${reason}`, { kind, selector: where, reason });
		};
		const visible = (el: Element) => {
			const style = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
		};

		const issues: Issue[] = [];
		for (const el of Array.from(document.querySelectorAll('img[alt]:not([alt=""]), canvas[role=img]'))) {
			review("graphic", el, "raster or canvas content cannot be measured from CSS colours");
		}
		const frame = document.createElement("iframe");
		frame.setAttribute("aria-hidden", "true");
		frame.style.cssText = "all:initial!important;position:fixed!important;left:-10000px!important;width:10px!important;height:10px!important;border:0!important";
		document.documentElement.append(frame);
		const cleanDocument = frame.contentDocument;
		const cleanWindow = frame.contentWindow;
		const signature = (style: CSSStyleDeclaration) => [
			style.appearance, style.backgroundColor, style.backgroundImage, style.boxShadow,
			...(["Top", "Right", "Bottom", "Left"] as const).flatMap((side) => [
				style[`border${side}Color`], style[`border${side}Style`], style[`border${side}Width`],
			]),
		].join("|");
		const controls = document.querySelectorAll<HTMLElement>(
			'button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=slider], [role=spinbutton], [role=textbox], [role=searchbox]',
		);

		for (const el of Array.from(controls)) {
			if (!visible(el) || el.matches(":disabled, [aria-disabled=true]") || el.closest("[inert]")) continue;
			const style = getComputedStyle(el);
			const outer = background(el.parentElement);
			if (!outer || style.backgroundImage !== "none") {
				review("component", el, "background uses an image or gradient, or its colour layers could not be composited");
				continue;
			}

			if (cleanDocument?.body && cleanWindow && el.matches("button, input, select, textarea")) {
				const clean = cleanDocument.createElement(el.localName);
				for (const name of ["type", "multiple", "size"]) {
					const value = el.getAttribute(name);
					if (value !== null) clean.setAttribute(name, value);
				}
				if (clean.localName === "input" && el.localName === "input") {
					(clean as HTMLInputElement).checked = (el as HTMLInputElement).checked;
				}
				cleanDocument.body.append(clean);
				const browserDefault = cleanWindow.getComputedStyle(clean);
				const unmodified = signature(style) === signature(browserDefault);
				clean.remove();
				if (unmodified) continue;
			}

			const inside = paint(style.backgroundColor, outer) ?? outer;
			const cues: Array<{ ratio: number; name: string }> = [];
			const backgroundColor = parse(style.backgroundColor);
			if (backgroundColor && backgroundColor[3] > 0) {
				cues.push({ ratio: contrast(inside, outer), name: "background edge" });
			}
			for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
				if (
					style[`border${side}Style`] === "none" ||
					style[`border${side}Style`] === "hidden" ||
					Number.parseFloat(style[`border${side}Width`]) === 0
				) continue;
				const color = style[`border${side}Color`];
				// A transparent border reserves layout but paints no identifying cue.
				const declared = parse(color);
				if (!declared || declared[3] === 0) continue;
				const overOuter = paint(color, outer);
				const overInner = paint(color, inside);
				if (overOuter && overInner) cues.push({
					ratio: Math.min(contrast(overOuter, outer), contrast(overInner, inside)),
					name: `${side.toLowerCase()} border`,
				});
			}
			if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) {
				const color = paint(style.outlineColor, outer);
				if (color) cues.push({ ratio: contrast(color, outer), name: "outline" });
			}
			for (const value of colors(style.boxShadow)) {
				const color = paint(value, outer);
				if (color) cues.push({ ratio: contrast(color, outer), name: "box shadow" });
			}

			// A contrasting visible label or icon can identify a control without a boundary.
			const glyph = parse(style.color);
			const glyphRatio = glyph && glyph[3] > 0 ? contrast(paint(style.color, inside) ?? inside, inside) : 0;
			const hasVisibleGlyph =
				glyphRatio >= 3 &&
				((el.textContent ?? "").trim().length > 0 ||
					el.querySelector("svg, img, [class*=icon], [class*=Icon]") !== null ||
					getComputedStyle(el, "::before").content !== "none" ||
					getComputedStyle(el, "::after").content !== "none");

			const strongest = cues.sort((a, b) => b.ratio - a.ratio)[0];
			if (!hasVisibleGlyph && strongest && strongest.ratio < 3) issues.push({
				kind: "component",
				selector: selector(el),
				ratio: strongest.ratio,
				detail: `strongest measurable cue: ${strongest.name}`,
			});
		}
		frame.remove();

		for (const svg of Array.from(document.querySelectorAll<SVGSVGElement>("svg"))) {
			if (!visible(svg) || svg.matches('[aria-hidden=true], [role=none], [role=presentation]')) continue;
			const name = (svg.getAttribute("aria-label") || svg.querySelector("title")?.textContent || "").trim();
			if (!name && svg.getAttribute("role") !== "img") continue;
			const identity = `${name} ${svg.id} ${svg.getAttribute("class") ?? ""}`;
			if (/\b(?:logo|logotype|flag|photo|photograph|screenshot)\b/i.test(identity)) continue;
			const svgBackground = background(svg);
			if (!svgBackground) {
				review("graphic", svg, "background uses an image or gradient, or its colour layers could not be composited");
				continue;
			}

			type Painted = { rect: DOMRect; color: RGB };
			const painted: Painted[] = [];
			const svgRect = svg.getBoundingClientRect();
			const shapes = svg.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon") as NodeListOf<SVGGraphicsElement>;
			for (const shape of Array.from(shapes)) {
				if (!visible(shape) || shape.closest("defs, clipPath, mask, symbol")) continue;
				const style = getComputedStyle(shape);
				const rect = shape.getBoundingClientRect();
				const backdrop = [...painted].reverse().find((item) =>
					item.rect.left <= rect.left && item.rect.top <= rect.top &&
					item.rect.right >= rect.right && item.rect.bottom >= rect.bottom
				)?.color ?? svgBackground;
				const opacity = Number.parseFloat(style.opacity || "1");
				const cues: Array<{ ratio: number; name: string }> = [];
				const backdropShape = painted.length === 0 && rect.width >= svgRect.width * 0.9 && rect.height >= svgRect.height * 0.9;

				if (style.fill !== "none" && !style.fill.startsWith("url(")) {
					const fill = paint(style.fill, backdrop, opacity * Number.parseFloat(style.fillOpacity || "1"));
					if (fill) {
						if (!backdropShape) cues.push({ ratio: contrast(fill, backdrop), name: "fill" });
						painted.push({ rect, color: fill });
					}
				} else if (style.fill.startsWith("url(")) review("graphic", shape, "SVG fill uses a paint server such as a gradient or pattern");
				if (style.stroke !== "none" && Number.parseFloat(style.strokeWidth) > 0 && !style.stroke.startsWith("url(")) {
					const stroke = paint(style.stroke, backdrop, opacity * Number.parseFloat(style.strokeOpacity || "1"));
					if (stroke) cues.push({ ratio: contrast(stroke, backdrop), name: "stroke" });
				} else if (style.stroke.startsWith("url(")) review("graphic", shape, "SVG stroke uses a paint server such as a gradient or pattern");

				const strongest = cues.sort((a, b) => b.ratio - a.ratio)[0];
				if (strongest && strongest.ratio < 3) issues.push({
					kind: "graphic",
					selector: selector(shape),
					ratio: strongest.ratio,
					detail: `${strongest.name} in graphic “${name.slice(0, 50)}”`,
				});
			}
		}
		return {
			issues: issues.slice(0, 30),
			manual: [...manual.values()].slice(0, 30),
			manualOmitted: Math.max(0, manual.size - 30),
		};
	}, [UNIQUE_SELECTOR, COLOR_HELPERS] as const);

	return {
		findings: measured.issues.map((issue) => ({
			what: issue.kind === "component"
				? `This control's visible boundary has only ${issue.ratio.toFixed(2)}:1 contrast with its surroundings.`
				: `A part of this graphic needed to understand it has only ${issue.ratio.toFixed(2)}:1 contrast with its background.`,
			page: pageId,
			selector: issue.selector,
			evidence: `${issue.ratio.toFixed(2)}:1 (required: 3:1); ${issue.detail}`,
			fix: issue.kind === "component"
				? "Increase the contrast of the control's border, background edge, outline, or shadow against adjacent colors."
				: "Increase the contrast of each shape needed to understand the graphic, or provide the same information in text.",
			lens: "a11y",
			confidence: "medium",
			basis: "WCAG 1.4.11 Non-text Contrast (AA)",
			rule: issue.kind === "component" ? "non-text-contrast-component" : "non-text-contrast-graphic",
		})),
		needsReview: measured.manual.map((item) => ({
			what: item.kind === "component"
				? "This control's non-text contrast could not be determined automatically."
				: "This graphic's non-text contrast could not be determined automatically.",
			page: pageId,
			selector: item.selector || undefined,
			evidence: item.reason,
			lens: "a11y" as const,
			basis: "WCAG 1.4.11 Non-text Contrast (AA)",
			rule: "non-text-contrast-compositing",
		})),
		notes: measured.manualOmitted > 0
			? [`non-text contrast review items omitted after the 30-item page cap on ${pageId}: ${measured.manualOmitted}`]
			: [],
	};
}

/** Only total opaque coverage fails AA; partial overlap belongs to 2.4.12 AAA. */
export async function focusNotObscured(page: Page, pageId: string): Promise<CheckResult> {
	const total = await markFocusables(page);
	const limit = Math.min(total, MAX_FOCUS_CHECKS);
	const covered = await page.evaluate(
		([attr, count, locate]) => {
			const original = { x: scrollX, y: scrollY };
			const out: Array<{ index: number; cover: string; rect: string; where: string; label: string }> = [];
			const selector = (0, eval)(locate) as (el: Element) => string;
			const alpha = (value: string) => Number(value.match(/[\d.]+/g)?.[3] ?? 1);
			for (let i = 0; i < count; i++) {
				const el = document.querySelector<HTMLElement>(`[${attr}="${i}"]`);
				if (!el) continue;
				(document.activeElement as HTMLElement | null)?.blur();
				el.focus();
				if (document.activeElement !== el) continue;
				const style = getComputedStyle(el);
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.opacity === "0") continue;
				const visible = {
					left: Math.max(0, rect.left), top: Math.max(0, rect.top),
					right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom),
				};
				if (visible.right <= visible.left || visible.bottom <= visible.top) continue;
				const point = { x: (visible.left + visible.right) / 2, y: (visible.top + visible.bottom) / 2 };
				const stack = document.elementsFromPoint(point.x, point.y);
				const focusIndex = stack.findIndex((hit) => hit === el || el.contains(hit));

				for (const cover of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
					if (cover === el || cover.contains(el) || el.contains(cover)) continue;
					const coverStyle = getComputedStyle(cover);
					if (coverStyle.position !== "fixed" && coverStyle.position !== "sticky") continue;
					if (coverStyle.display === "none" || coverStyle.visibility === "hidden" || Number(coverStyle.opacity) < 1) continue;
					if (alpha(coverStyle.backgroundColor) < 1 && coverStyle.backgroundImage === "none") continue;
					const box = cover.getBoundingClientRect();
					if (box.left > visible.left || box.top > visible.top || box.right < visible.right || box.bottom < visible.bottom) continue;
					const coverIndex = stack.findIndex((hit) => hit === cover || cover.contains(hit));
					if (coverIndex < 0 || (focusIndex >= 0 && coverIndex > focusIndex)) continue;
					out.push({
						index: i,
						cover: selector(cover),
						where: selector(el),
						label: (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80),
						rect: `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
					});
					break;
				}
			}
			scrollTo(original.x, original.y);
			return out;
		},
		[MARK_ATTR, limit, UNIQUE_SELECTOR] as const,
	);

	return {
		findings: covered.map((item) => ({
			what: "This control is completely hidden behind another page element when it receives keyboard focus.",
			page: pageId,
			selector: item.where || undefined,
			evidence: `${item.label ? `accessible name ${JSON.stringify(item.label)}; ` : ""}focused rectangle ${item.rect} is fully covered by ${item.cover}`,
			fix: "Add scroll padding or move/dismiss the fixed or sticky content so part of the focused control remains visible.",
			lens: "a11y",
			confidence: "medium",
			basis: "WCAG 2.4.11 Focus Not Obscured (Minimum) (AA)",
			rule: "focus-not-obscured",
		})),
		notes: total > limit ? [`focus-obscuring check covered ${limit} of ${total} controls on ${pageId}`] : [],
	};
}

const EXEMPT = "table, img, svg, video, iframe, canvas, pre, code, object, embed, [role=img]";

interface HorizontalOverflow {
	selector: string;
	right: number;
	exempt: boolean;
	text: boolean;
}

async function horizontalOverflow(page: Page): Promise<HorizontalOverflow[]> {
	return page.evaluate(([exempt, locate]) => {
		const selector = (0, eval)(locate) as (el: Element) => string;
		const width = document.documentElement.clientWidth;
		if (document.documentElement.scrollWidth <= width + 1) return [];
		const out: HorizontalOverflow[] = [];
		for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.right <= width + 1) continue;
			// Only the outermost offender: an overflowing parent drags its children.
			if (el.parentElement && el.parentElement.getBoundingClientRect().right > width + 1) continue;
			out.push({
				selector: selector(el),
				right: Math.round(rect.right),
				exempt: el.matches(exempt) || el.closest(exempt) !== null,
				text: Array.from(el.childNodes).some(
					(node) => node.nodeType === 3 && (node.textContent ?? "").trim().length > 0,
				) || el.matches("a, button, input, select, textarea"),
			});
		}
		return out;
	}, [EXEMPT, UNIQUE_SELECTOR] as const);
}

/**
 * 1.4.10 at a 320 CSS px viewport. `scrollWidth > clientWidth` alone is not the
 * test — maps, diagrams, video and data tables are exempt and legitimately
 * overflow, so exemption-dependent overflow is reported as needs-review.
 */
export async function reflow(page: Page, pageId: string): Promise<CheckResult> {
	const original = page.viewportSize();
	let overflow: HorizontalOverflow[] = [];
	try {
		await page.setViewportSize({ width: 320, height: 800 });
		await page.waitForTimeout(150);
		overflow = await horizontalOverflow(page);
	} finally {
		if (original && !page.isClosed()) await page.setViewportSize(original);
	}

	return {
		findings: overflow.map((o) => ({
			what: "Content runs off the side of the screen at 320px wide, forcing sideways scrolling.",
			page: pageId,
			selector: o.selector,
			evidence: `right edge at ${o.right}px in a 320px viewport`,
			fix: "Let the container wrap or shrink; avoid fixed widths above 320px.",
			lens: "a11y",
			// Exempt content may legitimately overflow, so only non-exempt text and
			// controls are a conclusive failure.
			confidence: o.exempt || !o.text ? "medium" : "high",
			basis: "WCAG 1.4.10 Reflow (AA)",
			rule: "reflow-320",
		})),
		notes: [],
	};
}

const SPACING = `* {
	line-height: 1.5 !important;
	letter-spacing: 0.12em !important;
	word-spacing: 0.16em !important;
}
p { margin-bottom: 2em !important; }`;

const TEXT_RANGE_OVERFLOW = `(el, axis) => {
	const box = el.getBoundingClientRect();
	const bounds = {
		left: box.left + el.clientLeft,
		top: box.top + el.clientTop,
		right: box.left + el.clientLeft + el.clientWidth,
		bottom: box.top + el.clientTop + el.clientHeight,
	};
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	let overflow = 0;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!(node.textContent || "").trim()) continue;
		range.selectNodeContents(node);
		for (const rect of Array.from(range.getClientRects())) {
			overflow = Math.max(overflow, axis === "vertical"
				? Math.max(rect.bottom - bounds.bottom, bounds.top - rect.top)
				: Math.max(rect.right - bounds.right, bounds.left - rect.left));
		}
	}
	return Math.max(0, overflow);
}`;

interface TextClipState {
	selector: string;
	vertical: boolean;
	horizontal: boolean;
	verticalOverflow: number;
	horizontalOverflow: number;
	clamped: boolean;
}

async function textClipState(page: Page): Promise<TextClipState[]> {
	return page.evaluate(
		([locate, measure]) => {
			const selector = (0, eval)(locate) as (el: Element) => string;
			const rangeOverflow = (0, eval)(measure) as (el: HTMLElement, axis: "horizontal" | "vertical") => number;
			const out: TextClipState[] = [];
			for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
				const style = getComputedStyle(el);
				const vertical = /hidden|clip/.test(style.overflowY);
				const horizontal = /hidden|clip/.test(style.overflowX) && style.whiteSpace === "nowrap";
				if (!vertical && !horizontal) continue;
				if ((el.innerText ?? "").trim().length === 0) continue;
				const rect = el.getBoundingClientRect();
				if (rect.width <= 4 || rect.height <= 4 || style.clipPath !== "none") continue;
				if (style.clip !== "auto" && style.clip !== "") continue;
				if (style.visibility === "hidden" || style.opacity === "0") continue;
				const where = selector(el);
				if (!where) continue;
				out.push({
					selector: where,
					vertical,
					horizontal,
					verticalOverflow: vertical ? rangeOverflow(el, "vertical") : 0,
					horizontalOverflow: horizontal ? rangeOverflow(el, "horizontal") : 0,
					clamped: style.webkitLineClamp !== "none" && style.webkitLineClamp !== "",
				});
			}
			return out;
		},
		[UNIQUE_SELECTOR, TEXT_RANGE_OVERFLOW] as const,
	);
}

/** Exercise the new OS text preference only when the document explicitly opts in. */
export async function textScale(page: Page, pageId: string): Promise<CheckResult> {
	const optedIn = await page.evaluate(() =>
		document.querySelector<HTMLMetaElement>('meta[name="text-scale" i]')?.content.trim().toLowerCase() === "scale",
	);
	if (!optedIn) return { findings: [], notes: [] };

	const original = page.viewportSize();
	const session = await page.context().newCDPSession(page);
	let baselineOverflow: HorizontalOverflow[] = [];
	let scaledOverflow: HorizontalOverflow[] = [];
	let baselineClips: TextClipState[] = [];
	let scaledClips: TextClipState[] = [];
	let baselineObscured: CheckResult = { findings: [], notes: [] };
	let scaledObscured: CheckResult = { findings: [], notes: [] };
	try {
		await page.setViewportSize({ width: 320, height: 800 });
		await page.waitForTimeout(150);
		baselineOverflow = await horizontalOverflow(page);
		baselineClips = await textClipState(page);
		baselineObscured = await focusNotObscured(page, pageId);

		await session.send("Emulation.setEmulatedOSTextScale", { scale: 2 });
		await page.waitForTimeout(150);
		scaledOverflow = await horizontalOverflow(page);
		scaledClips = await textClipState(page);
		scaledObscured = await focusNotObscured(page, pageId);
	} finally {
		if (!page.isClosed()) {
			await session.send("Emulation.setEmulatedOSTextScale", { scale: 1 }).catch(() => {});
			if (original) await page.setViewportSize(original);
		}
		await session.detach().catch(() => {});
	}

	const findings: Finding[] = [];
	const baselineOverflowSelectors = new Set(baselineOverflow.map((item) => item.selector));
	for (const item of scaledOverflow) {
		if (baselineOverflowSelectors.has(item.selector)) continue;
		findings.push({
			what: "Content runs off the side of the screen at 200% operating-system text scale.",
			page: pageId,
			selector: item.selector,
			evidence: `right edge at ${item.right}px in a 320px viewport after text scaled to 200%; baseline fit`,
			fix: "Let the container wrap or grow when the user's preferred text size increases.",
			lens: "a11y",
			confidence: item.exempt || !item.text ? "medium" : "high",
			basis: "WCAG 1.4.4 Resize Text / 1.4.10 Reflow (AA)",
			rule: "text-scale-reflow",
		});
	}

	const baselineClipsBySelector = new Map(baselineClips.map((item) => [item.selector, item]));
	for (const after of scaledClips) {
		const before = baselineClipsBySelector.get(after.selector);
		for (const [axis, overflow, baseline] of [
			["vertical", after.verticalOverflow, before?.verticalOverflow ?? 0],
			["horizontal", after.horizontalOverflow, before?.horizontalOverflow ?? 0],
		] as const) {
			if (!after[axis] || baseline > 2 || overflow <= 2) continue;
			findings.push({
				what: "Text gets cut off at 200% operating-system text scale.",
				page: pageId,
				selector: after.selector,
				evidence: `${Math.ceil(overflow)}px of text newly hidden ${axis}ly after text scaled to 200%; baseline text fit`,
				fix: axis === "horizontal"
					? "Let the text wrap or the container widen instead of clipping its width."
					: "Let the container grow with its content instead of fixing its height.",
				lens: "a11y",
				confidence: after.clamped ? "medium" : "high",
				basis: "WCAG 1.4.4 Resize Text (AA)",
				rule: "text-scale-clip",
			});
		}
	}

	const baselineObscuredSelectors = new Set(baselineObscured.findings.map((item) => item.selector));
	for (const item of scaledObscured.findings) {
		if (baselineObscuredSelectors.has(item.selector)) continue;
		findings.push({
			...item,
			what: "At 200% operating-system text scale, this control becomes completely hidden when focused.",
			evidence: `200% text scale; ${item.evidence}`,
			basis: "WCAG 1.4.4 Resize Text / 2.4.11 Focus Not Obscured (Minimum) (AA)",
			rule: "text-scale-focus-obscured",
		});
	}

	return {
		findings,
		needsReview: scaledObscured.needsReview,
		notes: scaledObscured.notes.map((note) => `200% text scale: ${note}`),
	};
}

/**
 * 1.4.12. Apply the four values and look for text that no longer fits. Only
 * clipping by an `overflow: hidden|clip` ancestor is conclusive — rectangle
 * overlap alone is far too noisy to report (F104).
 */
export async function textSpacing(page: Page, pageId: string): Promise<CheckResult> {
	const baseline = await textClipState(page);

	await page.addStyleTag({ content: SPACING });
	await page.waitForTimeout(150);

	const after = new Map((await textClipState(page)).map((item) => [item.selector, item]));
	const clipped: Array<{ selector: string; overflow: number; axis: "horizontal" | "vertical"; clamped: boolean }> = [];
	for (const item of baseline) {
		const current = after.get(item.selector);
		if (!current) continue;
		if (item.verticalOverflow <= 2 && current.verticalOverflow > 2) clipped.push({
			selector: item.selector,
			overflow: current.verticalOverflow,
			axis: "vertical",
			clamped: item.clamped,
		});
		if (item.horizontalOverflow <= 2 && current.horizontalOverflow > 2) clipped.push({
			selector: item.selector,
			overflow: current.horizontalOverflow,
			axis: "horizontal",
			clamped: item.clamped,
		});
	}

	return {
		findings: clipped.map((c) => ({
			what: "Text gets cut off when line and letter spacing are increased.",
			page: pageId,
			selector: c.selector,
			evidence: `${Math.ceil(c.overflow)}px of text newly hidden ${c.axis}ly by a non-scrollable overflow container after applying WCAG text-spacing values; baseline text fit`,
			fix: c.axis === "horizontal"
				? "Let the text wrap or the container widen instead of clipping its width."
				: "Let the container grow with its content instead of fixing its height.",
			lens: "a11y",
			confidence: c.clamped ? "medium" : "high",
			basis: "WCAG 1.4.12 Text Spacing (AA)",
			rule: "text-spacing-clip",
		})),
		notes: [],
	};
}

/**
 * Alt text that is definitively wrong on its face: an unsubstituted template
 * variable, or a filename. axe's `image-alt` only checks presence, so a
 * non-empty string of either kind passes it.
 *
 * Deliberately excludes vague-but-real alt ("image", "photo"). Judging whether
 * alt text is *meaningful* is class J in the pre-registration and outside this check;
 * adding it here after the fact would be scoring my own homework.
 */
const TEMPLATE = /\{\{.*\}\}|\$\{.*\}|<%.*%>|\{[a-z_][a-z0-9_]*\}/i;
// Anchored to the whole value: `alt="Screenshot showing logo.svg"` is a
// description, not a filename, and matching any string that merely ends in an
// extension accused it.
const FILENAME = /^[\w\-. ]{1,60}\.(jpe?g|png|gif|svg|webp|avif|bmp)$|^(img|dsc|screenshot)[-_ ]?\d+$/i;

export async function altTextQuality(page: Page, pageId: string): Promise<CheckResult> {
	const bad = await page.evaluate((locate) => {
		const selector = (0, eval)(locate) as (el: Element) => string;
		return Array.from(document.querySelectorAll<HTMLImageElement>("img[alt]"))
			.map((el) => ({
				alt: el.getAttribute("alt") ?? "",
				src: el.getAttribute("src") ?? "",
				selector: selector(el),
			}))
			.filter((x) => x.alt.trim().length > 0);
	}, UNIQUE_SELECTOR);

	const findings: Finding[] = [];
	for (const img of bad) {
		const template = TEMPLATE.test(img.alt);
		if (!template && !FILENAME.test(img.alt)) continue;
		findings.push({
			what: template
				? "An image's alt text still contains an unfilled template placeholder."
				: "An image's alt text is a filename rather than a description.",
			page: pageId,
			selector: img.selector,
			evidence: `alt="${img.alt.slice(0, 80)}"${img.src ? ` on image source ${JSON.stringify(img.src.slice(0, 80))}` : ""}`,
			fix: template
				? "Fill in the variable, or supply alt text at authoring time."
				: "Describe what the image conveys, or use alt=\"\" if it is decorative.",
			lens: "a11y",
			confidence: "high",
			basis: "WCAG 1.1.1 Non-text Content (A)",
			rule: template ? "alt-template-variable" : "alt-filename",
		});
	}
	return { findings, notes: [] };
}

/**
 * Link text that is uninformative on its own. Not a judgement about whether a
 * phrase is *meaningful* -- that needs to know what the link points at and what
 * the user wants, and belongs to a later tier. This is the narrower, decidable
 * question: is the entire accessible name one of a known set of phrases that
 * carry no destination information?
 *
 * Screen-reader users navigate by pulling up a list of links. Twelve entries
 * reading "click here" is a list of nothing.
 *
 * Also reports the stronger case: the same link text pointing at different
 * destinations on one page, which fails 2.4.4 even when the phrase itself is
 * fine ("Read more" under six articles).
 */
/**
 * Only phrases that stay uninformative *with* their surroundings. 2.4.4 is
 * "Link Purpose (In Context)", so context is allowed to disambiguate, and an
 * earlier, longer list flagged `<a href="info.html">Info</a>` in a navigation
 * bar -- a perfectly good label. "Next", "Download", "Continue", "View" and
 * "Start" went the same way: fine in pagination, next to a named file, or in a
 * wizard. Precision is this tool's whole asset, so the list stays short.
 */
const USELESS_LINK_TEXT = new Set([
	"click here", "click here for more", "click this link", "follow this link",
	"here", "read more", "more", "learn more", "see more", "this", "this link",
	"link", "click for more", "full story", "click",
]);

export async function linkTextQuality(page: Page, pageId: string): Promise<CheckResult> {
	const links = await page.evaluate((locate) => {
		const selector = (0, eval)(locate) as (el: Element) => string;
		return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
			.filter((el) => {
				const rect = el.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 && !el.closest("[aria-hidden=true]");
			})
			.map((el) => ({
				// The accessible name wins: an aria-label makes visible "click here" fine.
				name: (el.getAttribute("aria-label") ?? el.innerText ?? "").replace(/\s+/g, " ").trim(),
				href: el.getAttribute("href") ?? "",
				selector: selector(el),
			}))
			.filter((x) => x.name.length > 0);
	}, UNIQUE_SELECTOR);

	const findings: Finding[] = [];
	const seen = new Map<string, { targets: Set<string>; selector: string }>();

	for (const link of links) {
		const normalised = link.name.toLowerCase().replace(/[.,:;!?…]+$/g, "").trim();
		if (USELESS_LINK_TEXT.has(normalised)) {
			findings.push({
				what: `A link reads only "${link.name}", which says nothing about where it goes when read on its own.`,
				page: pageId,
				selector: link.selector || undefined,
				evidence: `accessible name is exactly "${link.name}" and destination is ${JSON.stringify(link.href)}; surrounding text was not assessed`,
				fix: "Make the link text name its destination, or add an aria-label that does.",
				lens: "a11y",
				// 2.4.4 (A) allows the *programmatically determined context* -- the
				// enclosing sentence -- to supply the purpose, and "To book a tour,
				// click here" does exactly that. Two independent adjudicators called
				// this FALSE under 2.4.4 and they were right. The criterion that
				// requires the text to stand alone is 2.4.9, which is AAA, so this is
				// advisory rather than a conformance failure at AA.
				confidence: "low",
				basis: "WCAG 2.4.9 Link Purpose (Link Only) (AAA)",
				rule: "link-text-uninformative",
			});
		}
		const group = seen.get(normalised) ?? { targets: new Set<string>(), selector: link.selector };
		group.targets.add(link.href);
		seen.set(normalised, group);
	}

	for (const [name, group] of seen) {
		if (group.targets.size < 2 || USELESS_LINK_TEXT.has(name)) continue;
		findings.push({
			what: `${group.targets.size} links all read "${name}" but go to different places.`,
			page: pageId,
			selector: group.selector || undefined,
			evidence: `accessible name ${JSON.stringify(name)}, ${group.targets.size} distinct destinations: ${[...group.targets].map((target) => JSON.stringify(target)).join(", ")}`,
			fix: "Give each link text that distinguishes its destination, or add distinguishing aria-labels.",
			lens: "a11y",
			// This one does fail 2.4.4: identical names on one page cannot be told
			// apart from a link list, and context cannot disambiguate two links that
			// read the same.
			confidence: "medium",
			basis: "WCAG 2.4.4 Link Purpose (In Context) (A)",
			rule: "link-text-ambiguous",
		});
	}
	return { findings, notes: [] };
}

/** Check an author-declared dark presentation without doubling every interaction probe. */
export async function darkSchemeVisuals(page: Page, pageId: string): Promise<CheckResult> {
	const declaration = await page.evaluate(() => {
		const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme" i]')?.content ?? "";
		const computed = getComputedStyle(document.documentElement).colorScheme;
		let unreadable = 0;
		let media = false;
		for (const sheet of Array.from(document.styleSheets)) {
			try {
				if (Array.from(sheet.cssRules).some((rule) => /prefers-color-scheme\s*:\s*dark/i.test(rule.cssText))) {
					media = true;
					break;
				}
			} catch {
				unreadable++;
			}
		}
		return { supported: /\bdark\b/i.test(`${meta} ${computed}`) || media, unreadable };
	});
	if (!declaration.supported) {
		return {
			findings: [],
			notes: declaration.unreadable > 0
				? [`dark-scheme detection could not inspect ${declaration.unreadable} stylesheet(s) on ${pageId}`]
				: [],
		};
	}

	const findings: Finding[] = [];
	const needsReview: ReviewItem[] = [];
	const notes: string[] = [];
	try {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.waitForTimeout(150);
		for (const check of [runAxe, nonTextContrast, stateContrast, focusIndicators] as const) {
			try {
				const result = await check(page, pageId);
				findings.push(...result.findings.map((finding) => ({
					...finding,
					evidence: `dark colour scheme; ${finding.evidence}`,
				})));
				needsReview.push(...(result.needsReview ?? []).map((item) => ({
					...item,
					evidence: `dark colour scheme; ${item.evidence}`,
				})));
				notes.push(...result.notes.map((note) => `dark colour scheme: ${note}`));
			} catch (error) {
				notes.push(
					`dark colour scheme: ${check.name} did not run on ${pageId}: ${error instanceof Error ? error.message : String(error)} — treat as unchecked, not as clean`,
				);
			}
		}
	} finally {
		if (!page.isClosed()) await page.emulateMedia({ colorScheme: "light" });
	}
	return { findings, needsReview, notes };
}
