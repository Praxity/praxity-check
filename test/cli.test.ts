import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url);

test("--help prints usage and exits successfully", async () => {
	const { stdout, stderr } = await exec(process.execPath, [CLI.pathname, "--help"]);
	assert.match(stdout, /^Usage:\n  prax-audit check <folder\|zip>/);
	assert.match(stdout, /prax-audit prepare-tier-b <folder\|zip>/);
	assert.equal(stderr, "");
});
