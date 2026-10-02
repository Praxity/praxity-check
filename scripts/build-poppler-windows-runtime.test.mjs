import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPopplerWindowsRuntime } from "./build-poppler-windows-runtime.mjs";
import { windowsPoppler } from "./poppler-inputs.mjs";

test("Windows build refuses an untrusted vcpkg download before saving or executing it", { skip: process.platform !== "win32" || process.arch !== "x64" }, async t => {
	const work = await mkdtemp(join(tmpdir(), "vcpkg verification "));
	t.after(() => rm(work, { recursive: true, force: true }));
	const registry = join(work, "vcpkg"), executable = join(registry, "vcpkg.exe");
	await mkdir(join(registry, "scripts"), { recursive: true });
	await writeFile(join(registry, "scripts/vcpkg-tools.json"), '{"tools":[]}');
	await writeFile(join(registry, "scripts/vcpkg-tool-metadata.txt"), "VCPKG_TOOL_RELEASE_TAG=2026-07-27\r\n");
	const untrusted = Buffer.from("untrusted vcpkg executable"), fetched = [], executed = [];
	// The subprocess adapter stops at install, so the build interface cannot launch a toolchain.
	t.mock.method(childProcess, "execFileSync", (file, args) => {
		if (file === "git" && args.includes("rev-parse")) return windowsPoppler.baseline;
		if (file === "git" && args.includes("status")) return "";
		if (args.some(arg => arg.includes("bootstrap-vcpkg.bat"))) {
			writeFileSync(executable, untrusted);
			return Buffer.alloc(0);
		}
		executed.push(file);
		throw new Error(`Unverified executable reached execution: ${file}`);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	t.mock.method(globalThis, "fetch", async url => { fetched.push(url); return new Response(untrusted); });
	await assert.rejects(buildPopplerWindowsRuntime({ work }), /SHA-256 mismatch/);
	assert.deepEqual(fetched, ["https://github.com/microsoft/vcpkg-tool/releases/download/2026-07-27/vcpkg.exe"]);
	assert.deepEqual(executed, []);
	await assert.rejects(access(executable), { code: "ENOENT" });
	await writeFile(executable, untrusted);
	fetched.length = 0;
	await assert.rejects(buildPopplerWindowsRuntime({ work }), /SHA-256 mismatch/);
	assert.deepEqual(fetched, []);
	assert.deepEqual(executed, []);
	assert.deepEqual(await readFile(executable), untrusted);
	await rm(executable);
	for (const metadata of ["VCPKG_TOOL_RELEASE_TAG=another-release\n", "VCPKG_MACOS_SHA=irrelevant\n"]) {
		await writeFile(join(registry, "scripts/vcpkg-tool-metadata.txt"), metadata);
		await assert.rejects(buildPopplerWindowsRuntime({ work }), /vcpkg tool release must match/);
		assert.deepEqual(fetched, []);
		assert.deepEqual(executed, []);
		await assert.rejects(access(executable), { code: "ENOENT" });
	}
});
