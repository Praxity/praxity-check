import { access, cp, mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { browserDefinition, browserTarget } from "../src/components.ts";
import { javaEnvironment } from "../src/verapdf-runtime.ts";
import { validateWindowsJava, windowsJavaPins } from "./prepare-windows-java.mjs";

const run = (file, args, options = {}) => {
	if (process.platform !== "win32") return execFileSync(file, args, { encoding: "utf8", ...options }).trim();
	const result = spawnSync(file, args, { encoding: "utf8", timeout: 120_000, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${file} exited ${result.status}: ${result.stderr}`);
	return (result.stdout + result.stderr).trim();
};

async function windowsExecutable(path) {
	const executable = await open(path, "r");
	try {
		const dos = Buffer.alloc(64);
		const header = Buffer.alloc(6);
		const dosRead = await executable.read(dos, 0, dos.length, 0);
		if (dosRead.bytesRead !== dos.length || dos.toString("ascii", 0, 2) !== "MZ") throw new Error("Browser must be a Windows x64 PE executable");
		const peRead = await executable.read(header, 0, header.length, dos.readUInt32LE(0x3c));
		if (peRead.bytesRead !== header.length || header.readUInt32LE(0) !== 0x00004550 || header.readUInt16LE(4) !== 0x8664) throw new Error("Browser must be a Windows x64 PE executable");
	} finally {
		await executable.close();
	}
}

export async function browserRuntime(cache, { platform = process.platform, arch = process.arch } = {}) {
	const target = browserTarget(platform, arch);
	const browser = await browserDefinition();
	const directory = browser.directory;
	const runtime = join(cache, directory, target.directory);
	const executable = join(runtime, target.executable);
	if (!(await stat(executable)).isFile()) throw new Error(`Browser executable must be a regular file: ${executable}`);
	await readFile(join(runtime, "LICENSE.headless_shell"));
	await readFile(join(runtime, "ABOUT"));
	if (platform === "win32") await windowsExecutable(executable);
	return browser;
}

function within(path, directory) {
	const child = relative(directory, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

async function copyRuntime(source, destination, { exclude = [] } = {}) {
	await cp(source, destination, {
		recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE,
		filter: async path => {
			const parts = relative(source, path).split(/[\\/]/);
			if (parts.some(part => exclude.includes(part) || part === ".links" || /\.(map|log)$/i.test(part))) return false;
			const entry = await stat(path);
			if (!entry.isFile() && !entry.isDirectory()) throw new Error(`Runtime source must contain regular files and directories: ${path}`);
			return true;
		},
	});
}

async function files(directory) {
	const result = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await files(path));
		else result.push(path);
	}
	return result;
}

async function relocateJava(java, source, output, supplementalNotices) {
	const binaries = [];
	const external = new Set();
	for (const path of await files(java)) {
		if (!/Mach-O/.test(run("/usr/bin/file", ["-b", path]))) continue;
		if (!run("/usr/bin/lipo", ["-archs", path]).split(/\s+/).includes("arm64")) throw new Error(`Java binary lacks arm64: ${path}`);
		const loadCommands = run("/usr/bin/otool", ["-l", path]);
		for (const match of loadCommands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset/g)) {
			if (!match[1].startsWith("@loader_path") && !match[1].startsWith("@executable_path")) throw new Error(`Java has a non-relocatable search path: ${match[1]}`);
		}
		const dependencies = run("/usr/bin/otool", ["-L", path]).split("\n").slice(1).map(line => line.trim().split(" (compatibility")[0]);
		const id = run("/usr/bin/otool", ["-D", path]).split("\n")[1]?.trim();
		const loads = dependencies.filter(item => item !== id);
		for (const dependency of loads) {
			if (!dependency.startsWith("/") || dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/")) continue;
			const actual = await realpath(dependency);
			if (!actual.startsWith(source + "/")) external.add(dependency);
		}
		binaries.push({ path, loads, id });
	}
	let libraries = new Map();
	if (external.size) {
		const { prepareHomebrewRuntime } = await import("./prepare-homebrew-libraries.mjs");
		libraries = await prepareHomebrewRuntime({ roots: [...external], output: join(output, "java-external"), prefix: "/opt/homebrew", executables: false, supplementalNotices });
	}
	for (const { path, loads, id } of binaries) {
		const changes = [];
		for (const dependency of loads) {
			if (!dependency.startsWith("/") || dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/")) continue;
			const actual = await realpath(dependency);
			const library = libraries.get(dependency) ?? libraries.get(actual);
			const target = actual.startsWith(source + "/") ? join(java, relative(source, actual)) : library && join(output, "java-external", library);
			if (!target) throw new Error(`Unresolved Java dependency: ${dependency}`);
			changes.push("-change", dependency, `@loader_path/${relative(dirname(path), target)}`);
		}
		if (id?.startsWith("/")) changes.push("-id", `@loader_path/${path.split("/").at(-1)}`);
		if (changes.length) {
			run("/usr/bin/install_name_tool", [...changes, path]);
			run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
		}
	}
}

export async function prepareRuntimes(values, { runCommand = run } = {}) {
	const platform = values.platform ?? process.platform;
	const arch = values.arch ?? process.arch;
	const target = browserTarget(platform, arch);
	if (platform !== process.platform || arch !== process.arch) throw new Error(`Runtime target ${platform} ${arch} does not match assembly host ${process.platform} ${process.arch}`);
	const fullWindows = platform === "win32" && ["verapdf", "java"].some(key => values[key]);
	if (fullWindows && ["verapdf", "java"].some(key => !values[key])) throw new Error("Windows PDF runtime assembly requires --verapdf and --java together");
	const sourceKeys = platform === "win32" && !fullWindows ? ["browsers"] : ["verapdf", "java", "browsers"];
	for (const key of [...sourceKeys, "output"]) if (!values[key]) throw new Error(`Required: --${key} <directory>`);
	const output = resolve(values.output);
	const sources = Object.fromEntries(await Promise.all(sourceKeys.map(async key => [key, await realpath(values[key])])));
	const outputParent = await realpath(dirname(output));
	const actualOutput = join(outputParent, relative(dirname(output), output));
	for (const source of Object.values(sources)) if (within(actualOutput, source)) throw new Error("Output must be outside source runtime directories");
	let release, windowsVersions;
	if (fullWindows) {
		for (const [key, pin] of [["java", windowsJavaPins.java], ["verapdf", windowsJavaPins.veraPDF]]) {
			const provenance = JSON.parse(await readFile(join(sources[key], "notices/provenance.json"), "utf8"));
			if (provenance.platform !== platform || provenance.arch !== arch || provenance.version !== pin.version || provenance.sha256 !== pin.sha256 || provenance.url !== pin.url) throw new Error(`${key} provenance does not match its pinned Windows x64 payload`);
		}
		windowsVersions = await validateWindowsJava(sources.java, sources.verapdf, { runCommand: (file, args) => runCommand(file, args, { env: javaEnvironment(process.env, "win32") }) });

	}
	if (platform === "darwin") {
		for (const file of ["LICENSE.GPL", "LICENSE.MPL"]) await readFile(join(sources.verapdf, file));
		await readFile(join(sources.java, "legal/java.base/LICENSE"));
		release = await readFile(join(sources.java, "release"), "utf8");
		if (!/OS_ARCH="aarch64"/.test(release) || !/OS_NAME="Darwin"/.test(release)) throw new Error("Java must target macOS arm64");
	}
	const browser = await browserRuntime(sources.browsers, { platform, arch });
	const browserSource = join(sources.browsers, browser.directory, target.directory);
	const browserExecutable = join(browserSource, target.executable);
	if (platform === "darwin" && !runCommand("/usr/bin/lipo", ["-archs", browserExecutable]).split(/\s+/).includes("arm64")) throw new Error("Browser must include arm64");
	if (runCommand(browserExecutable, ["--version"]).trim().split(/\s+/).at(-1) !== browser.browserVersion) throw new Error("Browser binary version does not match Playwright metadata");
	const browserNotice = `## Browser\n\nPlaywright ${browser.playwright}, Chromium headless shell ${browser.browserVersion}, revision ${browser.revision}. License and credits: browsers/${browser.directory}/${target.directory}/LICENSE.headless_shell and ABOUT. Only headless operation is supplied.\n`;
	if (platform === "win32") {
		await mkdir(output);
		if (fullWindows) {
			await copyRuntime(sources.java, join(output, "java"));
			await copyRuntime(sources.verapdf, join(output, "verapdf"), { exclude: ["Uninstaller"] });
		}
		await copyRuntime(browserSource, join(output, "browsers", browser.directory, target.directory));
		await writeFile(join(output, "runtime-versions.json"), JSON.stringify({ platform, arch, ...windowsVersions, browser }, null, 2) + "\n");
		await writeFile(join(output, "NOTICE.md"), fullWindows
			? `## Java\n\n${windowsVersions.java}\n\nLicense and third-party notices: java/legal and java/NOTICE. Source and binary provenance: java/notices/provenance.json.\n\n## veraPDF\n\n${windowsVersions.veraPDF}\n\nProject licenses: verapdf/LICENSE.GPL and verapdf/LICENSE.MPL. Embedded dependency notices remain in verapdf/bin/*.jar. Source and binary provenance: verapdf/notices/provenance.json. Windows invokes bundled java.exe directly with this jar classpath.\n\n${browserNotice}`
			: `# Windows browser runtime\n\n${browserNotice}`);
		return output;
	}
	await mkdir(output);
	await copyRuntime(sources.java, join(output, "java"));
	await copyRuntime(sources.verapdf, join(output, "verapdf"), { exclude: ["Uninstaller"] });
	await copyRuntime(browserSource, join(output, "browsers", browser.directory, target.directory));
	await relocateJava(join(output, "java"), sources.java, output, values["supplemental-notices"]);
	await mkdir(join(output, "bin"));
	await writeFile(join(output, "bin/verapdf"), `#!/bin/sh\nset -eu\nRUNTIME_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport JAVA_HOME="$RUNTIME_DIR/java"\nexport JAVACMD="$JAVA_HOME/bin/java"\nunset CLASSPATH_PREFIX JAVA_OPTS JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS\nexec "$RUNTIME_DIR/verapdf/verapdf" "$@"\n`, { mode: 0o755 });
	const javaVersion = run(join(output, "java/bin/java"), ["--version"]);
	const veraPDFVersion = run(join(output, "bin/verapdf"), ["--version"]);
	await writeFile(join(output, "runtime-versions.json"), JSON.stringify({ platform: "darwin", arch: "arm64", java: javaVersion, veraPDF: veraPDFVersion, browser, javaRelease: release }, null, 2) + "\n");
	await writeFile(join(output, "NOTICE.md"), `## Java\n\n${javaVersion}\n\nLicense and third-party notices: java/legal. External library notices, when present: java-external/NOTICE.md and java-external/notices.\n\n## veraPDF\n\n${veraPDFVersion}\n\nProject licenses: verapdf/LICENSE.GPL and verapdf/LICENSE.MPL. Embedded dependency notices remain in verapdf/bin/*.jar.\n\n${browserNotice}`);
	return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: Object.fromEntries(["platform", "arch", "verapdf", "java", "browsers", "output", "supplemental-notices"].map(name => [name, { type: "string" }])) });
	console.log(await prepareRuntimes(values));
}
