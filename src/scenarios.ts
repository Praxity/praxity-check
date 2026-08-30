import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";

const MAX_SCENARIOS = 50;
const MAX_ACTIONS = 20;
const MAX_TEXT = 500;
const SAFE_KEYS = new Set([
	"Enter",
	"Space",
	"Escape",
	"Tab",
	"Shift+Tab",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

export type ScenarioAction =
	| { action: "click"; selector: string }
	| { action: "press"; selector: string; key: string }
	| { action: "select"; selector: string; value: string }
	| { action: "waitFor"; selector: string };

export interface Scenario {
	id: string;
	page: string;
	actions: ScenarioAction[];
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT) {
		throw new Error(`${label} must be between 1 and ${MAX_TEXT} characters`);
	}
	return value;
}

function parseAction(value: unknown, label: string): ScenarioAction {
	const item = record(value, label);
	const action = text(item.action, `${label}.action`);
	const selector = text(item.selector, `${label}.selector`);
	if (action === "click" || action === "waitFor") return { action, selector };
	if (action === "select") return { action, selector, value: text(item.value, `${label}.value`) };
	if (action === "press") {
		const key = text(item.key, `${label}.key`);
		if (!SAFE_KEYS.has(key)) throw new Error(`${label}.key is not an allowed navigation key`);
		return { action, selector, key };
	}
	throw new Error(`${label}.action must be click, press, select, or waitFor`);
}

export function parseScenarios(value: unknown): Scenario[] {
	const document = record(value, "scenario file");
	if (!Array.isArray(document.scenarios) || document.scenarios.length > MAX_SCENARIOS) {
		throw new Error(`scenario file must contain at most ${MAX_SCENARIOS} scenarios`);
	}
	const identities = new Set<string>();
	return document.scenarios.map((value, index) => {
		const label = `scenarios[${index}]`;
		const item = record(value, label);
		const id = text(item.id, `${label}.id`);
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
			throw new Error(`${label}.id must use lowercase letters, numbers, hyphens, or underscores`);
		}
		if (id === "initial" || id === "dark") throw new Error(`${label}.id ${JSON.stringify(id)} is reserved`);
		const page = text(item.page, `${label}.page`);
		if (page.startsWith("/") || page.includes("\\") || page.split("/").includes("..")) {
			throw new Error(`${label}.page must be a relative package path`);
		}
		if (!Array.isArray(item.actions) || item.actions.length === 0 || item.actions.length > MAX_ACTIONS) {
			throw new Error(`${label}.actions must contain between 1 and ${MAX_ACTIONS} actions`);
		}
		const identity = `${page}\0${id}`;
		if (identities.has(identity)) throw new Error(`${label} duplicates state ${JSON.stringify(id)} on ${page}`);
		identities.add(identity);
		return { id, page, actions: item.actions.map((action, actionIndex) => parseAction(action, `${label}.actions[${actionIndex}]`)) };
	});
}

export async function loadScenarios(path: string): Promise<Scenario[]> {
	const file = resolve(path);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(file, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`could not read scenario file ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseScenarios(value);
}

export async function runScenarioActions(page: Page, scenario: Scenario): Promise<void> {
	for (const action of scenario.actions) {
		const target = page.locator(action.selector);
		if (action.action === "click") await target.click();
		else if (action.action === "press") await target.press(action.key);
		else if (action.action === "select") await target.selectOption(action.value);
		else await target.waitFor({ state: "visible" });
	}
}
