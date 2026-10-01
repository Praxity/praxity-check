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

test("each rendered state isolates storage while preserving it across navigation", async () => {
	const root = await mkdtemp(join(tmpdir(), "praxity-check-state-storage-"));
	try {
		await writeFile(
			join(root, "index.html"),
			`<!doctype html><html lang="en"><head><title>Resume</title></head><body><main><h1>Deck</h1>
			<p id="fresh" hidden>Fresh progress</p><p id="cache-fresh" hidden>Fresh cache</p>
			<button id="mark">Save progress</button><a id="next" href="next.html" hidden>Next page</a>
			<script>
				document.querySelector('#fresh').hidden = localStorage.getItem('progress') !== null;
				caches.keys().then(keys => { document.querySelector('#cache-fresh').hidden = keys.length !== 0; });
				// The initial scan keeps writing even after another page clears the origin.
				const background = setInterval(() => localStorage.setItem('progress', 'background'), 25);
				document.querySelector('#mark').onclick = async () => {
					clearInterval(background);
					localStorage.setItem('progress', 'saved');
					const cache = await caches.open('progress');
					await cache.put('/progress', new Response('saved'));
					document.querySelector('#next').hidden = false;
				};
			</script>
			</main></body></html>`,
		);
		await writeFile(
			join(root, "next.html"),
			`<!doctype html><html lang="en"><head><title>Next slide</title></head><body><main><h1>Next slide</h1>
			<p id="resumed" hidden>Progress and cache survived navigation</p>
			<script>
				caches.match('/progress').then(async response => {
					if (localStorage.getItem('progress') === 'saved' && await response?.text() === 'saved') {
						document.querySelector('#resumed').hidden = false;
					}
				});
			</script>
			</main></body></html>`,
		);
		const scenarioFile = join(root, "scenarios.json");
		await writeFile(scenarioFile, JSON.stringify({
			scenarios: [
				{
					id: "keeps-progress", page: "index.html", actions: [
						{ action: "waitFor", selector: "#fresh" },
						{ action: "click", selector: "#mark" },
						{ action: "click", selector: "#next" },
						{ action: "waitFor", selector: "#resumed" },
					],
				},
				{
					id: "starts-fresh", page: "index.html", actions: [
						{ action: "waitFor", selector: "#fresh" },
						{ action: "waitFor", selector: "#cache-fresh" },
					],
				},
			],
		}));
		const output = join(root, "report.json");
		await exec(process.execPath, [CLI, "check", root, "--scenarios", scenarioFile, "--json", output])
			.catch((error: { code?: number }) => {
				if (error.code !== 1) throw error;
			});
		const report = JSON.parse(await readFile(output, "utf8")) as {
			scenarios: Array<{ id: string }>;
			evaluations: Array<{ state: string; outcome: string }>;
		};
		assert.deepEqual(report.scenarios.map((scenario) => scenario.id), ["keeps-progress", "starts-fresh"]);
		for (const state of ["keeps-progress", "starts-fresh"]) {
			const evaluations = report.evaluations.filter((evaluation) => evaluation.state === state);
			assert.ok(evaluations.length > 0, `${state} was not scanned`);
			assert.ok(!evaluations.some((evaluation) => evaluation.outcome === "untested"), `${state} did not complete`);
		}
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
