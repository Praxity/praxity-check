import { access, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const run = (file, args) => execFileSync(file, args, { encoding: "utf8" }).trim();

export async function browserRuntime(cache) {
	const require = createRequire(import.meta.url);
	const core = createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json");
	const metadata = JSON.parse(await readFile(join(dirname(core), "browsers.json"), "utf8"));
	const browser = metadata.browsers.find(item => item.name === "chromium-headless-shell");
	const directory = `chromium_headless_shell-${browser.revision}`;
	const runtime = join(cache, directory, "chrome-headless-shell-mac-arm64");
	await access(join(runtime, "chrome-headless-shell"));
	await readFile(join(runtime, "LICENSE.headless_shell"));
	return { ...browser, directory, playwright: JSON.parse(await readFile(core, "utf8")).version };
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
		const { prepareHomebrewRuntime } = await import("./prepare-poppler.mjs");
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

export async function prepareRuntimes(values) {
	if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Runtime assembly supports macOS arm64 only");
	for (const key of ["poppler", "verapdf", "java", "browsers", "output"]) if (!values[key]) throw new Error(`Required: --${key} <directory>`);
	const output = resolve(values.output);
	const sources = Object.fromEntries(await Promise.all(["poppler", "verapdf", "java", "browsers"].map(async key => [key, await realpath(values[key])])));
	for (const source of Object.values(sources)) if (output === source || output.startsWith(source + "/")) throw new Error("Output must be outside source runtime directories");
	const popplerNotice = await readFile(join(sources.poppler, "NOTICE.md"), "utf8");
	for (const file of ["pdfinfo", "pdffonts", "pdfimages", "pdftotext", "pdftohtml", "pdftoppm"]) await access(join(sources.poppler, "bin", file));
	for (const file of ["LICENSE.GPL", "LICENSE.MPL"]) await readFile(join(sources.verapdf, file));
	await readFile(join(sources.java, "legal/java.base/LICENSE"));
	const release = await readFile(join(sources.java, "release"), "utf8");
	if (!/OS_ARCH="aarch64"/.test(release) || !/OS_NAME="Darwin"/.test(release)) throw new Error("Java must target macOS arm64");
	const browser = await browserRuntime(sources.browsers);
	const browserExecutable = join(sources.browsers, browser.directory, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
	if (!run("/usr/bin/lipo", ["-archs", browserExecutable]).split(/\s+/).includes("arm64")) throw new Error("Browser must include arm64");
	if (!run(browserExecutable, ["--version"]).endsWith(browser.browserVersion)) throw new Error("Browser binary version does not match Playwright metadata");
	await mkdir(output);
	await cp(sources.poppler, output, { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
	await cp(sources.java, join(output, "java"), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
	await cp(sources.verapdf, join(output, "verapdf"), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE, filter: path => !relative(sources.verapdf, path).split("/").includes("Uninstaller") });
	await cp(join(sources.browsers, browser.directory), join(output, "browsers", browser.directory), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
	await relocateJava(join(output, "java"), sources.java, output, values["supplemental-notices"]);
	await writeFile(join(output, "bin/verapdf"), `#!/bin/sh\nset -eu\nRUNTIME_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport JAVA_HOME="$RUNTIME_DIR/java"\nexport JAVACMD="$JAVA_HOME/bin/java"\nunset CLASSPATH_PREFIX JAVA_OPTS JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS\nexec "$RUNTIME_DIR/verapdf/verapdf" "$@"\n`, { mode: 0o755 });
	const javaVersion = run(join(output, "java/bin/java"), ["--version"]);
	const veraPDFVersion = run(join(output, "bin/verapdf"), ["--version"]);
	await writeFile(join(output, "runtime-versions.json"), JSON.stringify({ platform: "darwin", arch: "arm64", java: javaVersion, veraPDF: veraPDFVersion, browser, javaRelease: release }, null, 2) + "\n");
	await writeFile(join(output, "NOTICE.md"), `${popplerNotice}\n\n## Java\n\n${javaVersion}\n\nLicense and third-party notices: java/legal. External library notices, when present: java-external/NOTICE.md and java-external/notices.\n\n## veraPDF\n\n${veraPDFVersion}\n\nProject licenses: verapdf/LICENSE.GPL and verapdf/LICENSE.MPL. Embedded dependency notices remain in verapdf/bin/*.jar.\n\n## Browser\n\nPlaywright ${browser.playwright}, Chromium headless shell ${browser.browserVersion}, revision ${browser.revision}. License and credits: browsers/${browser.directory}/chrome-headless-shell-mac-arm64/LICENSE.headless_shell and ABOUT. Only headless operation is supplied.\n`);
	return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: Object.fromEntries(["poppler", "verapdf", "java", "browsers", "output", "supplemental-notices"].map(name => [name, { type: "string" }])) });
	console.log(await prepareRuntimes(values));
}
