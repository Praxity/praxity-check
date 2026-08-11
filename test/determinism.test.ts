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

/**
 * Determinism is the whole argument for this tool existing beside an agent
 * process that is broader and more variable. If two runs over one unchanged
 * target ever disagree, that argument is gone -- and it would go quietly,
 * because nobody diffs two runs by hand.
 *
 * Three runs, not two: an alternating instability would pass a pair.
 */

let root: string;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "prax-audit-determinism-"));
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

test("three runs over an unchanged target produce identical findings", async () => {
	const signatures: string[] = [];

	for (let attempt = 0; attempt < 3; attempt++) {
		const out = join(root, `run-${attempt}.json`);
		// Exit code 1 means findings were present, which this fixture guarantees.
		await run("node", [CLI, "check", root, "--json", out]).catch((error: { code?: number }) => {
			if (error.code !== 1) throw error;
		});
		const report = JSON.parse(await readFile(out, "utf-8")) as {
			findings: Array<{ rule: string; confidence: string; selector?: string; evidence: string }>;
		};
		signatures.push(
			report.findings
				.map((f) => `${f.rule}|${f.confidence}|${f.selector ?? ""}|${f.evidence}`)
				.sort()
				.join("\n"),
		);
	}

	assert.ok(signatures[0]!.length > 0, "fixture produced no findings, so this proves nothing");
	assert.equal(signatures[0], signatures[1], "run 1 and run 2 disagreed");
	assert.equal(signatures[1], signatures[2], "run 2 and run 3 disagreed");
});
