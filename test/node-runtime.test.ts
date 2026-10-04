import assert from "node:assert/strict";
import { test } from "node:test";
import { requireNode } from "../src/node-runtime.ts";

test("Node minimum includes the boundary and newer major versions", () => {
	for (const version of ["v22.18.0", "v22.18.1", "v22.19.0", "v24.0.0"]) {
		assert.doesNotThrow(() => requireNode(version, ">=22.18"));
	}
	for (const version of ["v20.19.0", "v22.17.99", "invalid", "v22.18.0-pre"]) {
		assert.throws(() => requireNode(version, ">=22.18"), { message: `Check requires Node >=22.18; received ${version}` });
	}
});

test("Node requirements fail loudly when unsupported and preserve patch boundaries", () => {
	assert.throws(() => requireNode("v24.0.0", "^22"), /Unsupported Node requirement/);
	assert.throws(() => requireNode("v22.18.0", ">=22.18.1"), /Check requires Node >=22.18.1/);
	assert.doesNotThrow(() => requireNode("v22.18.1", ">=22.18.1"));
});
