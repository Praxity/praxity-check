import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { poppler, popplerData, popplerTools, windowsPoppler, patchPopplerData } from "./poppler-inputs.mjs";
import { validateWindowsPayload } from "./windows-pe.mjs";
import { downloadVerified } from "./download-verified.mjs";

export async function buildPopplerWindowsRuntime(values) {
	if (!values.work) throw new Error("Required: --work <external build directory>; optional --cmake <executable>");
	if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Requires Windows x64 and Visual Studio 2022 C++ build tools");
	const work = resolve(values.work), registry = join(work, "vcpkg"), installed = join(work, "vcpkg-installed"), output = join(work, "poppler-install");
	const { baseline, triplet } = windowsPoppler;
	const run = (file, args, options = {}) => execFileSync(file, args, { stdio: "inherit", ...options });
	const hash = bytes => createHash("sha256").update(bytes).digest("hex");
	const tar = join(process.env.SystemRoot, "System32/tar.exe");
	await mkdir(work, { recursive: true });
	// A fixed registry pins dependency versions, source hashes, patches and tool releases.
	try { await readFile(join(registry, "scripts/vcpkg-tools.json")); } catch (error) {
		if (error.code !== "ENOENT") throw error;
		run("git", ["-c", "core.autocrlf=false", "clone", "--depth", "1", "--branch", "2026.07.29", "https://github.com/microsoft/vcpkg.git", registry]);
	}
	const actualBaseline = execFileSync("git", ["-C", registry, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	if (actualBaseline !== baseline || execFileSync("git", ["-C", registry, "status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("vcpkg registry must be the unmodified pinned commit");
	const manifest = { name: "check-poppler-runtime", "version-string": poppler.version, "builtin-baseline": baseline, dependencies: windowsPoppler.dependencies };
	await writeFile(join(work, "vcpkg.json"), JSON.stringify(manifest, null, 2) + "\n");
	await mkdir(join(work, "triplets"), { recursive: true });
	await writeFile(join(work, "triplets", `${triplet}.cmake`), "set(VCPKG_TARGET_ARCHITECTURE x64)\nset(VCPKG_CRT_LINKAGE static)\nset(VCPKG_LIBRARY_LINKAGE static)\nset(VCPKG_BUILD_TYPE release)\n");
	const environment = { ...process.env, VCPKG_DISABLE_METRICS: "1", VCPKG_BINARY_SOURCES: "clear" };
	const toolMetadata = await readFile(join(registry, "scripts/vcpkg-tool-metadata.txt"), "utf8");
	const releaseTag = toolMetadata.match(/^VCPKG_TOOL_RELEASE_TAG=([^\r\n]+)\r?$/m)?.[1];
	// The executable digest belongs to this release; a registry update must update both pins.
	if (releaseTag !== windowsPoppler.tool.releaseTag) throw new Error("vcpkg tool release must match the pinned Windows executable");
	await downloadVerified({ url: `https://github.com/microsoft/vcpkg-tool/releases/download/${releaseTag}/vcpkg.exe`, sha256: windowsPoppler.tool.sha256 }, join(registry, "vcpkg.exe"));
	run(join(registry, "vcpkg.exe"), ["install", "--triplet", triplet, `--overlay-triplets=${join(work, "triplets")}`, `--x-manifest-root=${work}`, `--x-install-root=${installed}`], { env: environment });
	const toolsMetadata = JSON.parse(await readFile(join(registry, "scripts/vcpkg-tools.json"), "utf8"));
	const cmakeTool = toolsMetadata.tools.find(tool => tool.name === "cmake" && tool.os === "windows" && tool.arch === "amd64");
	const cmake = values.cmake ?? join(registry, "downloads/tools", `cmake-${cmakeTool.version}-windows`, cmakeTool.executable);
	const archive = await downloadVerified(poppler, join(work, `poppler-${poppler.version}.tar.xz`));
	const dataArchive = await downloadVerified(popplerData, join(work, `poppler-data-${popplerData.version}.tar.gz`));
	run(tar, ["-xf", archive, "-C", work]);
	run(tar, ["-xf", dataArchive, "-C", work]);
	const source = join(work, `poppler-${poppler.version}`), build = join(work, "poppler-build"), sourceFile = join(source, "poppler/GlobalParams.cc");
	const original = await readFile(sourceFile, "utf8"), modified = patchPopplerData(original);
	await writeFile(sourceFile, modified);
	const flags = ["-G", "Visual Studio 17 2022", "-A", "x64", "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_INSTALL_PREFIX=${output}`, `-DCMAKE_TOOLCHAIN_FILE=${join(registry, "scripts/buildsystems/vcpkg.cmake")}`, `-DVCPKG_TARGET_TRIPLET=${triplet}`, `-DVCPKG_INSTALLED_DIR=${installed}`, `-DVCPKG_OVERLAY_TRIPLETS=${join(work, "triplets")}`, "-DVCPKG_MANIFEST_MODE=OFF", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded", "-DBUILD_SHARED_LIBS=OFF", "-DFONT_CONFIGURATION=fontconfig", "-DENABLE_RELOCATABLE=OFF", "-DPOPPLER_DATADIR=C:/nonexistent/praxity-poppler-data", "-DRUN_GPERF_IF_PRESENT=OFF",
		...["ENABLE_CPP", "ENABLE_GLIB", "ENABLE_QT5", "ENABLE_QT6", "ENABLE_BOOST", "ENABLE_NSS3", "ENABLE_GPGME", "ENABLE_LIBCURL", "BUILD_GTK_TESTS", "BUILD_QT5_TESTS", "BUILD_QT6_TESTS", "BUILD_CPP_TESTS", "BUILD_MANUAL_TESTS", "CMAKE_DISABLE_FIND_PACKAGE_Cairo"].map(name => `-D${name}=${name.startsWith("CMAKE_DISABLE") ? "ON" : "OFF"}`)];
	run(cmake, ["-S", source, "-B", build, ...flags], { env: environment });
	run(cmake, ["--build", build, "--config", "Release", "--target", ...popplerTools, "--parallel", "8"], { env: environment });
	await mkdir(output);
	for (const directory of ["bin", "share/poppler", "etc/fonts", "notices/poppler", "notices/dependencies", "notices/sources"]) await mkdir(join(output, directory), { recursive: true });
	for (const tool of popplerTools) await copyFile(join(build, "utils/Release", `${tool}.exe`), join(output, "bin", `${tool}.exe`));
	for (const directory of ["cMap", "cidToUnicode", "nameToUnicode", "unicodeMap"]) await cp(join(work, `poppler-data-${popplerData.version}`, directory), join(output, "share/poppler", directory), { recursive: true });
	// Fontconfig expands WINDOWSFONTDIR on Windows. No build-machine absolute font paths.
	await writeFile(join(output, "etc/fonts/fonts.conf"), '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n  <dir>WINDOWSFONTDIR</dir>\n  <cachedir prefix="xdg">fontconfig</cachedir>\n</fontconfig>\n');
	const notices = join(output, "notices/poppler");
	for (const name of ["COPYING", "AUTHORS"]) await copyFile(join(source, name), join(notices, name));
	await copyFile(archive, join(notices, `poppler-${poppler.version}.tar.xz`));
	await copyFile(dataArchive, join(notices, `poppler-data-${popplerData.version}.tar.gz`));
	for (const entry of await readdir(join(work, `poppler-data-${popplerData.version}`))) if (/^(COPYING|LICENSE)/.test(entry)) await copyFile(join(work, `poppler-data-${popplerData.version}`, entry), join(notices, `data-${entry}`));
	await writeFile(join(notices, "GlobalParams.cc.original"), original);
	await writeFile(join(notices, "GlobalParams.cc.modified"), modified);
	const diff = spawnSync("git", ["diff", "--no-index", "--no-prefix", join(notices, "GlobalParams.cc.original"), join(notices, "GlobalParams.cc.modified")], { encoding: "utf8" });
	if (diff.status !== 1) throw new Error(`Expected source patch: ${diff.stderr}`);
	await writeFile(join(notices, "poppler-data-env.patch"), diff.stdout);
	for (const name of ["build-poppler-windows-runtime.mjs", "poppler-inputs.mjs", "windows-pe.mjs", "download-verified.mjs"]) await copyFile(new URL(name, import.meta.url), join(notices, name));
	await cp(join(installed, triplet, "share"), join(output, "notices/dependencies"), { recursive: true });
	for (const name of windowsPoppler.packages) {
		if (!(await readFile(join(output, "notices/dependencies", name, "copyright"))).length) throw new Error(`Missing dependency licence: ${name}`);
		await readFile(join(output, "notices/dependencies", name, "vcpkg.spdx.json"));
	}
	await copyFile(join(work, "vcpkg.json"), join(output, "notices/vcpkg.json"));
	await cp(join(work, "triplets"), join(output, "notices/triplets"), { recursive: true });
	run("git", ["-C", registry, "archive", "--format=tar", "-o", join(output, "notices/sources", `vcpkg-${baseline}.tar`), baseline]);
	const retainedArchives = [], downloadedInputs = [];
	for (const entry of await readdir(join(registry, "downloads"), { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const from = join(registry, "downloads", entry.name), bytes = await readFile(from);
		const record = { file: entry.name, sha256: hash(bytes), size: bytes.length };
		downloadedInputs.push(record);
		// Runtime dependency sources are tar archives. Build-tool binaries remain outside the artifact;
		// their download recipes and SHA-512 pins are in the retained vcpkg registry.
		if (!/\.(?:tar\.gz|tar\.xz|tar\.bz2|tgz)$/i.test(entry.name)) continue;
		await copyFile(from, join(output, "notices/sources", entry.name));
		retainedArchives.push(record);
	}
	const pe = await validateWindowsPayload(output, { executables: popplerTools.map(tool => `bin/${tool}.exe`) });
	const resources = [];
	async function resourceFiles(directory) {
		for (const entry of await readdir(join(output, directory), { withFileTypes: true })) {
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) await resourceFiles(path);
			else if (entry.isFile()) resources.push({ path, sha256: hash(await readFile(join(output, path))) });
			else throw new Error(`Unexpected Poppler data entry: ${path}`);
		}
	}
	await resourceFiles("share/poppler");
	await resourceFiles("etc/fonts");
	const registryArchive = { file: `vcpkg-${baseline}.tar`, sha256: hash(await readFile(join(output, "notices/sources", `vcpkg-${baseline}.tar`))) };
	const cmakeVersion = execFileSync(cmake, ["--version"], { encoding: "utf8" }).trim();
	const compilerConfig = await readFile(join(build, "CMakeFiles", cmakeVersion.match(/^cmake version ([\d.]+)/)[1], "CMakeCXXCompiler.cmake"), "utf8");
	const compilerPath = compilerConfig.match(/set\(CMAKE_CXX_COMPILER "([^"]+)"\)/)?.[1];
	if (!compilerPath?.includes("/VC/Tools/MSVC/")) throw new Error("Expected MSVC compiler metadata");
	const visualStudio = compilerPath.split("/VC/Tools/MSVC/")[0];
	const sdkVersion = (await readFile(join(build, "poppler.vcxproj"), "utf8")).match(/<WindowsTargetPlatformVersion>([^<]+)</)?.[1];
	if (!sdkVersion) throw new Error("Missing Windows SDK version");
	const sdk = process.env.WindowsSdkDir ?? join(process.env["ProgramFiles(x86)"], "Windows Kits/10");
	const compilerNotices = join(output, "notices/toolchain");
	await mkdir(compilerNotices);
	const toolchainNotices = [];
	for (const [from, name] of [
		[join(visualStudio, "Licenses/BuildTools/1033/ThirdPartyNotices.txt"), "BuildTools-ThirdPartyNotices.txt"],
		[join(visualStudio, "Licenses/1033/Redist.txt"), "Redist.txt"],
		[join(sdk, "Licenses", sdkVersion, "sdk_license.rtf"), "sdk_license.rtf"],
		[join(sdk, "Licenses", sdkVersion, "sdk_third_party_notices.rtf"), "sdk_third_party_notices.rtf"],
	]) {
		const bytes = await readFile(from);
		if (!bytes.length) throw new Error(`Missing toolchain licence/notice: ${from}`);
		await copyFile(from, join(compilerNotices, name));
		toolchainNotices.push({ file: name, source: from, sha256: hash(bytes) });
	}
	await writeFile(join(compilerNotices, "CMakeCXXCompiler.cmake"), compilerConfig);
	const compiler = { version: compilerConfig.match(/set\(CMAKE_CXX_COMPILER_VERSION "([^"]+)"\)/)?.[1], sha256: hash(await readFile(compilerPath)), sdkVersion, notices: toolchainNotices,
		licenseUrl: "https://visualstudio.microsoft.com/license-terms/vs2022-ga-diagnosticbuildtools/", redistributableUrl: "https://aka.ms/vs/17/redist.txt" };
	const provenance = { platform: "win32", arch: "x64", poppler, popplerData, flags, tools: popplerTools, vcpkg: { baseline, triplet, manifest, releaseTag, version: execFileSync(join(registry, "vcpkg.exe"), ["version"], { encoding: "utf8" }).trim(), sha256: hash(await readFile(join(registry, "vcpkg.exe"))) }, cmake: { version: cmakeVersion, sha256: hash(await readFile(cmake)) }, compiler, retainedArchives, registryArchive, resources, downloadedInputs, pe, modification: "GlobalParams uses POPPLER_DATADIR when no explicit data directory is supplied. GPL-2.0-or-later, same terms as GlobalParams.cc." };
	await writeFile(join(notices, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
	console.log(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: Object.fromEntries(["work", "cmake"].map(name => [name, { type: "string" }])) });
	await buildPopplerWindowsRuntime(values);
}
