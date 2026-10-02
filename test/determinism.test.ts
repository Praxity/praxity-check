import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const run = promisify(execFile);
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "cli.ts");

// The module tests audit determinism; these runs also cover report serialization,
// terminal output and exit codes. Three runs catch an alternating instability.

let root: string;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "praxity-check-determinism-"));
	await writeFile(
		join(root, "index.html"),
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Determinism</title>
<style>
	.faint { color: #d1d5dc; background: #fff; }
	#no-ring:focus { outline: none; box-shadow: none; }
	#narrow { width: 900px; }
</style></head><body>
<h1>Determinism fixture</h1>
<p class="faint">Low contrast text that should be reported every run.</p>
<div id="narrow">Content too wide to reflow at 320px.</div>
<button id="no-ring">No focus ring</button>
<button id="ok">Has the default ring</button>
<img src="a.png" alt="IMG_4021.jpg">
<p>Read the guide, <a href="/a">click here</a>.</p>
</body></html>`,
	);
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

test("three CLI runs serialize identical reports and preserve output and exit codes", async () => {
	const results: Array<{ report: string; stdout: string; stderr: string }> = [];

	for (let attempt = 0; attempt < 3; attempt++) {
		const out = join(root, "report.json");
		// Exit code 1 means findings were present, which this fixture guarantees.
		let terminal: { stdout: string; stderr: string } | undefined;
		await assert.rejects(run(process.execPath, [CLI, "check", root, "--json", out]), (error: unknown) => {
			assert.ok(error && typeof error === "object" && "code" in error && "stdout" in error && "stderr" in error);
			assert.equal(error.code, 1);
			terminal = { stdout: String(error.stdout), stderr: String(error.stderr) };
			return true;
		});
		const serialized = await readFile(out, "utf-8");
		assert.ok(JSON.parse(serialized).findings.length > 0, "fixture produced no findings");
		assert.ok(terminal);
		assert.equal(terminal.stderr, "");
		// Each CLI run starts a server on a new ephemeral port.
		results.push({ report: serialized.replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:<port>"), ...terminal });
	}

	assert.deepEqual(results[0], results[1], "run 1 and run 2 disagreed");
	assert.deepEqual(results[1], results[2], "run 2 and run 3 disagreed");
});
