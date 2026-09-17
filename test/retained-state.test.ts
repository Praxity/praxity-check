import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRetainedState } from "../src/interaction-review.ts";

const element = (selector: string) => ({ selector, text: "Content", visible: false, attributes: { hidden: "" }, properties: {} });
const snapshot = (elements: unknown[], active = "button#open") => JSON.stringify({ active, elements });

test("retained comparison reports fields and focus without deciding task outcome", () => {
	const guide = { ...element("section#requested"), context: "nearby DOM; relationship unverified" };
	const bulletin = { ...element("aside#other"), context: guide.context };
	const input = { ...element("input#choice"), properties: { checked: false, value: "a" } };
	assert.deepEqual(summarizeRetainedState(snapshot([guide, bulletin, input]), snapshot([
		guide,
		{ ...bulletin, visible: true, text: "Updated", attributes: {} },
		{ ...input, properties: { checked: true, value: "b" } },
	], "input#choice")), [
		'Focus: "button#open" → "input#choice".',
		'"aside#other" [nearby DOM; relationship unverified] visible: false → true.',
		'"aside#other" [nearby DOM; relationship unverified] text: "Content" → "Updated".',
		'"aside#other" [nearby DOM; relationship unverified] attributes.hidden: "" → absent.',
		'"input#choice" properties.checked: false → true.',
		'"input#choice" properties.value: "a" → "b".',
	]);
	assert.deepEqual(summarizeRetainedState(snapshot([guide]), snapshot([guide])), ["No change in retained fields; this is not an accessibility or task-completion verdict."]);
	assert.match(summarizeRetainedState(snapshot([{ ...guide, attributes: { hidden: "", role: "region" } }]), snapshot([{ ...guide, attributes: { role: "region", hidden: "" } }]))[0]!, /^No change in retained fields/);
	assert.deepEqual(summarizeRetainedState(snapshot([element("a")]), snapshot([element("b")])), [
		'"a": absent from the after retained snapshot; DOM presence was not compared.',
		'"b": present only in the after retained snapshot; DOM presence was not compared.',
	]);
});

test("invalid, incomplete, duplicate and unknown snapshots cannot imply no change", () => {
	const valid = snapshot([element("button#open")]);
	const invalid = [
		valid.slice(0, -1) + "… [truncated]", "null", "[]", "{}",
		snapshot(["candidate detached"]), snapshot([element("a"), element("a")]),
		snapshot([{ ...element("a"), futureField: true }]),
		snapshot([{ ...element("a"), visible: "false" }]),
		snapshot([{ ...element("a"), properties: { value: {} } }]),
		snapshot([{ ...element("a"), attributes: null }]),
		JSON.stringify({ active: "a", elements: [], extra: true }),
		snapshot(Array.from({ length: 33 }, (_, index) => element(String(index)))),
		snapshot([{ ...element("a"), text: "x".repeat(6001) }]),
	];
	for (const unknown of invalid) {
		for (const pair of [[valid, unknown], [unknown, valid], [unknown, unknown]]) {
			assert.match(summarizeRetainedState(pair[0]!, pair[1]!).join(" "), /^Comparison unavailable:/);
		}
	}
});
