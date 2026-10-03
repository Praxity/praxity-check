import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
export const windowsJavaPins = Object.freeze({
	java: {
		version: "17.0.20.1+1", directory: "jdk-17.0.20.1+1-jre",
		url: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip",
		sha256: "bc21a93923103cdaac93ee337b0ae4365e739fde36df823dd456bc67c8a9d352",
		checksumUrl: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip.sha256.txt",
		sourceUrl: "https://github.com/adoptium/jdk17u/tree/jdk-17.0.20.1%2B1",
	},
	veraPDF: {
		version: "1.30.2", directory: "verapdf-greenfield-1.30.2",
		url: "https://software.verapdf.org/rel/1.30/verapdf-greenfield-1.30.2-installer.zip",
		sha256: "6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838",
		sourceUrl: "https://github.com/veraPDF/veraPDF-apps/tree/7d9b5c3f709846ab83f86ca1a538b24eac2d3f72",
	},
	licenses: [
		{ name: "LICENSE.GPL", url: "https://raw.githubusercontent.com/veraPDF/veraPDF-apps/7d9b5c3f709846ab83f86ca1a538b24eac2d3f72/LICENSE.GPL", sha256: "d62f065830aa3739cc031156b9690805c7b2e811b4a178c8b4acd8725d561c94" },
		{ name: "LICENSE.MPL", url: "https://raw.githubusercontent.com/veraPDF/veraPDF-apps/7d9b5c3f709846ab83f86ca1a538b24eac2d3f72/LICENSE.MPL", sha256: "af175b9d96ee93c21a036152e1b905b0b95304d4ae8c2c921c7609100ba8df7e" },
	],
});

// The Java launcher is shared by Windows preparation and PDF validation.
export const veraPdfMainClass = "org.verapdf.apps.GreenfieldCliWrapper";

export function veraPdfJavaArgs(classpath: string, args: string[]): string[] {
	if (!classpath.trim()) throw new Error("veraPDF Java classpath must not be empty");
	return ["-Dfile.encoding=UTF8", "--add-exports=java.base/sun.security.pkcs=ALL-UNNAMED", "-classpath", classpath,
		veraPdfMainClass, ...args];
}

export function javaEnvironment(env: NodeJS.ProcessEnv, platform = process.platform): NodeJS.ProcessEnv {
	const blocked = new Set(["CLASSPATH_PREFIX", "JAVA_OPTS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]);
	return Object.fromEntries(Object.entries(env).filter(([key]) => !blocked.has(platform === "win32" ? key.toUpperCase() : key)));
}


export function veraPdfCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, executable: string | undefined, args: string[]) {
 const tool = executable ?? env.VERAPDF ?? "verapdf";
 if (!tool.trim()) throw new Error("veraPDF executable must not be empty");
 const java = platform === "win32" && executable === undefined && (!env.VERAPDF || env.VERAPDF === env.VERAPDF_JAVA) ? env.VERAPDF_JAVA : undefined;
 return java ? { tool: java, args: veraPdfJavaArgs(env.VERAPDF_CLASSPATH ?? "", args) } : { tool, args };
}

export function componentLauncher(platform: string) {
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


export async function browserDefinition() {
 const require = createRequire(import.meta.url);
 const core = createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json");
 const metadata = JSON.parse(await readFile(join(dirname(core), "browsers.json"), "utf8"));
 const browser = metadata.browsers.find((item: { name: string }) => item.name === "chromium-headless-shell");
 if (!browser?.revision || !browser.browserVersion) throw new Error("Playwright metadata must include the Chromium headless-shell revision and version");
 return { ...browser, directory: `chromium_headless_shell-${browser.revision}`, playwright: JSON.parse(await readFile(core, "utf8")).version };
}
export function browserTarget(platform: string, arch: string) {
 if (platform === "darwin" && arch === "arm64") return { directory: "chrome-headless-shell-mac-arm64", executable: "chrome-headless-shell" };
 if (platform === "win32" && arch === "x64") return { directory: "chrome-headless-shell-win64", executable: "chrome-headless-shell.exe" };
 throw new Error(`Runtime assembly supports macOS arm64 and Windows x64 only; received ${platform} ${arch}`);
}
