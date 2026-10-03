import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { javaEnvironment, veraPdfJavaArgs, veraPdfMainClass } from "../src/verapdf-runtime.ts";
import { validateWindowsPayload } from "./windows-pe.mjs";
import { downloadVerified } from "./download-verified.mjs";

export { windowsJavaPins } from "../src/components.ts";
import { windowsJavaPins } from "../src/components.ts";
const run = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: javaEnvironment(process.env, "win32"), timeout: 120_000 }).trim();
const powershellLiteral = value => "'" + value.replaceAll("'", "''") + "'";

function extractArchive(archive, output) {
	// These are hash-verified official archives. EncodedCommand preserves literal paths.
	const command = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath ${powershellLiteral(archive)} -DestinationPath ${powershellLiteral(output)}`;
	run(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]);
}

export async function validateWindowsJava(java, verapdf, { runCommand = run } = {}) {
	const release = await readFile(join(java, "release"), "utf8");
	if (!/OS_ARCH="x86_64"/.test(release) || !/OS_NAME="Windows"/.test(release)) throw new Error("Java must target Windows x64");
	if (!release.includes(`JAVA_RUNTIME_VERSION="${windowsJavaPins.java.version}"`)
		|| !/IMPLEMENTOR="Eclipse Adoptium"/.test(release) || !/IMAGE_TYPE="JRE"/.test(release)) throw new Error("Java must be the pinned Eclipse Temurin JRE");
	for (const file of ["legal/java.base/LICENSE", "legal/java.base/ASSEMBLY_EXCEPTION", "NOTICE"]) {
		if (!(await readFile(join(java, file))).length) throw new Error(`Java legal file is empty: ${file}`);
	}
	for (const file of ["LICENSE.GPL", "LICENSE.MPL"]) if (!(await readFile(join(verapdf, file))).length) throw new Error(`veraPDF legal file is empty: ${file}`);
	const jar = `cli-${windowsJavaPins.veraPDF.version}.jar`;
	if (!(await stat(join(verapdf, "bin", jar))).isFile()) throw new Error("veraPDF CLI jar must be a regular file");
	const jars = (await readdir(join(verapdf, "bin"))).filter(name => name.endsWith(".jar"));
	if (jars.length !== 1 || jars[0] !== jar) throw new Error("veraPDF runtime must contain only the pinned CLI jar");
	const imports = await validateWindowsPayload(java, { executables: ["bin/java.exe"] });
	const javaVersion = runCommand(join(java, "bin/java.exe"), ["--version"]);
	if (!javaVersion.split(/\s+/).includes(`Temurin-${windowsJavaPins.java.version}`)) throw new Error("Java binary version does not match the pinned JRE");
	const veraPDFVersion = runCommand(join(java, "bin/java.exe"), veraPdfJavaArgs(join(verapdf, "bin", "*"), ["--version"]));
	if (veraPDFVersion.split(/\r?\n/)[0] !== `veraPDF ${windowsJavaPins.veraPDF.version}`) throw new Error("veraPDF binary version does not match the pinned CLI");
	return { java: javaVersion, veraPDF: veraPDFVersion, javaRelease: release, imports };
}

const xmlEscape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export async function prepareWindowsJava({ work: workValue, output: outputValue }) {
	if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Java preparation requires Windows x64");
	if (!workValue || !outputValue) throw new Error("Required: --work <external directory> --output <new directory>");
	const work = resolve(workValue), output = resolve(outputValue);
	await mkdir(work, { recursive: true });
	await mkdir(output);
	const downloads = join(work, "downloads");
	await mkdir(downloads, { recursive: true });
	const staging = await mkdtemp(join(work, "staging-"));
	for (const input of [windowsJavaPins.java, windowsJavaPins.veraPDF, ...windowsJavaPins.licenses]) await downloadVerified(input, join(downloads, input.name ?? basename(new URL(input.url).pathname)));
	extractArchive(join(downloads, basename(new URL(windowsJavaPins.java.url).pathname)), join(staging, "java"));
	extractArchive(join(downloads, basename(new URL(windowsJavaPins.veraPDF.url).pathname)), join(staging, "installer"));
	const java = join(output, "java"), verapdf = join(output, "verapdf");
	await cp(join(staging, "java", windowsJavaPins.java.directory), java, { recursive: true });
	const installed = join(staging, "verapdf");
	const config = join(staging, "auto-install.xml");
	await writeFile(config, `<?xml version="1.0" encoding="UTF-8"?>
<AutomatedInstallation langpack="eng">
<com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
<com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>${xmlEscape(installed)}</installpath></com.izforge.izpack.panels.target.TargetPanel>
<com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
<pack index="0" name="veraPDF GUI" selected="false"/>
<pack index="1" name="veraPDF CLI" selected="true"/>
<pack index="2" name="veraPDF Documentation" selected="false"/>
<pack index="3" name="veraPDF Sample Plugins" selected="false"/>
</com.izforge.izpack.panels.packs.PacksPanel>
<com.izforge.izpack.panels.install.InstallPanel id="install"/>
<com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
`);
	const installerLog = run(join(java, "bin/java.exe"), ["-jar", join(staging, "installer", windowsJavaPins.veraPDF.directory, `verapdf-izpack-installer-${windowsJavaPins.veraPDF.version}.jar`), config]);
	if (!installerLog.includes("Automated installation done")) throw new Error("veraPDF automated installation did not complete");
	await mkdir(join(verapdf, "bin"), { recursive: true });
	await copyFile(join(installed, "bin", `cli-${windowsJavaPins.veraPDF.version}.jar`), join(verapdf, "bin", `cli-${windowsJavaPins.veraPDF.version}.jar`));
	for (const input of windowsJavaPins.licenses) await copyFile(join(downloads, input.name), join(verapdf, input.name));
	const versions = await validateWindowsJava(java, verapdf);
	for (const [directory, pin] of [[java, windowsJavaPins.java], [verapdf, windowsJavaPins.veraPDF]]) {
		await mkdir(join(directory, "notices"));
		await writeFile(join(directory, "notices/provenance.json"), JSON.stringify({ ...pin, platform: "win32", arch: "x64", ...(directory === verapdf ? { licenses: windowsJavaPins.licenses, mainClass: veraPdfMainClass } : {}) }, null, 2) + "\n");
		for (const [source, target] of [[import.meta.url, "scripts/prepare-windows-java.mjs"], [new URL("./download-verified.mjs", import.meta.url), "scripts/download-verified.mjs"], [new URL("./windows-pe.mjs", import.meta.url), "scripts/windows-pe.mjs"], [new URL("../src/verapdf-runtime.ts", import.meta.url), "src/verapdf-runtime.ts"]]) {
			const path = join(directory, "notices/recipe", target);
			await mkdir(join(path, ".."), { recursive: true });
			await copyFile(fileURLToPath(source), path);
		}
	}
	await writeFile(join(output, "runtime-versions.json"), JSON.stringify({ platform: "win32", arch: "x64", ...versions, pins: windowsJavaPins }, null, 2) + "\n");
	await writeFile(join(output, "NOTICE.md"), `# Windows Java and veraPDF runtime\n\nEclipse Temurin JRE ${windowsJavaPins.java.version}, Windows x64. License and third-party notices remain in java/legal and java/NOTICE.\n\nveraPDF ${windowsJavaPins.veraPDF.version}. Project licenses are verapdf/LICENSE.GPL and verapdf/LICENSE.MPL; embedded dependency notices remain in verapdf/bin/cli-${windowsJavaPins.veraPDF.version}.jar.\n\nOfficial download URLs, SHA-256 pins and source URLs are retained in each payload's notices/provenance.json. Preparation runs the official installer into an external staging directory and copies its CLI jar. No installer scripts execute in the packaged application.\n`);
	return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { work: { type: "string" }, output: { type: "string" } } });
	console.log(await prepareWindowsJava(values));
}
