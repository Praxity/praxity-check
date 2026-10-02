import assert from "node:assert/strict";
import { access, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { browserRuntime, prepareRuntimes } from "./prepare-runtimes.mjs";
import { windowsJavaPins } from "./prepare-windows-java.mjs";
import { validateWindowsPayload } from "./windows-pe.mjs";
import { poppler, popplerData, popplerTools, windowsPoppler } from "./poppler-inputs.mjs";

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

test("Windows assembly requires complete PDF sources and refuses existing or nested output", { skip: process.platform !== "win32" || process.arch !== "x64" }, async t => {
	const { root, cache, output } = await fixture(t);
	for (const key of ["poppler", "verapdf", "java"]) await assert.rejects(prepareRuntimes({ browsers: cache, output, [key]: root }), /requires --poppler, --verapdf and --java together/);
	for (const nested of [cache, join(cache, "nested output")]) await assert.rejects(prepareRuntimes({ browsers: cache, output: nested }), /outside source runtime directories/);
	const alias = join(root, "linked cache");
	await symlink(cache, alias, "junction");
	await assert.rejects(prepareRuntimes({ browsers: cache, output: join(alias, "nested output") }), /outside source runtime directories/);
	await mkdir(output);
	await writeFile(join(output, "retained.txt"), "existing artifact");
	await assert.rejects(prepareRuntimes({ browsers: cache, output }, { runCommand: browserVersion }), /EEXIST/);
	assert.equal(await readFile(join(output, "retained.txt"), "utf8"), "existing artifact");
});

function nativeBinary(machine = 0x8664) {
	const binary = Buffer.alloc(256);
	binary.write("MZ");
	binary.writeUInt32LE(64, 0x3c);
	binary.writeUInt32LE(0x4550, 64);
	binary.writeUInt16LE(machine, 68);
	binary.writeUInt16LE(112, 84);
	binary.writeUInt16LE(0x20b, 88);
	return binary;
}

async function pdfFixture(t) {
	const base = await fixture(t);
	const poppler = join(base.root, "poppler"), java = join(base.root, "java"), verapdf = join(base.root, "verapdf");
	for (const directory of [join(poppler, "bin"), join(poppler, "notices"), join(java, "bin"), join(java, "notices"), join(java, "legal/java.base"), join(verapdf, "bin"), join(verapdf, "notices")]) await mkdir(directory, { recursive: true });
	for (const tool of ["pdfinfo", "pdffonts", "pdfimages", "pdftotext", "pdftohtml", "pdftoppm"]) await writeFile(join(poppler, "bin", `${tool}.exe`), nativeBinary());
	await writeFile(join(poppler, "NOTICE.md"), "Synthetic Poppler licenses\n");
	await writeFile(join(poppler, "notices/provenance.json"), JSON.stringify({ platform: "win32", arch: "x64", build: { poppler: { version: "26.03.0" } } }));
	await writeFile(join(java, "bin/java.exe"), nativeBinary());
	await writeFile(join(java, "release"), `OS_ARCH="x86_64"\nOS_NAME="Windows"\nIMPLEMENTOR="Eclipse Adoptium"\nIMAGE_TYPE="JRE"\nJAVA_RUNTIME_VERSION="${windowsJavaPins.java.version}"\n`);
	for (const file of ["legal/java.base/LICENSE", "legal/java.base/ASSEMBLY_EXCEPTION", "NOTICE"]) await writeFile(join(java, file), "Synthetic Java legal text\n");
	for (const file of ["LICENSE.GPL", "LICENSE.MPL"]) await writeFile(join(verapdf, file), "Synthetic veraPDF legal text\n");
	await writeFile(join(verapdf, "bin", `cli-${windowsJavaPins.veraPDF.version}.jar`), "Synthetic CLI jar");
	for (const [directory, pin] of [[java, windowsJavaPins.java], [verapdf, windowsJavaPins.veraPDF]]) await writeFile(join(directory, "notices/provenance.json"), JSON.stringify({ ...pin, platform: "win32", arch: "x64" }));
	return { ...base, poppler, java, verapdf, values: { browsers: base.cache, output: base.output, poppler, java, verapdf } };
}

function pdfVersions(file, args) {
	if (file.endsWith("java.exe")) return args.includes("org.verapdf.apps.GreenfieldCliWrapper") ? "veraPDF 1.30.2\nSynthetic build" : "openjdk 17.0.20.1\nTemurin-17.0.20.1+1";
	if (file.endsWith("chrome-headless-shell.exe")) return browserVersion();
	return "Synthetic Poppler version 26.03.0";
}

// The synthetic fixture exercises assembly and Java validation. Production Poppler
// validation checks the real source and legal bundle and is tested at its own interface.
async function syntheticPoppler(directory, options) {
	assert.deepEqual(options, { prepared: true });
	await validateWindowsPayload(directory, { executables: popplerTools.map(name => `bin/${name}.exe`) });
	return { provenance: { poppler: { version: "26.03.0" } } };
}

test("Windows full assembly copies PDF payloads, licenses and provenance without a batch launcher", { skip: process.platform !== "win32" || process.arch !== "x64" }, async t => {
	const { values, output } = await pdfFixture(t);
	const commands = [];
	await prepareRuntimes(values, { validatePoppler: syntheticPoppler, runCommand: (file, args, options) => { commands.push({ file, args, options }); return pdfVersions(file, args); } });
	for (const file of ["bin/pdfinfo.exe", "java/bin/java.exe", "java/legal/java.base/LICENSE", "java/notices/provenance.json", "verapdf/LICENSE.MPL", "verapdf/notices/provenance.json", "verapdf/bin/cli-1.30.2.jar"]) await access(join(output, file));
	await assert.rejects(access(join(output, "bin/verapdf.cmd")), /ENOENT/);
	const versions = JSON.parse(await readFile(join(output, "runtime-versions.json"), "utf8"));
	assert.equal(versions.poppler, "26.03.0");
	assert.match(versions.java, /Temurin-17.0.20.1\+1/);
	assert.match(versions.veraPDF, /^veraPDF 1.30.2/);
	const verifier = commands.find(command => command.args.includes("org.verapdf.apps.GreenfieldCliWrapper"));
	assert.equal(verifier.file.endsWith("java.exe"), true);
	assert.equal(verifier.args.includes("--version"), true);
	assert.equal(verifier.options.env.JAVA_TOOL_OPTIONS, undefined);
	assert.match(await readFile(join(output, "NOTICE.md"), "utf8"), /java\/legal.*java\/NOTICE/s);
});

test("Windows PDF assembly rejects wrong target, missing legal files, provenance and binary versions before writing output", { skip: process.platform !== "win32" || process.arch !== "x64" }, async t => {
	const { values, output, java, verapdf, poppler } = await pdfFixture(t);
	const rejectsMutation = async (path, content, pattern) => {
		const original = await readFile(path);
		await writeFile(path, content);
		await assert.rejects(prepareRuntimes(values, { validatePoppler: syntheticPoppler, runCommand: pdfVersions }), pattern);
		await assert.rejects(access(output), /ENOENT/);
		await writeFile(path, original);
	};
	await rejectsMutation(join(java, "release"), 'OS_ARCH="aarch64"\nOS_NAME="Windows"', /must target Windows x64/);
	await rejectsMutation(join(java, "legal/java.base/LICENSE"), "", /legal file is empty/);
	await rejectsMutation(join(verapdf, "LICENSE.MPL"), "", /legal file is empty/);
	await rejectsMutation(join(java, "notices/provenance.json"), "{}", /provenance does not match/);
	await rejectsMutation(join(java, "bin/java.exe"), nativeBinary(0xaa64), /Invalid Windows x64 PE/);
	await rejectsMutation(join(poppler, "bin/pdfinfo.exe"), nativeBinary(0x14c), /Invalid Windows x64 PE/);
	for (const mismatch of ["java", "verapdf", "poppler"]) {
		await assert.rejects(prepareRuntimes(values, { validatePoppler: syntheticPoppler, runCommand: (file, args) => {
			if (mismatch === "java" && file.endsWith("java.exe") && !args.includes("org.verapdf.apps.GreenfieldCliWrapper")) return "Temurin-17.0.20.1+11";
			if (mismatch === "verapdf" && args.includes("org.verapdf.apps.GreenfieldCliWrapper")) return "veraPDF 1.30.1";
			if (mismatch === "poppler" && file.endsWith("pdfinfo.exe")) return "pdfinfo version 26.03.00";
			return pdfVersions(file, args);
		} }), /binary version does not match/);
	}
});

test("Windows assembly uses the full Poppler validator and refuses missing encoding data before creating output", { skip: process.platform !== "win32" || process.arch !== "x64" }, async t => {
	const { values, output } = await pdfFixture(t);
	await mkdir(join(values.poppler, "notices/poppler"));
	await mkdir(join(values.poppler, "etc/fonts"), { recursive: true });
	await writeFile(join(values.poppler, "notices/provenance.json"), JSON.stringify({ platform: "win32", arch: "x64", build: { poppler, popplerData, vcpkg: { baseline: windowsPoppler.baseline, triplet: windowsPoppler.triplet } } }));
	for (const file of ["notices/poppler/COPYING", "notices/poppler/poppler-data-env.patch", "notices/poppler/build-poppler-windows-runtime.mjs", "etc/fonts/fonts.conf"]) await writeFile(join(values.poppler, file), "Synthetic required preceding file");
	await assert.rejects(prepareRuntimes(values, { runCommand: pdfVersions }), /UniJIS-UTF16-H/);
	await assert.rejects(access(output), /ENOENT/);
});
