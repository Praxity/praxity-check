import assert from "node:assert/strict";
import { test } from "node:test";
import { requireNode } from "../src/node-runtime.ts";

test("Node minimum includes the boundary and newer major versions", () => {
	for (const version of ["v22.18.0", "v22.18.1", "v22.19.0", "v24.0.0"]) {
		assert.doesNotThrow(() => requireNode(version, ">=22.18"));
	}
	for (const version of ["v20.19.0", "v22.17.99", "invalid", "v22.18.0-pre"]) {
		assert.throws(() => requireNode(version, ">=22.18"), { message: `Check requires Node >=22.18 (even major versions only); received ${version}` });
	}
});

test("Node requirements fail loudly when unsupported and preserve patch boundaries", () => {
	assert.throws(() => requireNode("v24.0.0", "^22"), /Unsupported Node requirement/);
	assert.throws(() => requireNode("v22.18.0", ">=22.18.1"), /Check requires Node >=22.18.1/);
	assert.doesNotThrow(() => requireNode("v22.18.1", ">=22.18.1"));
});


test("distribution Node range accepts Node 24 and 26 LTS releases and rejects odd majors", () => {
	const range = ">=24.22.1 <27";
	for (const version of ["v24.22.1", "24.22.2", "v24.23.0", "v26.1.0"]) assert.doesNotThrow(() => requireNode(version, range));
	for (const version of ["v22.18.0", "v24.22.0", "v25.0.0", "v27.0.0", "v24.22.1-pre", "invalid"]) {
		assert.throws(() => requireNode(version, range), { message: `Check requires Node 24 (24.22.1 or later) or Node 26; received ${version}` });
	}
});
