import * as nodeFs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
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

export type ComponentId = "browser" | "java" | "verapdf";
export type Archive = { url: string; sha256: string; size: number };
export type Component = { id: ComponentId; version: string; purpose: string; license: string; checks: string[]; archives: Archive[]; entryPoint: string };
export type ComponentResolution = { id: ComponentId; usable: boolean; source: "explicit" | "setup" | "system" | null; path: string | null; version: string | null; pinned: boolean | null; inventory: "intact" | "damaged" | "absent" | "unmanaged"; reason?: string; classpath?: string };
export type ComponentHost = { env: NodeJS.ProcessEnv; platform: string; arch: string; home: string; fs: typeof nodeFs;
 run: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string; code: number | null }> };

export function componentHost(overrides: Partial<ComponentHost> = {}): ComponentHost {
 const exec = promisify(execFile);
 return { env: process.env, platform: process.platform, arch: process.arch, home: homedir(), fs: nodeFs,
  run: async (file, args, env) => {
   try { const result = await exec(file, args, { env, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }); return { ...result, code: 0 }; }
   catch (error) { const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }; return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, code: typeof e.code === "number" ? e.code : null }; }
  }, ...overrides };
}

function variable(host: ComponentHost, key: string) {
 return host.platform === "win32" ? Object.entries(host.env).find(([name]) => name.toUpperCase() === key)?.[1] : host.env[key];
}

export function componentsDirectory(host: Pick<ComponentHost, "env" | "platform" | "home">): string {
 if (host.env.CHECK_COMPONENTS_DIR) return resolve(host.env.CHECK_COMPONENTS_DIR);
 if (host.platform === "win32") return join(host.env.LOCALAPPDATA ?? join(host.home, "AppData", "Local"), "Praxity", "Check", "components");
 if (host.platform === "darwin") return join(host.home, "Library", "Application Support", "Praxity Check", "components");
 return join(host.env.XDG_DATA_HOME ?? join(host.home, ".local", "share"), "praxity-check", "components");
}

// Each hash was checked against Adoptium's adjacent .sha256.txt release asset.
// Source: https://github.com/adoptium/temurin17-binaries/releases/tag/jdk-17.0.20.1%2B1
const javaTargets: Record<string, { file: string; sha256: string; size: number }> = {
 "win32-x64": { file: "OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip", sha256: windowsJavaPins.java.sha256, size: 43780109 },
 "darwin-arm64": { file: "OpenJDK17U-jre_aarch64_mac_hotspot_17.0.20.1_1.tar.gz", sha256: "190480874ccceb358cbc840393207f77ac3e63a4c5f8129d0e23e9518b96ad05", size: 42722113 },
 "darwin-x64": { file: "OpenJDK17U-jre_x64_mac_hotspot_17.0.20.1_1.tar.gz", sha256: "333cb81123c36568586646c73c8fa2326dab8badc43f5ea388a90fff59c9df27", size: 37635516 },
 "linux-x64": { file: "OpenJDK17U-jre_x64_linux_hotspot_17.0.20.1_1.tar.gz", sha256: "0b2b640e3046b64c8ec504de0ab9d91bb5610182bda21fad454681ce54d45a62", size: 46640574 },
 "linux-arm64": { file: "OpenJDK17U-jre_aarch64_linux_hotspot_17.0.20.1_1.tar.gz", sha256: "b8efcd5acc9109fe8d35bed132499643048a257b4f6042906ece37d03c839d77", size: 45989435 },
};

export async function componentManifest(host: Pick<ComponentHost, "platform" | "arch">): Promise<Component[]> {
 const java = javaTargets[`${host.platform}-${host.arch}`];
 if (!java) throw new Error(`Unsupported components target: ${host.platform} ${host.arch}`);
 const browser = await browserDefinition();
 if (browser.revision !== "1234" || browser.playwright !== "1.62.1") throw new Error("Playwright changed; update the verified browser archive pins before setup.");
 const target = browserTarget(host.platform, host.arch);
 const shell = browserArchives[host.platform === "win32" ? 0 : host.platform === "darwin" ? host.arch === "arm64" ? 1 : 2 : host.arch === "x64" ? 3 : 4]!;
 const ffmpeg = browserArchives[host.platform === "win32" ? 5 : host.platform === "darwin" ? 6 : host.arch === "x64" ? 7 : 8]!;
 return [
  { id: "browser", version: browser.browserVersion, purpose: "HTML accessibility audits and interaction evidence", license: "BSD and bundled notices; FFmpeg LGPL-2.1+", checks: ["html"], archives: [shell, ffmpeg, ...(host.platform === "win32" ? [browserArchives[9]!] : [])], entryPoint: `${browser.directory}/${target.directory}/${target.executable}` },
  { id: "java", version: windowsJavaPins.java.version, purpose: "Run the veraPDF PDF/UA validator", license: "GPL-2.0 with Classpath Exception", checks: ["pdf"], archives: [{ url: new URL(java.file, windowsJavaPins.java.url).href, sha256: java.sha256, size: java.size }], entryPoint: `${windowsJavaPins.java.directory}/${host.platform === "darwin" ? "Contents/Home/" : ""}bin/java${host.platform === "win32" ? ".exe" : ""}` },
  { id: "verapdf", version: windowsJavaPins.veraPDF.version, purpose: "PDF/UA-1 and PDF/UA-2 machine validation", license: "GPL-3.0+ or MPL-2.0+", checks: ["pdf"], archives: [{ ...windowsJavaPins.veraPDF, size: 32923960 }], entryPoint: `payload/bin/cli-${windowsJavaPins.veraPDF.version}.jar` },
 ];
}

export function componentDirectory(host: Pick<ComponentHost, "env" | "platform" | "home">, component: Pick<Component, "id" | "version">) {
 return join(componentsDirectory(host), component.id, component.version);
}

const inventoryName = ".inventory.json";
export async function fileInventory(root: string, fs: typeof nodeFs) {
 if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("Component root is a symlink");
 const files: Record<string, string> = {};
 async function walk(directory: string, prefix = "") {
  for (const name of (await fs.readdir(directory)).sort()) {
   if (!prefix && name === inventoryName) continue;
   const path = join(directory, name), info = await fs.lstat(path);
   if (info.isSymbolicLink()) throw new Error(`Component contains a symlink: ${prefix}${name}`);
   if (info.isDirectory()) await walk(path, `${prefix}${name}/`);
   else if (info.isFile()) files[`${prefix}${name}`] = createHash("sha256").update(await fs.readFile(path)).digest("hex");
   else throw new Error(`Component contains a non-regular file: ${prefix}${name}`);
  }
 }
 await walk(root);
 return files;
}

export async function writeInventory(root: string, component: Component, host: ComponentHost) {
 const files = await fileInventory(root, host.fs);
 if (!files[component.entryPoint]) throw new Error(`Component entry point missing: ${component.entryPoint}`);
 await host.fs.writeFile(join(root, inventoryName), JSON.stringify({ schemaVersion: 1, id: component.id, version: component.version, platform: host.platform, arch: host.arch, files }, null, 2), { flag: "wx" });
}

export async function checkInventory(root: string, component: Component, host: ComponentHost): Promise<"intact" | "damaged" | "absent"> {
 let raw: string;
 try { if ((await host.fs.lstat(join(root, inventoryName))).isSymbolicLink()) return "damaged"; raw = await host.fs.readFile(join(root, inventoryName), "utf8"); }
 catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw e; }
 try {
  const record = JSON.parse(raw);
  if (record.schemaVersion !== 1 || record.id !== component.id || record.version !== component.version || record.platform !== host.platform || record.arch !== host.arch) return "damaged";
  const actual = await fileInventory(root, host.fs);
  if (!actual[component.entryPoint] || !record.files || typeof record.files !== "object") return "damaged";
  const keys = Object.keys(actual).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(record.files).sort()) && keys.every(key => actual[key] === record.files[key]) ? "intact" : "damaged";
 } catch (e) { if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === "ENOENT" || (e instanceof Error && /symlink|non-regular/.test(e.message))) return "damaged"; throw e; }
}

async function executablePath(host: ComponentHost, value: string) {
 const candidates = /[\\/]/.test(value) ? [resolve(value)] : (variable(host, "PATH") ?? "").split(host.platform === "win32" ? ";" : ":").filter(Boolean).flatMap(dir => host.platform === "win32" ? [join(dir, value), ...[".exe", ".cmd", ".bat"].map(ext => join(dir, value + ext))] : [join(dir, value)]);
 for (const path of candidates) {
  try { if ((await host.fs.stat(path)).isFile()) return path; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e; }
 }
 return null;
}

export async function resolveComponent(host: ComponentHost, id: ComponentId, explicit?: string): Promise<ComponentResolution> {
 const component = (await componentManifest(host)).find(item => item.id === id)!;
 const missing = (inventory: ComponentResolution["inventory"] = "absent", path: string | null = null): ComponentResolution => ({ id, usable: false, source: null, path, version: null, pinned: null, inventory, reason: `${id === "browser" ? "Browser" : id === "java" ? "Java 17 or newer" : "veraPDF"} is ${inventory === "damaged" ? "damaged" : "not installed"}; checks not run. Run check setup ${component.checks.join(" ")}.` });
 let value = explicit;
 let classpath: string | undefined;
 if (id === "verapdf") {
  if (!value && host.platform === "win32" && (!variable(host, "VERAPDF") || variable(host, "VERAPDF") === variable(host, "VERAPDF_JAVA"))) { value = variable(host, "VERAPDF_JAVA"); classpath = value ? variable(host, "VERAPDF_CLASSPATH") : undefined; }
  value ??= variable(host, "VERAPDF");
 }
 if (id === "java") value ??= variable(host, "VERAPDF_JAVA") ?? variable(host, "JAVACMD") ?? (variable(host, "JAVA_HOME") ? join(variable(host, "JAVA_HOME")!, "bin", host.platform === "win32" ? "java.exe" : "java") : undefined);
 if (id === "browser" && !value && variable(host, "PLAYWRIGHT_BROWSERS_PATH")) {
  const cache = variable(host, "PLAYWRIGHT_BROWSERS_PATH")!;
  if (cache === "0") { const require = createRequire(import.meta.url); value = join(dirname(createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json")), ".local-browsers", component.entryPoint); }
  else value = join(cache, component.entryPoint);
 }
 async function found(path: string, source: "explicit" | "setup" | "system", inventory: ComponentResolution["inventory"], known?: string): Promise<ComponentResolution> {
  let version = known ?? null;
  if (!version) {
   const result = await host.run(path, classpath ? veraPdfJavaArgs(classpath, ["--version"]) : ["--version"], javaEnvironment(host.env, host.platform as NodeJS.Platform));
   const output = result.stdout + "\n" + result.stderr;
   version = id === "java" ? output.match(/(?:openjdk|java)\s+(?:version\s+)?"?([\d.]+(?:\+\d+)?)/i)?.[1] ?? null : id === "verapdf" ? output.match(/veraPDF\s+([\d.]+)/)?.[1] ?? null : output.match(/(?:Chromium|Chrome[^\r\n]*?)\s+([\d.]+)/)?.[1] ?? null;
   if (id === "java" && (!version || Number(version.split(".")[0]) < 17 || result.code !== 0)) return { ...missing(inventory, path), source, version, pinned: false };
  }
  return { id, usable: true, source, path, version, pinned: version === null ? null : version === component.version, inventory, ...(classpath ? { classpath } : {}) };
 }
 if (value !== undefined) {
  if (!value.trim()) throw new Error(`${id} executable must not be empty`);
  const path = await executablePath(host, value);
  return path ? found(path, "explicit", "unmanaged") : { ...missing("unmanaged", value), source: "explicit" };
 }
 const managed = componentDirectory(host, component);
 const inventory = await checkInventory(managed, component, host);
 if (inventory === "intact") {
  if (id === "verapdf") {
   const java = await resolveComponent(host, "java");
   return { id, usable: java.usable, source: "setup", path: join(managed, component.entryPoint), version: component.version, pinned: true, inventory, classpath: join(managed, "payload", "bin", "*"), ...(java.usable ? {} : { reason: java.reason }) };
  }
  return found(join(managed, component.entryPoint), "setup", inventory, id === "browser" ? undefined : component.version);
 }
 if (id === "java" || id === "verapdf") {
  const path = await executablePath(host, id === "java" ? "java" : "verapdf");
  if (path) return { ...await found(path, "system", "unmanaged"), ...(inventory === "damaged" ? { inventory } : {}) };
 }
 // Existing developer Playwright caches remain usable without requiring setup.
 if (id === "browser") {
  const cache = host.platform === "win32" ? join(variable(host, "LOCALAPPDATA") ?? join(host.home, "AppData", "Local"), "ms-playwright") : host.platform === "darwin" ? join(host.home, "Library", "Caches", "ms-playwright") : join(variable(host, "XDG_CACHE_HOME") ?? join(host.home, ".cache"), "ms-playwright");
  const path = await executablePath(host, join(cache, component.entryPoint));
  if (path) return { ...await found(path, "explicit", "unmanaged"), ...(inventory === "damaged" ? { inventory } : {}) };
 }
 return missing(inventory, inventory === "damaged" ? managed : null);
}

export async function doctor(host: ComponentHost, checks = ["pdf", "html"]) {
 if (checks.some(check => !["pdf", "html"].includes(check))) throw new Error("Doctor checks: pdf, html");
 const manifest = await componentManifest(host);
 const components = await Promise.all(manifest.map(item => resolveComponent(host, item.id)));
 return { components, exitCode: components.every(item => !manifest.find(def => def.id === item.id)!.checks.some(check => checks.includes(check)) || item.usable) ? 0 : 1 };
}

export async function doctorCli(args: string[], host = componentHost(), print: (text: string) => void = console.log): Promise<number> {
 if (args.some(arg => arg.startsWith("-") && arg !== "--json")) throw new Error("Doctor options: --json, pdf, html");
 const checks = args.filter(arg => arg !== "--json");
 const result = await doctor(host, checks.length ? checks : undefined);
 print(args.includes("--json") ? JSON.stringify(result, null, 2) : result.components.map(item => `${item.id}: ${item.usable ? "found" : "missing"} | ${item.path ?? "no location"} | version ${item.version ?? "unknown"} | pinned ${item.pinned ?? "unknown"} | inventory ${item.inventory} | ${item.source ?? "missing"}${item.reason ? " | " + item.reason : ""}`).join("\n"));
 return result.exitCode;
}
export function browserTarget(platform: string, arch: string) {
 if (platform === "darwin" && ["x64", "arm64"].includes(arch)) return { directory: `chrome-headless-shell-mac-${arch}`, executable: "chrome-headless-shell" };
 if (platform === "linux" && arch === "x64") return { directory: "chrome-headless-shell-linux64", executable: "chrome-headless-shell" };
 if (platform === "linux" && arch === "arm64") return { directory: "chrome-linux", executable: "headless_shell" };
 if (platform === "win32" && arch === "x64") return { directory: "chrome-headless-shell-win64", executable: "chrome-headless-shell.exe" };
 throw new Error(`Runtime assembly supports macOS arm64 and Windows x64 only; received ${platform} ${arch}`);
}

// SHA-256 measured from the official archives selected by Playwright 1.62.1.
const browserArchives: Archive[] = [
  {
    "url": "https://cdn.playwright.dev/builds/cft/151.0.7922.34/win64/chrome-headless-shell-win64.zip",
    "sha256": "46cc69ef55ba29268ffe32dda4192a9d2165be42c3f4e923241153d519493aea",
    "size": 120106945
  },
  {
    "url": "https://cdn.playwright.dev/builds/cft/151.0.7922.34/mac-arm64/chrome-headless-shell-mac-arm64.zip",
    "sha256": "cb46a336dbe3d6f1339c5039c3083e4e5dd8e4379710790e34f8f4a865e2452d",
    "size": 99275008
  },
  {
    "url": "https://cdn.playwright.dev/builds/cft/151.0.7922.34/mac-x64/chrome-headless-shell-mac-x64.zip",
    "sha256": "608e2b5b1815b45e8bf59c9a381412b62df3ce36f2c182bc04e22fcf04ad53ea",
    "size": 103580477
  },
  {
    "url": "https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip",
    "sha256": "3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14",
    "size": 120231126
  },
  {
    "url": "https://cdn.playwright.dev/builds/chromium/1234/chromium-headless-shell-linux-arm64.zip",
    "sha256": "b03443e1e1a60d06e07b6cdfe650b8c2bfcbb3db497d2b652f73dc6912f4ae15",
    "size": 116380215
  },
  {
    "url": "https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-win64.zip",
    "sha256": "8d08827c019ad36e7b9d49d3648447d884534cb2acf200e71c715f6dd834cc50",
    "size": 1411741
  },
  {
    "url": "https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-mac.zip",
    "sha256": "17ed15a2fa60d3c74181befcb2bdf7c9bb288d19b2a3b9893b94b63f2ce260e4",
    "size": 1353430
  },
  {
    "url": "https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-linux.zip",
    "sha256": "ebc74fc5b94830176a3c2914ae96bd8bc7f6a91f4f33890230f84a172ee61ccc",
    "size": 2376500
  },
  {
    "url": "https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-linux-arm64.zip",
    "sha256": "2628c03f05318ff812c8c9baaf207dea2ddf53e818c0dc936714b0fbe3afb009",
    "size": 1717234
  },
  {
    "url": "https://cdn.playwright.dev/builds/winldd/1007/winldd-win64.zip",
    "sha256": "0069f0d11d4ad6df068a068c003d22fe7dbec192a47bba64b2e115e9c8ce41d8",
    "size": 128684
  }
];
