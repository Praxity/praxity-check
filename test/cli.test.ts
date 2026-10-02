import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs } from "../src/html-cli.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("--help prints usage and exits successfully", async () => {
	const { stdout, stderr } = await exec(process.execPath, [CLI, "--help"]);
	assert.match(stdout, /^Usage:\n  praxity-check check <folder\|zip\|pdf>/);
	assert.match(stdout, /--min-image-ppi <number>/);
	assert.match(stdout, /--paper-size A4\|Letter/);
	assert.match(stdout, /praxity-check prepare-review <folder\|zip>/);
	assert.match(stdout, /praxity-check screen-reader <folder\|zip>/);
	assert.match(stdout, /--baseline <report\.json>/);
	assert.equal(stderr, "");
});

test("screen-reader requires explicit permission before taking screen control", async () => {
	await assert.rejects(
		exec(process.execPath, [CLI, "screen-reader", "."]),
		(error: unknown) => {
			assert.ok(error && typeof error === "object" && "stderr" in error);
			assert.match(String(error.stderr), /launches VoiceOver, opens Safari, moves focus, and sends keyboard input/);
			return true;
		},
	);
});

test("screen-reader warns about the existing Safari profile and network", () => {
	assert.throws(
		() => parseArgs(["screen-reader", ".", "--take-screen-control"]),
		/existing Safari profile and network connection/,
	);
});

test("check scans a declared rendered state and records its actions", async () => {
	const root = await mkdtemp(join(tmpdir(), "praxity-check-scenario-"));
	try {
		await writeFile(
			join(root, "index.html"),
			`<!doctype html><html lang="en"><head><title>Scenario</title></head><body>
			<h1>Course</h1><button id="start" onclick="document.querySelector('main').hidden=false">Start</button>
			<main hidden><img src="lesson.png"></main></body></html>`,
		);
		const scenarioFile = join(root, "scenarios.json");
		await writeFile(scenarioFile, JSON.stringify({
			scenarios: [
				{
					id: "lesson-open",
					page: "index.html",
					actions: [
						{ action: "click", selector: "button#start" },
						{ action: "waitFor", selector: "main" },
					],
				},
				{
					id: "broken-state",
					page: "index.html",
					actions: [{ action: "click", selector: "[" }],
				},
			],
		}));
		const output = join(root, "report.json");
		await exec(process.execPath, [CLI, "check", root, "--scenarios", scenarioFile, "--json", output])
			.catch((error: { code?: number }) => {
				if (error.code !== 1) throw error;
			});
		const report = JSON.parse(await readFile(output, "utf8")) as {
			scenarios: Array<{ id: string; actions: unknown[] }>;
			findings: Array<{ rule: string; state: string }>;
			evaluations: Array<{ type: string; check?: string; state: string; outcome: string }>;
		};
		assert.equal(report.scenarios[0]?.id, "lesson-open");
		assert.equal(report.scenarios[0]?.actions.length, 2);
		assert.ok(report.findings.some((finding) =>
			finding.rule === "axe:image-alt" && finding.state === "lesson-open"
		));
		assert.ok(report.evaluations.some((evaluation) =>
			evaluation.type === "check" && evaluation.check === "scenario:broken-state" &&
			evaluation.state === "broken-state" && evaluation.outcome === "untested"
		));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("PDF-looking folder names and PDF-first ZIPs retain HTML coverage", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "praxity-dispatch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const folder = join(root, "course.pdf");
	await mkdir(folder);
	await writeFile(join(folder, "index.html"), '<!doctype html><html lang="en"><title>Folder</title><h1>Folder course</h1></html>');
	const archive = join(root, "course.zip");
	await copyFile(new URL("./fixtures/pdf-first.zip", import.meta.url), archive);
	const renamedArchive = join(root, "course.bin");
	await copyFile(archive, renamedArchive);
	for (const input of [folder, archive, renamedArchive]) {
		const output = join(root, "report.json");
		await exec(process.execPath, [CLI, "check", input, "--json", output]).catch((error: { code?: number }) => { if (error.code !== 1) throw error; });
		const report = JSON.parse(await readFile(output, "utf8"));
		assert.equal(report.schemaVersion, 4);
		assert.equal(report.target.wasZip, input !== folder);
		assert.ok(report.pages.some((page: { file?: string; page?: string }) => JSON.stringify(page).includes("index.html")));
	}
});

for (const expectedCode of [0, 1, 2]) {
	test(`check reports unaudited pages and states while retaining exit code ${expectedCode}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "praxity-check-partial-cli-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		await writeFile(join(root, "failed.html"), `<!doctype html><html lang="en"><title>Failed</title><body><main><h1>Failed page</h1>
		<script>Object.defineProperty(document.body, 'innerText', { get() { throw new Error('settling fixture failed'); } });</script>
		</main></body></html>`);
		const args = [CLI, "check", root, "--json", join(root, "report.json")];
		if (expectedCode !== 2) {
			await writeFile(join(root, "audited.html"), `<!doctype html><html lang="en"><title>Audited</title><body><main><h1>Audited page</h1>
			${expectedCode === 1 ? '<img src="missing.png">' : '<p>Readable course content.</p>'}</main></body></html>`);
			const scenarios = join(root, "scenarios.json");
			await writeFile(scenarios, JSON.stringify({ scenarios: [
				{ id: "broken-state", page: "audited.html", actions: [{ action: "click", selector: "[" }] },
			] }));
			args.push("--scenarios", scenarios);
		}
		const result = await exec(process.execPath, args).then(
			({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
			(error: { code: number; stdout: string; stderr: string }) => error,
		);
		assert.equal(result.code, expectedCode);
		assert.equal(result.stderr, "");
		assert.match(result.stdout, /Pages not checked: 1 page\./);
		assert.match(result.stdout, /failed\.html: settling failed: .*settling fixture failed/);
		if (expectedCode !== 2) {
			assert.match(result.stdout, /Checked 1 page\./);
			assert.match(result.stdout, /States not checked: 1 state\./);
			assert.match(result.stdout, /audited\.html, state broken-state: .*Unexpected token/);
		}
		const report = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
		assert.equal(report.pages.filter((page: { audited: boolean }) => page.audited).length, expectedCode === 2 ? 0 : 1);
		assert.ok(report.evaluations.some((evaluation: { check: string; outcome: string }) =>
			evaluation.check === "page-audit" && evaluation.outcome === "untested"));
	});
}
