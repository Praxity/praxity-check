import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const { values } = parseArgs({ options: Object.fromEntries(["node", "dependencies", "output"].map(name => [name, { type: "string" }])) });
if (!values.node || !values.output) throw new Error("Required: --node <Node distribution> --output <new directory>; optional --dependencies <reviewed relocatable runtime artifact>");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(values.output);
const node = resolve(values.node);
const version = execFileSync(join(node, "bin/node"), ["--version"], { encoding: "utf8" }).trim();
const [major, minor] = version.slice(1).split(".").map(Number);
if (!(major > 22 || major === 22 && minor >= 18)) throw new Error(`Check requires Node >=22.18; received ${version}`);
await readFile(join(node, "LICENSE"));
if (values.dependencies) await readFile(join(resolve(values.dependencies), "NOTICE.md"));
await mkdir(output);
for (const dir of ["bin", "runtime", "lib", "node_modules"]) await mkdir(join(output, dir));
await cp(join(node, "bin/node"), join(output, "runtime/node"), { dereference: true, mode: constants.COPYFILE_FICLONE });
await cp(join(node, "LICENSE"), join(output, "runtime/LICENSE"), { dereference: true });
for (const file of ["LICENSE", "NOTICE.md", "LICENSING.md"]) await cp(join(root, file), join(output, file));
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
	await cp(location, join(output, "node_modules", name), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE, filter: path => path === location || !path.slice(location.length + 1).split("/").includes("node_modules") });
	notices.push(`- ${name}@${metadata.version}: ${metadata.license ?? "see package licence files"}`);
	for (const child of Object.keys(metadata.dependencies ?? {})) await dependency(child, location);
	for (const child of Object.keys(metadata.optionalDependencies ?? {})) {
		try { await dependency(child, location); } catch (error) { if (!error.message.startsWith("Missing installed runtime dependency")) throw error; }
	}
}
for (const name of Object.keys(pkg.dependencies)) await dependency(name, root);
if (values.dependencies) await cp(resolve(values.dependencies), join(output, "dependencies"), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
await writeFile(join(output, "THIRD-PARTY-NOTICES.md"), notices.join("\n\n") + "\n");
await writeFile(join(output, "capabilities.json"), JSON.stringify({
	schemaVersion: 1, platform: process.platform, arch: process.arch, node: version,
	dependenciesSupplied: Boolean(values.dependencies),
	requirements: {
		pdf: ["pdfinfo", "pdffonts", "pdfimages", "pdftotext"],
		pdfDesignAndReview: ["pdftohtml", "pdftoppm"],
		pdfUa: ["veraPDF executable (dependencies/bin/verapdf, VERAPDF or --verapdf)", "compatible Java runtime"],
		html: ["Playwright-matched Chromium in dependencies/browsers (including headless shell)"],
	},
	note: "Requirements are not capability claims. Native tools, shared libraries, Java and browsers are supplied only by --dependencies; each operation reports missing or failed tools. Artifacts must match this platform and architecture and retain their notices."
}, null, 2) + "\n");
await writeFile(join(output, "bin/praxity-check"), `#!/bin/sh
set -eu
CHECK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export PATH="$CHECK_DIR/dependencies/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$CHECK_DIR/dependencies/browsers"
if [ -d "$CHECK_DIR/dependencies/share/poppler" ]; then export POPPLER_DATADIR="$CHECK_DIR/dependencies/share/poppler"; fi
if [ -f "$CHECK_DIR/dependencies/etc/fonts/fonts.conf" ]; then
  export FONTCONFIG_FILE="$CHECK_DIR/dependencies/etc/fonts/fonts.conf"
  export FONTCONFIG_PATH="$CHECK_DIR/dependencies/etc/fonts"
fi
if [ -x "$CHECK_DIR/dependencies/bin/verapdf" ]; then export VERAPDF="$CHECK_DIR/dependencies/bin/verapdf"; fi
if [ -x "$CHECK_DIR/dependencies/java/bin/java" ]; then
  export JAVA_HOME="$CHECK_DIR/dependencies/java"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
exec "$CHECK_DIR/runtime/node" "$CHECK_DIR/lib/cli.js" "$@"
`, { mode: 0o755 });
console.log(output);
