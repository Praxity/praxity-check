import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export async function prepareHomebrewRuntime({ roots, output: outputPath, prefix: prefixPath = "/opt/homebrew", executables = false, supplementalNotices, sourceRoots = [] }) {
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Requires macOS arm64 and Xcode command-line tools");
const prefix = await realpath(prefixPath);
const output = resolve(outputPath);
const sourceInstalls = await Promise.all(sourceRoots.map(path => realpath(path)));
const run = (tool, args) => execFileSync(tool, args, { encoding: "utf8" }).trim();
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const system = path => path.startsWith("/usr/lib/") || path.startsWith("/System/Library/");
const tools = ["pdfinfo", "pdffonts", "pdfimages", "pdftotext", "pdftoppm", "pdftohtml"];
const files = new Map();
const names = new Map();
const kegs = new Set();
async function collect(path, executable, inherited = []) {
	const source = await realpath(path);
	if (files.has(source)) return files.get(source);
	const keg = source.slice(prefix.length + 1).split("/");
	const sourceInstall = sourceInstalls.find(root => source.startsWith(`${root}/`));
	if (!sourceInstall && (!source.startsWith(`${prefix}/Cellar/`) || keg.length < 4)) throw new Error(`Dependency is outside allowed source roots and Homebrew Cellar: ${source}`);
	kegs.add(sourceInstall ?? join(prefix, ...keg.slice(0, 3)));
	const target = `${executables && executable === source ? "bin" : "lib"}/${basename(source)}`;
	if (names.has(target) && names.get(target) !== source) throw new Error(`Unsafe filename collision: ${target}`);
	names.set(target, source);
	if (!run("/usr/bin/lipo", ["-archs", source]).split(/\s+/).includes("arm64")) throw new Error(`Missing arm64: ${source}`);
	const load = run("/usr/bin/otool", ["-l", source]);
	const rpaths = [...load.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset/g)].map(match => match[1]);
	const expand = value => value.replace(/^@loader_path(?=\/|$)/, dirname(source)).replace(/^@executable_path(?=\/|$)/, dirname(executable));
	const search = [...rpaths.map(expand), ...inherited];
	const record = { source, target, sha256: await hash(source), rpaths, dependencies: [], buildVersion: load.match(/cmd LC_BUILD_VERSION[\s\S]*?(?=Load command|$)/)?.[0].trim() ?? "See otool output for deployment target" };
	files.set(source, record);
	const id = run("/usr/bin/otool", ["-D", source]).split("\n")[1];
	for (const line of run("/usr/bin/otool", ["-L", source]).split("\n").slice(1)) {
		const name = line.trim().split(" (compatibility version")[0];
		if (name === id || system(name)) continue;
		const candidates = name.startsWith("@rpath/") ? search.map(base => join(base, name.slice(7))) : [expand(name)];
		let dependency;
		for (const candidate of candidates) {
			try { dependency = await realpath(candidate); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
		}
		if (!dependency) throw new Error(`Unresolved dependency ${name} in ${source}`);
		const child = await collect(dependency, executable, search);
		record.dependencies.push({ name, target: child.target });
	}
	return record;
}
for (const path of roots ?? tools.map(tool => join(prefix, "bin", tool))) {
	const source = await realpath(path);
	await collect(source, source);
}
// Refuse to merge into an existing artifact, especially the source installation.
await mkdir(output);
for (const directory of ["bin", "lib", "notices"]) await mkdir(join(output, directory));
for (const record of files.values()) {
	const destination = join(output, record.target);
	await copyFile(record.source, destination);
	const args = record.dependencies.flatMap(dep => ["-change", dep.name, `@loader_path/${relative(dirname(record.target), dep.target)}`]);
	for (const rpath of record.rpaths) args.push("-delete_rpath", rpath);
	if (record.target.startsWith("lib/")) args.push("-id", `@loader_path/${basename(record.target)}`);
	if (args.length) {
		run("/usr/bin/install_name_tool", [...args, destination]);
		run("/usr/bin/codesign", ["--force", "--sign", "-", destination]);
	}
	run("/usr/bin/codesign", ["--verify", "--strict", destination]);
	const linked = run("/usr/bin/otool", ["-L", destination]);
	for (const line of linked.split("\n").slice(1)) {
		const name = line.trim().split(" (compatibility version")[0];
		if (!system(name) && !name.startsWith("@loader_path/")) throw new Error(`Unrelocated dependency: ${name}`);
	}
	record.bundledSha256 = await hash(destination);
}
const packages = [];
for (const keg of [...kegs].sort()) {
	const fromSource = sourceInstalls.includes(keg);
	const name = fromSource ? `source-${basename(keg)}` : relative(join(prefix, "Cellar"), keg);
	const destination = join(output, "notices", name);
	await mkdir(destination, { recursive: true });
	const retained = [];
	async function notices(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) { if (!["bin", "lib", "include"].includes(entry.name)) await notices(path); }
			else if (entry.isFile() && /^(copying|copyright|licen[cs]e|notice|authors)([._-]|$)/i.test(entry.name)) retained.push(path);
		}
	}
	await notices(keg);
	if (supplementalNotices) {
		const supplement = join(resolve(supplementalNotices), name.split("/")[0]);
		try {
			await cp(supplement, join(destination, "supplemental"), { recursive: true });
			for (const file of await readdir(supplement)) if (/^(copying|copyright|licen[cs]e|notice)([._-]|$)/i.test(file)) retained.push(join(supplement, file));
		} catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	if (!retained.some(path => /^(copying|copyright|licen[cs]e|notice)([._-]|$)/i.test(basename(path)))) throw new Error(`No license/notice files installed for ${name}`);
	for (const path of retained.filter(path => path.startsWith(`${keg}/`))) {
		const target = join(destination, relative(keg, path));
		await mkdir(dirname(target), { recursive: true });
		await copyFile(path, target);
	}
	if (fromSource) {
		// Source builders supply the archive, patch, recipe and hashes; never label these as bottles.
		await readFile(join(keg, "notices/poppler/provenance.json"));
		await cp(join(keg, "notices"), join(destination, "source"), { recursive: true });
	} else {
		for (const file of ["INSTALL_RECEIPT.json", "sbom.spdx.json", ".brew"]) await cp(join(keg, file), join(destination, file), { recursive: true });
	}
	packages.push({ name, origin: fromSource ? "source-build" : "homebrew", notices: retained.map(path => path.startsWith(`${keg}/`) ? relative(keg, path) : `supplemental/${basename(path)}`) });
}
await writeFile(join(output, "notices/provenance.json"), JSON.stringify({ builtAt: new Date().toISOString(), platform: process.platform, arch: process.arch, macOS: run("/usr/bin/sw_vers", ["-productVersion"]), prefix, packages, files: [...files.values()] }, null, 2) + "\n");
await writeFile(join(output, "NOTICE.md"), `# Homebrew native runtime\n\nLocal macOS arm64 development artifact, assembled from installed Homebrew packages and explicitly supplied source builds. No host files were changed. Copied Mach-O load commands were relocated and modified files ad-hoc signed.\n\nIncludes ${[...files.values()].filter(file => file.target.startsWith("bin/")).map(file => basename(file.target)).join(", ") || "Native libraries"} and their ${[...files.values()].filter(file => file.target.startsWith("lib/")).length} non-system dylibs. Package licenses, Homebrew formulas, installation receipts, bottle SBOMs and file hashes are retained under notices/.\n\n${packages.map(pkg => `- ${pkg.name}: notices/${pkg.name}`).join("\n")}\n\nThis is not a release-ready license compliance bundle. Poppler and some dependencies have copyleft obligations; installed notices and source URLs do not themselves provide corresponding source or a source offer. Review the retained formulas, receipts and SBOMs and supply required source before redistribution.\n\nRequires Apple arm64 macOS compatible with each recorded Mach-O deployment target and system libraries. Ad-hoc signing is not Developer ID signing or notarization. Runtime-loaded plugins, fontconfig configuration, fonts and Poppler character maps are not collected by dylib dependency traversal. Non-Latin text and font substitution need separate data packaging and validation.\n`);
return new Map([...files].map(([source, record]) => [source, record.target]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options: Object.fromEntries(["output", "prefix", "supplemental-notices", "source-install"].map(name => [name, { type: "string" }])) });
	if (!values.output) throw new Error("Required: --output <new directory>; optional --prefix <Homebrew prefix> --supplemental-notices <package notice directories>");
	const sourceInstall = values["source-install"] && resolve(values["source-install"]);
	if (sourceInstall) {
		for (const directory of ["cMap", "cidToUnicode", "nameToUnicode", "unicodeMap"]) await readdir(join(sourceInstall, "share/poppler", directory));
		await readFile(join(sourceInstall, "etc/fonts/fonts.conf"));
	}
	await prepareHomebrewRuntime({ output: values.output, prefix: values.prefix, executables: true, supplementalNotices: values["supplemental-notices"], sourceRoots: values["source-install"] ? [values["source-install"]] : [], roots: values["source-install"] ? ["pdfinfo", "pdffonts", "pdfimages", "pdftotext", "pdftoppm", "pdftohtml"].map(tool => join(values["source-install"], "bin", tool)) : undefined });
	if (sourceInstall) {
		await cp(join(sourceInstall, "share/poppler"), join(values.output, "share/poppler"), { recursive: true });
		await cp(join(sourceInstall, "etc/fonts"), join(values.output, "etc/fonts"), { recursive: true });
		const notice = join(values.output, "NOTICE.md");
		await writeFile(notice, (await readFile(notice, "utf8")) + `\n## Poppler data and system fonts\n\nThis source-build artifact includes Poppler encoding data in share/poppler and fontconfig configuration in etc/fonts/fonts.conf. Set POPPLER_DATADIR to the bundled share/poppler and FONTCONFIG_FILE to the bundled etc/fonts/fonts.conf; the Check launcher sets these paths. Font substitution uses macOS /System/Library/Fonts and /Library/Fonts; no Apple font files are copied. Font caches use the XDG cache directory. The Poppler source archive, environment override patch, build recipe, source hashes, data archive and data licenses are retained under notices/source-${basename(sourceInstall)}/source/poppler/. These retained Poppler sources do not fulfill the separate source obligations of every bundled dependency.\n`);
	}
	console.log(resolve(values.output));
}
