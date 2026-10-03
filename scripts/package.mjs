import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { browserRuntime } from "./prepare-runtimes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// The inspector is a seam for testing foreign-target layouts without executing foreign binaries.
export async function packageArtifact(values, inspectNode = executable => JSON.parse(execFileSync(executable, ["-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})"], { encoding: "utf8" }))) {
	if (!values.node || !values.output) throw new Error("Required: --node <Node distribution> --output <new directory>; optional --dependencies <reviewed relocatable runtime artifact>");
	const output = resolve(values.output);
	const node = resolve(values.node);
	const platform = values.platform ?? process.platform;
	const arch = values.arch ?? process.arch;
	// Linux keeps the existing POSIX packaging path used by the repository's CI.
	if (!(platform === "win32" && arch === "x64" || ["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(arch))) throw new Error("Supported targets: win32 x64, or darwin/linux arm64/x64");
	const nodePath = platform === "win32" ? "node.exe" : "bin/node";
	const runtimePath = platform === "win32" ? "runtime/node.exe" : "runtime/node";
	const info = await inspectNode(join(node, nodePath));
	if (info.platform !== platform || info.arch !== arch) throw new Error(`Node target mismatch: expected ${platform} ${arch}, received ${info.platform} ${info.arch}`);
	const version = info.version;
	const [major, minor] = version.slice(1).split(".").map(Number);
	if (!(major > 22 || major === 22 && minor >= 18)) throw new Error(`Check requires Node >=22.18; received ${version}`);
	await readFile(join(node, "LICENSE"));
	let runtime;
	if (values.dependencies) {
		await readFile(join(resolve(values.dependencies), "NOTICE.md"));
		runtime = JSON.parse(await readFile(join(resolve(values.dependencies), "runtime-versions.json"), "utf8"));
		if (runtime.platform !== platform || runtime.arch !== arch) throw new Error("Dependencies target mismatch");
		if (runtime.poppler !== undefined) throw new Error("Runtime artifact contains obsolete native PDF tooling; regenerate it with prepare-runtimes.mjs.");
		if (runtime.browser) {
			let browser;
			try { browser = await browserRuntime(join(resolve(values.dependencies), "browsers"), { platform, arch }); }
			catch (cause) { throw new Error("Supplied browser runtime does not match installed Playwright or lacks its executable, license or credits", { cause }); }
			for (const field of ["revision", "browserVersion", "playwright"]) {
				if (runtime.browser[field] !== browser[field]) throw new Error(`Supplied browser runtime ${field} does not match installed Playwright`);
			}
		}
	}
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim());
	await mkdir(output);
	for (const dir of ["bin", "runtime", "lib", "node_modules"]) await mkdir(join(output, dir));
	await cp(join(node, nodePath), join(output, runtimePath), { dereference: true, mode: constants.COPYFILE_FICLONE });
	await cp(join(node, "LICENSE"), join(output, "runtime/LICENSE"), { dereference: true });
	for (const file of ["LICENSE", "NOTICE.md", "LICENSING.md"]) await cp(join(root, file), join(output, file));
	await cp(join(root, "notices"), join(output, "notices"), { recursive: true, dereference: true });
	await cp(join(root, "skill"), join(output, "skill"), { recursive: true, dereference: true });
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	await writeFile(join(output, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module" }, null, 2));
	for (const file of await readdir(join(root, "src"))) {
		if (!file.endsWith(".ts")) throw new Error(`Unrecognized runtime asset: src/${file}`);
		const source = await readFile(join(root, "src", file), "utf8");
		const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true } });
		await writeFile(join(output, "lib", file.replace(/\.ts$/, ".js")), result.outputText);
	}
	const copied = new Map();
	const notices = ["# Bundled dependencies", "Node licence and notices: runtime/LICENSE. Dependency licence files are retained in node_modules. Optional native/runtime notices: dependencies/NOTICE.md."];
	async function dependency(name, from) {
		let location;
		for (let dir = from; ; dir = dirname(dir)) {
			try { location = await realpath(join(dir, "node_modules", name)); break; }
			catch (error) { if (error.code !== "ENOENT") throw error; }
			if (dirname(dir) === dir) throw new Error(`Missing installed runtime dependency ${name}`);
		}
		const metadata = JSON.parse(await readFile(join(location, "package.json"), "utf8"));
		if (copied.has(name)) {
			if (copied.get(name) !== metadata.version) throw new Error(`Conflicting runtime versions for ${name}; use a dependency-aware deployment tool`);
			return;
		}
		copied.set(name, metadata.version);
		await cp(location, join(output, "node_modules", name), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE, filter: path => !relative(location, path).split(/[\\/]/).includes("node_modules") && !/\.(map|log)$/i.test(path) });
		notices.push(`- ${name}@${metadata.version}: ${metadata.license ?? "see package licence files"}`);
		for (const child of Object.keys(metadata.dependencies ?? {})) await dependency(child, location);
		for (const child of Object.keys(metadata.optionalDependencies ?? {})) {
			try { await dependency(child, location); } catch (error) { if (!error.message.startsWith("Missing installed runtime dependency")) throw error; }
		}
	}
	for (const name of Object.keys(pkg.dependencies)) await dependency(name, root);
	if (values.dependencies) await cp(resolve(values.dependencies), join(output, "dependencies"), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE, filter: path => !/\.(map|log)$/i.test(path) });
	await writeFile(join(output, "THIRD-PARTY-NOTICES.md"), notices.join("\n\n") + "\n");
	await writeFile(join(output, platform === "win32" ? "bin/praxity-check.cmd" : "bin/praxity-check"), launcher(platform), { mode: 0o755 });
	const payload = [];
	async function inventory(directory) {
		for (const name of (await readdir(directory)).sort()) {
			const path = join(directory, name);
			const stat = await lstat(path);
			if (stat.isDirectory()) await inventory(path);
			else {
				if (!stat.isFile()) throw new Error(`Artifact contains a non-regular file: ${relative(output, path)}`);
				const bytes = await readFile(path);
				payload.push({ path: relative(output, path).split(/[\\/]/).join("/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
			}
		}
	}
	await inventory(output);
	await writeFile(join(output, "capabilities.json"), JSON.stringify({
		schemaVersion: 1, tool: pkg.name, version: pkg.version, sourceRevision: revision, dirty,
		platform, arch, node: version, nodeRequirement: pkg.engines.node,
		entryPoint: platform === "win32" ? "bin/praxity-check.cmd" : "bin/praxity-check",
		legalFiles: payload.filter(file => /(?:^|\/)(?:.*\.)?(?:licen[cs]e[^/]*|copying[^/]*|copyright[^/]*|notice[^/]*|third[- ]?party[^/]*|about)$/i.test(file.path) || file.path === "LICENSING.md" || file.path.startsWith("notices/pdfium/") || file.path.includes("/legal/") || file.path.startsWith("dependencies/notices/toolchain/") && !file.path.endsWith(".cmake")).map(file => file.path),
		files: payload,
		inventoryExcludes: ["capabilities.json"], // A manifest cannot hash its own bytes.
		dependenciesSupplied: Boolean(values.dependencies),
		payloads: { chromiumHeadlessShell: Boolean(runtime?.browser), pdfium: payload.some(file => file.path === "node_modules/@embedpdf/pdfium/dist/pdfium.wasm"), java: payload.some(file => file.path === "dependencies/java/bin/java" || file.path === "dependencies/java/bin/java.exe"), veraPDF: payload.some(file => file.path === "dependencies/bin/verapdf" || platform === "win32" && /^dependencies\/verapdf\/bin\/cli-.+\.jar$/.test(file.path)) },
		requirements: {
			pdf: ["Bundled @embedpdf/pdfium wrapper and pdfium.wasm"],
			pdfDesignAndReview: ["Bundled PDFium engine"],
			pdfUa: [platform === "win32" ? "veraPDF jars with VERAPDF_JAVA and VERAPDF_CLASSPATH, or VERAPDF/--verapdf executable" : "veraPDF executable (dependencies/bin/verapdf, VERAPDF or --verapdf)", "compatible Java runtime"],
			html: ["Playwright-matched Chromium in dependencies/browsers (including headless shell)"],
		},
		note: "Requirements are not capability claims. Native tools, shared libraries, Java and browsers are supplied only by --dependencies; each operation reports missing or failed tools. Artifacts must match this platform and architecture and retain their notices."
	}, null, 2) + "\n");
	return output;
}

function launcher(platform) {
if (platform === "win32") return `@echo off\r
setlocal DisableDelayedExpansion\r
for %%I in ("%~dp0..") do set "CHECK_DIR=%%~fI"\r
set "PLAYWRIGHT_BROWSERS_PATH=%CHECK_DIR%\\dependencies\\browsers"\r
if exist "%CHECK_DIR%\\dependencies\\java\\bin\\java.exe" (\r
  set "JAVA_HOME=%CHECK_DIR%\\dependencies\\java"\r
  set "JAVACMD=%CHECK_DIR%\\dependencies\\java\\bin\\java.exe"\r
  if exist "%CHECK_DIR%\\dependencies\\verapdf\\bin\\*.jar" (\r
    set "VERAPDF=%CHECK_DIR%\\dependencies\\java\\bin\\java.exe"\r
    set "VERAPDF_JAVA=%CHECK_DIR%\\dependencies\\java\\bin\\java.exe"\r
    set "VERAPDF_CLASSPATH=%CHECK_DIR%\\dependencies\\verapdf\\bin\\*"\r
  )\r
)\r
"%CHECK_DIR%\\runtime\\node.exe" "%CHECK_DIR%\\lib\\cli.js" %*\r
exit /b %errorlevel%\r
`;
return `#!/bin/sh
set -eu
CHECK_DIR="$(CDPATH= cd -- "\${0%/*}/.." && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="$CHECK_DIR/dependencies/browsers"
if [ -x "$CHECK_DIR/dependencies/bin/verapdf" ]; then export VERAPDF="$CHECK_DIR/dependencies/bin/verapdf"; fi
if [ -x "$CHECK_DIR/dependencies/java/bin/java" ]; then
  export JAVA_HOME="$CHECK_DIR/dependencies/java"
fi
exec "$CHECK_DIR/runtime/node" "$CHECK_DIR/lib/cli.js" "$@"
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: Object.fromEntries(["node", "dependencies", "output", "platform", "arch"].map(name => [name, { type: "string" }])) });
	console.log(await packageArtifact(values));
}
