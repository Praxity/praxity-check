import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { poppler, popplerData, popplerTools, windowsPoppler } from "./poppler-inputs.mjs";
import { validateWindowsPayload } from "./windows-pe.mjs";

export async function validateWindowsPoppler(source, { prepared = false } = {}) {
	const record = JSON.parse(await readFile(join(source, prepared ? "notices/provenance.json" : "notices/poppler/provenance.json"), "utf8"));
	const provenance = prepared ? record.build : record;
	if (!provenance || record.platform !== "win32" || record.arch !== "x64" || provenance.vcpkg?.baseline !== windowsPoppler.baseline || provenance.vcpkg?.triplet !== windowsPoppler.triplet) throw new Error("Unexpected Windows Poppler build provenance");
	for (const [key, expected] of [["poppler", poppler], ["popplerData", popplerData]]) {
		for (const field of ["version", "url", "sha256"]) if (provenance[key]?.[field] !== expected[field]) throw new Error("Unexpected Windows Poppler source provenance");
	}
	for (const path of ["notices/poppler/COPYING", "notices/poppler/poppler-data-env.patch", "notices/poppler/build-poppler-windows-runtime.mjs", "etc/fonts/fonts.conf", "share/poppler/cMap/Adobe-Japan1/UniJIS-UTF16-H", "share/poppler/cidToUnicode/Adobe-Japan1", "share/poppler/nameToUnicode/Thai", "share/poppler/unicodeMap/ISO-2022-JP"]) await readFile(join(source, path));
	if (!Array.isArray(provenance.resources) || !provenance.resources.length) throw new Error("Missing Poppler data/configuration inventory");
	for (const resource of provenance.resources) {
		if (typeof resource.path !== "string" || !/^(?:share\/poppler|etc\/fonts)\//.test(resource.path) || resource.path.split("/").some(part => !part || part === ".." || part.includes("\\"))) throw new Error("Unsafe Poppler data path");
		if (createHash("sha256").update(await readFile(join(source, resource.path))).digest("hex") !== resource.sha256) throw new Error(`Poppler data file hash differs from build provenance: ${resource.path}`);
	}
	for (const path of ["share/poppler/cMap/Adobe-Japan1/UniJIS-UTF16-H", "etc/fonts/fonts.conf"]) if (!provenance.resources.some(resource => resource.path === path)) throw new Error(`Missing Poppler data record: ${path}`);
	for (const [path, input] of [[`poppler-${poppler.version}.tar.xz`, poppler], [`poppler-data-${popplerData.version}.tar.gz`, popplerData]]) {
		if (createHash("sha256").update(await readFile(join(source, "notices/poppler", path))).digest("hex") !== input.sha256) throw new Error(`Retained source archive hash mismatch: ${path}`);
	}
	const registryArchive = await readFile(join(source, "notices/sources", `vcpkg-${windowsPoppler.baseline}.tar`));
	if (createHash("sha256").update(registryArchive).digest("hex") !== provenance.registryArchive?.sha256) throw new Error("Retained vcpkg registry archive hash mismatch");
	if (!Array.isArray(provenance.compiler?.notices) || provenance.compiler.notices.length !== 4) throw new Error("Missing Microsoft toolchain legal inventory");
	for (const notice of provenance.compiler.notices) {
		if (typeof notice.file !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(notice.file)) throw new Error("Unsafe toolchain notice filename");
		if (createHash("sha256").update(await readFile(join(source, "notices/toolchain", notice.file))).digest("hex") !== notice.sha256) throw new Error(`Toolchain legal file hash mismatch: ${notice.file}`);
	}
	if (!Array.isArray(provenance.retainedArchives) || !provenance.retainedArchives.length) throw new Error("Missing retained dependency source inventory");
	const sourceChecksums = new Set();
	for (const archive of provenance.retainedArchives) {
		if (typeof archive.file !== "string" || !/^[a-zA-Z0-9_.+-]+$/.test(archive.file)) throw new Error("Unsafe retained source filename");
		const bytes = await readFile(join(source, "notices/sources", archive.file));
		if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) throw new Error(`Retained dependency source hash mismatch: ${archive.file}`);
		sourceChecksums.add(createHash("sha512").update(bytes).digest("hex"));
	}
	for (const name of windowsPoppler.packages) {
		if (!(await readFile(join(source, "notices/dependencies", name, "copyright"))).length) throw new Error(`Missing dependency licence: ${name}`);
		await readFile(join(source, "notices/dependencies", name, "vcpkg.spdx.json"));
		const resources = JSON.parse(await readFile(join(source, "notices/dependencies", name, "vcpkg-spdx-resources.json"), "utf8"));
		if (!Array.isArray(resources.packages) || !resources.packages.length) throw new Error(`Missing dependency source record: ${name}`);
		for (const resource of resources.packages) {
			const checksum = resource.checksums?.find(item => item.algorithm === "SHA512")?.checksumValue;
			if (!sourceChecksums.has(checksum)) throw new Error(`Corresponding dependency source archive missing: ${name}`);
		}
	}
	const executables = popplerTools.map(tool => `bin/${tool}.exe`);
	const originals = await validateWindowsPayload(source, { executables });
	for (const record of originals) {
		if (record.imports.some(item => !item.system)) throw new Error(`Source build must use static dependencies: ${record.path}`);
		const previous = provenance.pe.find(item => item.path === record.path);
		if (previous?.sha256 !== record.sha256) throw new Error(`Poppler binary hash differs from build provenance: ${record.path}`);
	}
	return { provenance, files: originals };
}

/** Static linking removes dependency search paths; reject any unexpected external DLL. */
export async function prepareWindowsPoppler(sourcePath, outputPath) {
	if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Requires Windows x64");
	const source = await realpath(sourcePath), output = resolve(outputPath);
	const actualOutput = join(await realpath(dirname(output)), relative(dirname(output), output));
	const child = relative(source, actualOutput);
	if (child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)) throw new Error("Output must be outside source runtime");
	const { provenance } = await validateWindowsPoppler(source);
	await mkdir(output);
	await cp(source, output, { recursive: true, dereference: true, filter: path => !/\.(map|log)$/i.test(path) });
	const { files } = await validateWindowsPoppler(output);
	await writeFile(join(output, "notices/provenance.json"), JSON.stringify({ platform: "win32", arch: "x64", build: provenance, files }, null, 2) + "\n");
	await writeFile(join(output, "NOTICE.md"), `# Windows Poppler runtime\n\nPoppler ${poppler.version}, built from the same hash-pinned official source as the macOS route, with the POPPLER_DATADIR patch. Six utilities, codec dependencies, fontconfig and the MSVC runtime are statically linked. PE ordinary and delay imports were checked; only Windows system DLLs are allowed outside this runtime. Encoding/CMap data ${popplerData.version} is in share/poppler. Fontconfig uses Windows system fonts and a user cache.\n\nPoppler licence, source archive, original and modified source, patch and build recipe: notices/poppler. Dependency licences and SPDX records: notices/dependencies. Pinned vcpkg registry, its patches and downloaded source archives: notices/sources. Build inputs and hashes: notices/provenance.json. These materials describe this local build. They do not establish that every redistribution obligation has been fulfilled. Audit corresponding source completeness, build tool and library licence terms, and any source-offer requirements before redistribution. Check's own licence is unchanged.\n\nRequires Windows x64. Static CRT linking avoids a separately installed Visual C++ runtime. System font substitution can differ between Windows versions and installed language features. No fonts are redistributed. Clean-machine and older-Windows compatibility remain separate release checks.\n`);
	return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { "source-install": { type: "string" }, output: { type: "string" } } });
	if (!values["source-install"] || !values.output) throw new Error("Required: --source-install <source-built directory> --output <new directory>");
	console.log(await prepareWindowsPoppler(values["source-install"], values.output));
}
