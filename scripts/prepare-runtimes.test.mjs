import assert from "node:assert/strict";
import { access, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { browserRuntime, prepareRuntimes } from "./prepare-runtimes.mjs";

const require = createRequire(import.meta.url);
const core = createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json");
const metadata = JSON.parse(await readFile(join(dirname(core), "browsers.json"), "utf8")).browsers.find(item => item.name === "chromium-headless-shell");
const playwrightVersion = JSON.parse(await readFile(core, "utf8")).version;
const windows = { platform: "win32", arch: "x64" };
const mac = { platform: "darwin", arch: "arm64" };

function peExecutable(machine = 0x8664) {
	const binary = Buffer.alloc(128);
	binary.write("MZ");
	binary.writeUInt32LE(64, 0x3c);
	binary.writeUInt32LE(0x00004550, 64);
	binary.writeUInt16LE(machine, 68);
	return binary;
}

async function fixture(t, target = windows) {
	const root = await mkdtemp(join(tmpdir(), "check runtimes "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cache = join(root, "browser cache");
	const directory = `chromium_headless_shell-${metadata.revision}`;
	const runtimeName = target.platform === "win32" ? "chrome-headless-shell-win64" : "chrome-headless-shell-mac-arm64";
	const runtime = join(cache, directory, runtimeName);
	const executable = join(runtime, target.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
	await mkdir(runtime, { recursive: true });
	await writeFile(executable, target.platform === "win32" ? peExecutable() : "synthetic macOS executable");
	await writeFile(join(runtime, "LICENSE.headless_shell"), "Synthetic Chromium license\n");
	await writeFile(join(runtime, "ABOUT"), "Synthetic Chromium credits\n");
	return { root, cache, directory, runtimeName, runtime, executable, output: join(root, "assembled runtime") };
}

const browserVersion = () => `Chromium ${metadata.browserVersion}`;

for (const target of [windows, mac]) {
	test(`${target.platform} browser metadata requires the installed revision, license and credits`, async t => {
		const { cache, runtime } = await fixture(t, target);
		await rm(runtime, { recursive: true });
		await mkdir(join(cache, "chromium_headless_shell-stale"), { recursive: true });
		await assert.rejects(browserRuntime(cache, target), /ENOENT/);
		// Restore each required file separately to check the public validation contract.
		await mkdir(runtime, { recursive: true });
		const executable = target.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
		await writeFile(join(runtime, executable), target.platform === "win32" ? peExecutable() : "synthetic macOS executable");
		await assert.rejects(browserRuntime(cache, target), /LICENSE.headless_shell/);
		await writeFile(join(runtime, "LICENSE.headless_shell"), "Synthetic license");
		await assert.rejects(browserRuntime(cache, target), /ABOUT/);
		await writeFile(join(runtime, "ABOUT"), "Synthetic credits");
		const browser = await browserRuntime(cache, target);
		assert.equal(browser.revision, metadata.revision);
		assert.equal(browser.browserVersion, metadata.browserVersion);
		assert.equal(browser.directory, `chromium_headless_shell-${metadata.revision}`);
		assert.equal(browser.playwright, playwrightVersion);
	});
}

test("Windows browser validation rejects invalid or non-x64 PE binaries", async t => {
	const { cache, executable } = await fixture(t);
	for (const binary of [Buffer.from("synthetic invalid executable"), peExecutable(0x014c), peExecutable(0xaa64)]) {
		await writeFile(executable, binary);
		await assert.rejects(browserRuntime(cache, windows), /Windows x64 PE executable/);
	}
	await rm(executable);
	await mkdir(executable);
	await assert.rejects(browserRuntime(cache, windows), /regular file/);
});

test("browser metadata rejects unsupported targets", async () => {
	for (const target of [{ platform: "win32", arch: "arm64" }, { platform: "linux", arch: "x64" }, { platform: "darwin", arch: "x64" }]) {
		await assert.rejects(browserRuntime("unused cache", target), /supports macOS arm64 and Windows x64 only/);
	}
});

test("assembly requires explicit sources and rejects a target that differs from its host", async () => {
	await assert.rejects(prepareRuntimes({}), process.platform === "win32" ? /Required: --browsers/ : /Required: --poppler|supports macOS arm64 and Windows x64 only/);
	const target = process.platform === "win32" ? mac : windows;
	await assert.rejects(prepareRuntimes(target), /does not match assembly host/);
	await assert.rejects(prepareRuntimes({ platform: "win32", arch: "arm64" }), /supports macOS arm64 and Windows x64 only/);
});

test("Windows assembly copies browser files and notices, excludes cache files, and records the target", { skip: process.platform !== "win32" || process.arch !== "x64" }, async t => {
	const { cache, runtime, executable, output, directory, runtimeName } = await fixture(t);
	await mkdir(join(runtime, "resources"));
	await mkdir(join(runtime, ".links"));
	await writeFile(join(runtime, "icudtl.dat"), "synthetic browser data");
	await writeFile(join(runtime, "resources", "credits.html"), "synthetic dependency credits");
	await writeFile(join(runtime, "resources", "source.js.map"), "synthetic source map");
	await writeFile(join(runtime, "debug.log"), "synthetic log");
	await writeFile(join(runtime, ".links", "private-path"), cache);
	await writeFile(join(cache, directory, "INSTALLATION_COMPLETE"), cache);
	await mkdir(join(cache, "chromium-stale"));
	await writeFile(join(cache, "chromium-stale", "ignored"), "unused runtime");
	// Copying a directory link must leave regular files in the assembled runtime.
	await symlink(join(runtime, "resources"), join(runtime, "linked resources"), "junction");
	const commands = [];
	assert.equal(await prepareRuntimes({ ...windows, browsers: cache, output }, {
		runCommand: (file, args) => { commands.push({ file, args }); return browserVersion(); },
	}), output);
	assert.deepEqual(commands, [{ file: executable, args: ["--version"] }]);
	assert.deepEqual((await readdir(output)).sort(), ["NOTICE.md", "browsers", "runtime-versions.json"]);
	assert.deepEqual(await readdir(join(output, "browsers")), [directory]);
	assert.deepEqual(await readdir(join(output, "browsers", directory)), [runtimeName]);
	const assembled = join(output, "browsers", directory, runtimeName);
	assert.equal(await readFile(join(assembled, "LICENSE.headless_shell"), "utf8"), "Synthetic Chromium license\n");
	assert.equal(await readFile(join(assembled, "ABOUT"), "utf8"), "Synthetic Chromium credits\n");
	assert.equal(await readFile(join(assembled, "icudtl.dat"), "utf8"), "synthetic browser data");
	assert.equal(await readFile(join(assembled, "linked resources", "credits.html"), "utf8"), "synthetic dependency credits");
	assert.equal((await lstat(join(assembled, "linked resources"))).isSymbolicLink(), false);
	assert.equal((await lstat(join(assembled, "chrome-headless-shell.exe"))).isFile(), true);
	for (const excluded of ["debug.log", ".links", "resources/source.js.map", "linked resources/source.js.map"]) await assert.rejects(access(join(assembled, excluded)), /ENOENT/);
	const versions = JSON.parse(await readFile(join(output, "runtime-versions.json"), "utf8"));
	assert.equal(versions.platform, "win32");
	assert.equal(versions.arch, "x64");
	assert.equal(versions.browser.revision, metadata.revision);
	assert.equal(versions.browser.playwright, playwrightVersion);
	assert.equal(versions.java, undefined);
	assert.equal(versions.veraPDF, undefined);
	const notice = await readFile(join(output, "NOTICE.md"), "utf8");
	assert.ok(notice.includes(`browsers/${directory}/chrome-headless-shell-win64/LICENSE.headless_shell and ABOUT`));
	assert.ok(notice.includes(`Chromium headless shell ${metadata.browserVersion}`));
	assert.equal(notice.includes(cache), false);
	assert.doesNotMatch(notice, /Java|veraPDF|Poppler/);
});

test("Windows assembly rejects binary-version mismatches before creating output", { skip: process.platform !== "win32" || process.arch !== "x64" }, async t => {
	const { cache, output } = await fixture(t);
	for (const version of ["Chromium 0.0.0.0", `Chromium 1${metadata.browserVersion}`]) await assert.rejects(prepareRuntimes({ browsers: cache, output }, { runCommand: () => version }), /version does not match Playwright metadata/);
	await assert.rejects(access(output), /ENOENT/);
});

test("Windows assembly excludes PDF sources and refuses existing or nested output", { skip: process.platform !== "win32" || process.arch !== "x64" }, async t => {
	const { root, cache, output } = await fixture(t);
	for (const key of ["poppler", "verapdf", "java"]) await assert.rejects(prepareRuntimes({ browsers: cache, output, [key]: root }), /accepts browsers only/);
	for (const nested of [cache, join(cache, "nested output")]) await assert.rejects(prepareRuntimes({ browsers: cache, output: nested }), /outside source runtime directories/);
	const alias = join(root, "linked cache");
	await symlink(cache, alias, "junction");
	await assert.rejects(prepareRuntimes({ browsers: cache, output: join(alias, "nested output") }), /outside source runtime directories/);
	await mkdir(output);
	await writeFile(join(output, "retained.txt"), "existing artifact");
	await assert.rejects(prepareRuntimes({ browsers: cache, output }, { runCommand: browserVersion }), /EEXIST/);
	assert.equal(await readFile(join(output, "retained.txt"), "utf8"), "existing artifact");
});
