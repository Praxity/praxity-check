import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseArgs } from "../src/html-cli.ts";
import { runScreenReaderJourney, type ScreenReaderJourneyDependencies } from "../src/screen-reader.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const journey = { version: 1, name: "Read lesson", start: "index.html", steps: [{ id: "read", intent: "Read heading", keys: ["h"], expect: { spoken: ["Lesson"] } }] };
const flags = ["--journey", "journey.json", "--output", "evidence", "--take-screen-control"];
const options = { target: "https://example.com/course/", journey, output: "evidence", takeScreenControl: true, allowNetwork: true };
const unavailable: ScreenReaderJourneyDependencies = {
	platform: () => "linux",
	runNvdaJourney: async () => { throw new Error("must not take screen control"); },
};

test("NVDA journey arguments preserve remote URLs and allow local network isolation", () => {
	const remote = parseArgs(["screen-reader", options.target, ...flags, "--allow-network"]);
	assert.equal(remote.target, "https://example.com/course/");
	assert.equal(remote.command, "screen-reader");
	if (remote.command !== "screen-reader") assert.fail("wrong command");
	assert.equal(remote.journeyFile, resolve("journey.json"));
	assert.equal(remote.output, resolve("evidence"));
	const local = parseArgs(["screen-reader", ".", ...flags]);
	assert.equal(local.allowNetwork, false);
});

test("NVDA journey options require consent, output, and remote network permission", () => {
	assert.throws(() => parseArgs(["screen-reader", ".", "--journey", "journey.json", "--output", "evidence"]), /--take-screen-control/);
	assert.throws(() => parseArgs(["screen-reader", ".", "--journey", "journey.json", "--take-screen-control"]), /requires --output/);
	assert.throws(() => parseArgs(["screen-reader", options.target, ...flags]), /requires --allow-network/);
	assert.throws(() => parseArgs(["screen-reader", "ftp://example.com/course/", ...flags, "--allow-network"]), /HTTP or HTTPS/);
	assert.throws(() => parseArgs(["screen-reader", ".", ...flags, "--page", "index.html"]), /cannot be combined/);
	assert.throws(() => parseArgs(["screen-reader", ".", ...flags, "--control", "Next"]), /cannot be combined/);
	assert.throws(() => parseArgs(["screen-reader", ".", ...flags, "--expected", "Next"]), /cannot be combined/);
	assert.throws(() => parseArgs(["screen-reader", ".", "--journey", "--output", "evidence", "--take-screen-control"]), /incomplete option/);
	assert.throws(() => parseArgs(["screen-reader", ".", "--take-screen-control", "--allow-network", "--output", "evidence"]), /requires --journey/);
});

test("existing VoiceOver invocation keeps its argument contract", () => {
	const parsed = parseArgs(["screen-reader", ".", "--page", "index.html", "--control", "Next", "--expected", "Lesson", "--take-screen-control", "--allow-network"]);
	assert.equal(parsed.command, "screen-reader");
	if (parsed.command !== "screen-reader") assert.fail("wrong command");
	assert.equal(parsed.page, "index.html");
	assert.equal(parsed.control, "Next");
	assert.equal(parsed.expected, "Lesson");
});

test("journey public API validates consent, schema, and supported platform before desktop work", async () => {
	await assert.rejects(runScreenReaderJourney({ ...options, takeScreenControl: false }, unavailable), /--take-screen-control/);
	await assert.rejects(runScreenReaderJourney({ ...options, output: "" }, unavailable), /requires --output/);
	await assert.rejects(runScreenReaderJourney({ ...options, allowNetwork: false }, unavailable), /requires --allow-network/);
	await assert.rejects(runScreenReaderJourney({ ...options, journey: { ...journey, version: 2 } }, unavailable), /version must be 1/);
	await assert.rejects(runScreenReaderJourney(options, unavailable), /require Windows and NVDA/);
});

test("remote journey preserves target directory, output paths, and every exit status", async () => {
	for (const exitCode of [0, 1, 2] as const) {
		const expected = { exitCode, jsonPath: resolve("evidence/transcript.json"), markdownPath: resolve("evidence/transcript.md") };
		const result = await runScreenReaderJourney(options, {
			platform: () => "win32",
			runNvdaJourney: async (target, effective, output, allowNetwork) => {
				assert.equal(target, "https://example.com/course/index.html");
				assert.equal(effective.start, target);
				assert.equal(output, resolve("evidence"));
				assert.equal(allowNetwork, true);
				assert.equal(effective.steps[0]?.waitMs, 1500);
				return expected;
			},
		});
		assert.deepEqual(result, expected);
	}
	await assert.rejects(runScreenReaderJourney({ ...options, journey: { ...journey, start: "https://other.example/index.html" } }, {
		...unavailable, platform: () => "win32",
	}), /inside the target origin/);
});

test("local journey serves the requested file and closes its server after runner failure", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "praxity-journey-cli-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "index.html"), "<h1>Lesson</h1>");
	let target = "";
	await assert.rejects(runScreenReaderJourney({ ...options, target: root, output: `${root}-evidence`, allowNetwork: false }, {
		platform: () => "win32",
		runNvdaJourney: async (url, effective, output, allowNetwork) => {
			target = url;
			assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
			assert.equal(effective.start, url);
			assert.equal(await (await fetch(url)).text(), "<h1>Lesson</h1>");
			assert.equal(output, `${root}-evidence`);
			assert.equal(allowNetwork, false);
			throw new Error("adapter failed");
		},
	}), /adapter failed/);
	await assert.rejects(fetch(target));
	assert.equal(await readFile(join(root, "index.html"), "utf8"), "<h1>Lesson</h1>");
	const stub = { ...unavailable, platform: () => "win32" };
	await assert.rejects(runScreenReaderJourney({ ...options, target: root, output: join(root, "evidence") }, stub), /outside the input/);
	await assert.rejects(runScreenReaderJourney({ ...options, target: root, output: `${root}-evidence`, journey: { ...journey, start: "missing.html" } }, stub), /did not match an HTML file/);
	await assert.rejects(runScreenReaderJourney({ ...options, target: root, output: `${root}-evidence`, journey: { ...journey, start: "https://example.com/index.html" } }, stub), /inside the target origin/);
});

test("journey CLI input failures return exit 2 without taking screen control", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "praxity-journey-errors-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "journey.json");
	await writeFile(file, "{");
	for (const journeyFile of [file, join(root, "missing.json")]) {
		await assert.rejects(exec(process.execPath, [CLI, "screen-reader", root, "--journey", journeyFile, "--output", `${root}-evidence`, "--take-screen-control"]), (error: unknown) => {
			assert.ok(error && typeof error === "object" && "code" in error && "stderr" in error);
			assert.equal(error.code, 2);
			assert.match(String(error.stderr), /praxity-check:/);
			return true;
		});
	}
});

test("ZIP journey serves its extracted HTML and closes the temporary server on success", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "praxity-journey-zip-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let target = "";
	const expected = { exitCode: 0 as const, jsonPath: join(root, "evidence", "journey.json"), markdownPath: join(root, "evidence", "transcript.md") };
	const result = await runScreenReaderJourney({ ...options, target: fileURLToPath(new URL("./fixtures/pdf-first.zip", import.meta.url)), output: join(root, "evidence"), journey: { ...journey, start: "/" }, allowNetwork: false }, {
		platform: () => "win32",
		runNvdaJourney: async (url) => {
			target = url;
			assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
			const response = await fetch(url);
			assert.equal(response.status, 200);
			assert.match(response.headers.get("content-type")!, /text\/html/);
			return expected;
		},
	});
	assert.deepEqual(result, expected);
	await assert.rejects(fetch(target));
});
