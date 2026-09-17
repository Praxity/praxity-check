import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url);

test("--help prints usage and exits successfully", async () => {
	const { stdout, stderr } = await exec(process.execPath, [CLI.pathname, "--help"]);
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
		exec(process.execPath, [CLI.pathname, "screen-reader", "."]),
		(error: unknown) => {
			assert.ok(error && typeof error === "object" && "stderr" in error);
			assert.match(String(error.stderr), /launches VoiceOver, opens Safari, moves focus, and sends keyboard input/);
			return true;
		},
	);
});

test("screen-reader warns about the existing Safari profile and network", async () => {
	await assert.rejects(
		exec(process.execPath, [CLI.pathname, "screen-reader", ".", "--take-screen-control"]),
		(error: unknown) => {
			assert.ok(error && typeof error === "object" && "stderr" in error);
			assert.match(String(error.stderr), /existing Safari profile and network connection/);
			return true;
		},
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
		await exec(process.execPath, [CLI.pathname, "check", root, "--scenarios", scenarioFile, "--json", output])
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
		await exec(process.execPath, [CLI.pathname, "check", input, "--json", output]).catch((error: { code?: number }) => { if (error.code !== 1) throw error; });
		const report = JSON.parse(await readFile(output, "utf8"));
		assert.equal(report.schemaVersion, 4);
		assert.equal(report.target.wasZip, input !== folder);
		assert.ok(report.pages.some((page: { file?: string; page?: string }) => JSON.stringify(page).includes("index.html")));
	}
});
