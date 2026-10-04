import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { requireNode } from "../src/node-runtime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

// The inspector is a seam for testing foreign-target layouts without executing foreign binaries.
export async function packageArtifact(values, inspectNode = executable => JSON.parse(execFileSync(executable, ["-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})"], { encoding: "utf8" })), locateDependency = installedDependency) {
	const portable = values.portable === true;
	if (!values.output || !portable && !values.node) throw new Error("Required: --node <Node distribution> or --portable, and --output <new directory>; install components separately with check setup");
	if (portable && (values.node || values.platform || values.arch)) throw new Error("--portable uses a host-supplied Node runtime; omit --node, --platform and --arch");
	const output = resolve(values.output);
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const node = portable ? undefined : resolve(values.node);
	const platform = values.platform ?? process.platform;
	const arch = values.arch ?? process.arch;
	// Linux keeps the existing POSIX packaging path used by the repository's CI.
	if (!(platform === "win32" && arch === "x64" || ["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(arch))) throw new Error("Supported targets: win32 x64, or darwin/linux arm64/x64");
	const nodePath = platform === "win32" ? "node.exe" : "bin/node";
	const runtimePath = platform === "win32" ? "runtime/node.exe" : "runtime/node";
	let version = null;
	if (!portable) {
		const info = await inspectNode(join(node, nodePath));
		if (info.platform !== platform || info.arch !== arch) throw new Error(`Node target mismatch: expected ${platform} ${arch}, received ${info.platform} ${info.arch}`);
		version = info.version;
		requireNode(version, pkg.engines.node);
		await readFile(join(node, "LICENSE"));
	}
	if (values.dependencies) throw new Error("--dependencies is no longer supported; install components with check setup.");
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim());
	await mkdir(output);
	for (const dir of portable ? ["lib", "node_modules"] : ["bin", "runtime", "lib", "node_modules"]) await mkdir(join(output, dir));
	if (!portable) {
		await cp(join(node, nodePath), join(output, runtimePath), { dereference: true, mode: constants.COPYFILE_FICLONE });
		await cp(join(node, "LICENSE"), join(output, "runtime/LICENSE"), { dereference: true });
	}
	for (const file of ["LICENSE", "NOTICE.md", "LICENSING.md"]) await cp(join(root, file), join(output, file));
	await cp(join(root, "notices"), join(output, "notices"), { recursive: true, dereference: true });
	await cp(join(root, "skill"), join(output, "skill"), { recursive: true, dereference: true });
	await writeFile(join(output, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", engines: pkg.engines }, null, 2));
	for (const file of await readdir(join(root, "src"))) {
		if (!file.endsWith(".ts")) throw new Error(`Unrecognized runtime asset: src/${file}`);
		const source = await readFile(join(root, "src", file), "utf8");
		const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true } });
		await writeFile(join(output, "lib", file.replace(/\.ts$/, ".js")), result.outputText);
	}
	const copied = new Map();
	const notices = ["# Bundled dependencies", portable ? "Node is supplied by the host. Check's notices are in NOTICE.md and notices/. Dependency licence files are retained in node_modules." : "Node licence and notices: runtime/LICENSE. Dependency licence files are retained in node_modules."];
	async function dependency(name, from) {
		const location = await locateDependency(name, from);
		const metadata = JSON.parse(await readFile(join(location, "package.json"), "utf8"));
		if (copied.has(name)) {
			if (copied.get(name) !== metadata.version) throw new Error(`Conflicting runtime versions for ${name}; use a dependency-aware deployment tool`);
			return;
		}
		copied.set(name, metadata.version);
		await cp(location, join(output, "node_modules", name), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE, filter: path => !relative(location, path).split(/[\\/]/).some(part => ["node_modules", ".local-browsers"].includes(part)) && !/\.(map|log)$/i.test(path) });
		notices.push(`- ${name}@${metadata.version}: ${metadata.license ?? "see package licence files"}`);
		for (const child of Object.keys(metadata.dependencies ?? {})) await dependency(child, location);
		for (const child of Object.keys(metadata.optionalDependencies ?? {})) {
			// Playwright's macOS watcher is for its test runner, which Check does not use.
			// Omit it in portable builds even when installed on the build machine.
			if (portable && name === "playwright" && child === "fsevents") continue;
			try { await dependency(child, location); } catch (error) { if (!error.message.startsWith("Missing installed runtime dependency")) throw error; }
		}
	}
	for (const name of Object.keys(pkg.dependencies)) await dependency(name, root);
	await writeFile(join(output, "THIRD-PARTY-NOTICES.md"), notices.join("\n\n") + "\n");
	if (!portable) await writeFile(join(output, platform === "win32" ? "bin/praxity-check.cmd" : "bin/praxity-check"), launcher(platform), { mode: 0o755 });
	const payload = [];
	async function inventory(directory) {
		for (const name of (await readdir(directory)).sort()) {
			const path = join(directory, name);
			const stat = await lstat(path);
			if (stat.isDirectory()) await inventory(path);
			else {
				if (!stat.isFile()) throw new Error(`Artifact contains a non-regular file: ${relative(output, path)}`);
				let bytes = await readFile(path);
				if (portable) {
					const magic = bytes.subarray(0, 4).toString("hex");
					if (/\.(?:exe|com|dll|node|so(?:\.\d+)*|dylib|a|lib)$/i.test(name) || /^(?:node|nodejs)$/i.test(basename(path)) || bytes.subarray(0, 2).toString() === "MZ" || ["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic) || ["!<arch>\n", "!<thin>\n"].includes(bytes.subarray(0, 8).toString())) throw new Error(`Portable artifact contains a native binary: ${relative(output, path)}`);
					const script = /\.(?:[cm]?js|ts|sh|bash|cmd|bat|ps1|vbs)$/i.test(name) || bytes.subarray(0, 2).toString() === "#!";
					if (script && bytes.includes(13)) {
						// Rewriting is only safe for UTF-8 text. NUL bytes catch UTF-16 without a BOM, which decodes as valid UTF-8.
						let text;
						try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = undefined; }
						if (text === undefined || bytes.includes(0)) throw new Error(`Portable artifact contains a script with CRLF line endings that is not UTF-8: ${relative(output, path).split(/[\\/]/).join("/")}`);
						bytes = Buffer.from(text.replace(/\r\n?/g, "\n"));
						await writeFile(path, bytes);
					}
					await chmod(path, bytes.subarray(0, 2).toString() === "#!" ? 0o755 : 0o644);
				}
				payload.push({ path: relative(output, path).split(/[\\/]/).join("/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
			}
		}
	}
	await inventory(output);
	await writeFile(join(output, "capabilities.json"), JSON.stringify({
		schemaVersion: 1, tool: pkg.name, version: pkg.version, sourceRevision: revision, dirty,
		platform: portable ? "any" : platform, arch: portable ? "any" : arch, node: version, nodeRequirement: pkg.engines.node,
		entryPoint: portable ? "lib/cli.js" : platform === "win32" ? "bin/praxity-check.cmd" : "bin/praxity-check",
		legalFiles: payload.filter(file => /(?:^|\/)(?:.*\.)?(?:licen[cs]e[^/]*|copying[^/]*|copyright[^/]*|notice[^/]*|third[- ]?party[^/]*|about)$/i.test(file.path) || file.path === "LICENSING.md" || file.path.startsWith("notices/pdfium/") || file.path.includes("/legal/") || file.path.startsWith("dependencies/notices/toolchain/") && !file.path.endsWith(".cmake")).map(file => file.path),
		files: payload,
		inventoryExcludes: portable ? ["capabilities.json", "inventory.json"] : ["capabilities.json"], // Manifests cannot hash each other cyclically.
		dependenciesSupplied: false,
		payloads: { chromiumHeadlessShell: false, pdfium: payload.some(file => file.path === "node_modules/@embedpdf/pdfium/dist/pdfium.wasm"), java: false, veraPDF: false },
  requirements: { pdf: ["Bundled @embedpdf/pdfium wrapper and pdfium.wasm"], pdfDesignAndReview: ["Bundled PDFium engine"], pdfUa: ["check setup pdf, or explicit veraPDF and Java 17+"], html: ["check setup html"] },
  note: "Requirements are not capability claims. Browser, Java and veraPDF are installed separately by check setup after consent. Each operation reports missing or failed components."

	}, null, 2) + "\n");
	if (portable) {
		await chmod(join(output, "capabilities.json"), 0o644);
		const bytes = await readFile(join(output, "capabilities.json"));
		await writeFile(join(output, "inventory.json"), JSON.stringify({ schemaVersion: 1, tool: pkg.name, version: pkg.version, nodeRequirement: pkg.engines.node, inventoryExcludes: ["inventory.json"], files: [...payload, { path: "capabilities.json", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }].sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + "\n");
		await chmod(join(output, "inventory.json"), 0o644);
	}
	return output;
}

async function installedDependency(name, from) {
	for (let directory = from; ; directory = dirname(directory)) {
		try { return await realpath(join(directory, "node_modules", name)); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		if (dirname(directory) === directory) throw new Error(`Missing installed runtime dependency ${name}`);
	}
}

function launcher(platform) {
 if (platform === "win32") return '@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor %%I in ("%~dp0..") do set "CHECK_DIR=%%~fI"\r\n"%CHECK_DIR%\\runtime\\node.exe" "%CHECK_DIR%\\lib\\cli.js" %*\r\nexit /b %errorlevel%\r\n';
 return '#!/bin/sh\nset -eu\nCHECK_DIR="$(CDPATH= cd -- "${0%/*}/.." && pwd)"\nexec "$CHECK_DIR/runtime/node" "$CHECK_DIR/lib/cli.js" "$@"\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { ...Object.fromEntries(["node", "dependencies", "output", "platform", "arch"].map(name => [name, { type: "string" }])), portable: { type: "boolean" } } });
	console.log(await packageArtifact(values));
}
