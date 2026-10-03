import * as nodeFs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { constants as nodeFsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, cpus, release } from "node:os";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
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

// Preserve main's validator policy: POSIX wrappers consume inherited JVM options.
export function veraPdfEnvironment(env: NodeJS.ProcessEnv, platform: string): NodeJS.ProcessEnv {
 return platform === "win32" ? javaEnvironment(env, "win32") : env;
}


// Check's original pdf-accessibility.ts and package launchers select direct Java only on Windows.
// An executable flag always selects a wrapper. Empty environment values mean no selection.
function validatorSelection(host: Pick<ComponentHost, "env" | "platform">, executable?: string) {
 const validator = variable(host, "VERAPDF") || undefined;
 const java = variable(host, "VERAPDF_JAVA") || undefined;
 const direct = executable === undefined && host.platform === "win32" && !!java && (!validator || validator === java);
 return { value: executable ?? (direct ? java : validator), direct,
  classpath: direct ? variable(host, "VERAPDF_CLASSPATH") : undefined };
}

export function veraPdfCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, executable: string | undefined, args: string[]) {
 const selection = validatorSelection({ env, platform }, executable), tool = selection.value ?? "verapdf";
 if (!tool.trim()) throw new Error("veraPDF executable must not be empty");
 return { tool, args: selection.direct ? veraPdfJavaArgs(selection.classpath ?? "", args) : args };
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
export type ComponentHost = { env: NodeJS.ProcessEnv; platform: string; arch: string; home: string; cwd: string; cpuModels: string[]; osRelease: string; path: typeof nodePath; fs: typeof nodeFs;
 run: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string; code: number | null }> };

export function componentHost(overrides: Partial<ComponentHost> = {}): ComponentHost {
 const exec = promisify(execFile);
 return { env: process.env, platform: process.platform, arch: process.arch, home: homedir(), cwd: process.cwd(), cpuModels: cpus().map(cpu => cpu.model), osRelease: release(), path: nodePath, fs: nodeFs,
  run: async (file, args, env) => {
   try { const result = await exec(file, args, { env, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }); return { ...result, code: 0 }; }
   catch (error) { const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }; return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, code: typeof e.code === "number" ? e.code : null }; }
  }, ...overrides };
}

function variable(host: Pick<ComponentHost, "env" | "platform">, key: string) {
 return host.platform === "win32" ? Object.entries(host.env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1] : host.env[key];
}

export function componentsDirectory(host: Pick<ComponentHost, "env" | "platform" | "home"> & Partial<Pick<ComponentHost, "path">>): string {
 const { join, resolve } = host.path ?? nodePath;
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

async function componentDefinitions(host: Pick<ComponentHost, "platform" | "arch"> & Partial<Pick<ComponentHost, "env" | "cpuModels" | "osRelease">>): Promise<Component[]> {
 const browser = await browserDefinition(), target = browserLayout(host.platform, host.arch, variable({ env: host.env ?? {}, platform: host.platform }, "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE"), host.osRelease, host.cpuModels);
 return [
  { id: "browser", version: browser.browserVersion, purpose: "HTML accessibility audits and interaction evidence", license: "BSD and bundled notices; FFmpeg LGPL-2.1+", checks: ["html"], archives: [], entryPoint: target ? `${browser.directory}/${target.directory}/${target.executable}` : "" },
  { id: "java", version: windowsJavaPins.java.version, purpose: "Run the veraPDF PDF/UA validator", license: "GPL-2.0 with Classpath Exception", checks: ["pdf"], archives: [], entryPoint: `${windowsJavaPins.java.directory}/${host.platform === "darwin" ? "Contents/Home/" : ""}bin/java${host.platform === "win32" ? ".exe" : ""}` },
  { id: "verapdf", version: windowsJavaPins.veraPDF.version, purpose: "PDF/UA-1 and PDF/UA-2 machine validation", license: "GPL-3.0+ or MPL-2.0+", checks: ["pdf"], archives: [], entryPoint: `payload/bin/cli-${windowsJavaPins.veraPDF.version}.jar` },
 ];
}

export async function componentManifest(host: Pick<ComponentHost, "platform" | "arch">): Promise<Component[]> {
 const java = javaTargets[`${host.platform}-${host.arch}`];
 if (!java) throw new Error(`Unsupported components target: ${host.platform} ${host.arch}`);
 const browser = await browserDefinition();
 if (browser.revision !== "1234" || browser.playwright !== "1.62.1") throw new Error("Playwright changed; update the verified browser archive pins before setup.");
 browserTarget(host.platform, host.arch);
 const shell = browserArchives[host.platform === "win32" ? 0 : host.platform === "darwin" ? host.arch === "arm64" ? 1 : 2 : host.arch === "x64" ? 3 : 4]!;
 const ffmpeg = browserArchives[host.platform === "win32" ? 5 : host.platform === "darwin" ? 6 : host.arch === "x64" ? 7 : 8]!;
 const archives: Record<ComponentId, Archive[]> = {
  browser: [shell, ffmpeg, ...(host.platform === "win32" ? [browserArchives[9]!] : [])],
  java: [{ url: new URL(java.file, windowsJavaPins.java.url).href, sha256: java.sha256, size: java.size }],
  verapdf: [{ ...windowsJavaPins.veraPDF, size: 32923960 }],
 };
 return (await componentDefinitions({ platform: host.platform, arch: host.arch })).map(component => ({ ...component, archives: archives[component.id] }));
}

export function componentDirectory(host: Pick<ComponentHost, "env" | "platform" | "home"> & Partial<Pick<ComponentHost, "path">>, component: Pick<Component, "id" | "version">) {
 return (host.path ?? nodePath).join(componentsDirectory(host), component.id, component.version);
}

const inventoryName = ".inventory.json";
class ComponentAccessError extends Error {
 readonly path: string;
 readonly source: ComponentResolution["source"];
 readonly inventory: ComponentResolution["inventory"];
 constructor(path: string, source: ComponentResolution["source"], inventory: ComponentResolution["inventory"], error: NodeJS.ErrnoException) {
  super(`${error.code}: ${error.message}`, { cause: error });
  this.path = path; this.source = source; this.inventory = inventory;
 }
}

function filesystemFailure(error: unknown, path: string, source: ComponentResolution["source"], inventory: ComponentResolution["inventory"]): never {
 const failure = error as NodeJS.ErrnoException;
 if (["EACCES", "EPERM", "EIO", "ELOOP", "EBUSY", "ENAMETOOLONG", "EMFILE", "ENFILE", "ESTALE", "ETIMEDOUT"].includes(failure.code ?? ""))
  throw new ComponentAccessError(failure.path ?? path, source, inventory, failure);
 throw error;
}

export async function fileInventory(root: string, fs: typeof nodeFs, path = nodePath) {
 const { join } = path;
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
 const { join } = host.path;
 const files = await fileInventory(root, host.fs, host.path);
 if (!files[component.entryPoint]) throw new Error(`Component entry point missing: ${component.entryPoint}`);
 await host.fs.writeFile(join(root, inventoryName), JSON.stringify({ schemaVersion: 1, id: component.id, version: component.version, platform: host.platform, arch: host.arch, files }, null, 2), { flag: "wx" });
}

export async function checkInventory(root: string, component: Component, host: ComponentHost): Promise<"intact" | "damaged" | "absent"> {
 const { join } = host.path;
 let raw: string;
 try { if ((await host.fs.lstat(join(root, inventoryName))).isSymbolicLink()) return "damaged"; raw = await host.fs.readFile(join(root, inventoryName), "utf8"); }
 catch (e) { if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return "absent"; filesystemFailure(e, join(root, inventoryName), "setup", "damaged"); }
 try {
  const record = JSON.parse(raw);
  if (record.schemaVersion !== 1 || record.id !== component.id || record.version !== component.version || record.platform !== host.platform || record.arch !== host.arch) return "damaged";
  const actual = await fileInventory(root, host.fs, host.path);
  if (!actual[component.entryPoint] || !record.files || typeof record.files !== "object") return "damaged";
  const keys = Object.keys(actual).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(record.files).sort()) && keys.every(key => actual[key] === record.files[key]) ? "intact" : "damaged";
 } catch (e) { if (e instanceof SyntaxError || ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "") || (e instanceof Error && /symlink|non-regular/.test(e.message))) return "damaged"; filesystemFailure(e, root, "setup", "damaged"); }
}

// Playwright packages/utils/env.ts: only undefined falls through to npm aliases.
function playwrightVariable(host: ComponentHost, key: string) {
 return variable(host, key) ?? variable(host, `npm_config_${key.toLowerCase()}`) ?? variable(host, `npm_package_config_${key.toLowerCase()}`);
}

function browserCache(host: ComponentHost) {
 const { join, resolve, isAbsolute } = host.path;
 const override = playwrightVariable(host, "PLAYWRIGHT_BROWSERS_PATH");
 let cache: string;
 // Playwright server/registry: "0" means package-local; empty means the OS cache.
 if (override === "0") {
  const require = createRequire(import.meta.url);
  cache = join(dirname(createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json")), ".local-browsers");
 } else if (override) cache = override;
 else if (host.platform === "win32") cache = join(variable(host, "LOCALAPPDATA") || join(host.home, "AppData", "Local"), "ms-playwright");
 else if (host.platform === "darwin") cache = join(host.home, "Library", "Caches", "ms-playwright");
 else cache = join(variable(host, "XDG_CACHE_HOME") || join(host.home, ".cache"), "ms-playwright");
 // Relative paths, including OS cache homes, resolve from INIT_CWD or the working directory.
 return isAbsolute(cache) ? cache : resolve(playwrightVariable(host, "INIT_CWD") || host.cwd, cache);
}

async function exists(host: ComponentHost, path: string, executable = false) {
 try { await host.fs.access(path, executable ? nodeFsConstants.X_OK : nodeFsConstants.F_OK); return true; }
 catch (error) {
  // These optional launcher predicates fall through when the candidate is inaccessible.
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
  filesystemFailure(error, path, "system", "unmanaged");
 }
}

// veraPDF 1.30.2 verapdf: JAVACMD, JAVA_HOME (IBM jre/sh/java before bin/java), then PATH.
// The script discovers JAVA_HOME on Darwin and Gentoo when it is absent.
// An empty discovery result falls through to PATH, even after a failed command substitution.
async function posixJavaHome(host: ComponentHost, home: string) {
 const ibm = host.path.join(home, "jre", "sh", "java");
 return await exists(host, ibm, true) ? ibm : host.path.join(home, "bin", "java");
}

async function executablePath(host: ComponentHost, value: string, source: ComponentResolution["source"] = "system") {
 const { join, resolve } = host.path;
 const candidates = /[\\/]/.test(value) ? [resolve(host.cwd, value)] : (variable(host, "PATH") ?? "").split(host.platform === "win32" ? ";" : ":").filter(Boolean).flatMap(dir => host.platform === "win32" ? [join(dir, value), ...[".exe", ".cmd", ".bat"].map(ext => join(dir, value + ext))] : [join(dir, value)]);
 for (const path of candidates) {
  try { if ((await host.fs.stat(path)).isFile()) return path; }
  catch (e) { if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) filesystemFailure(e, path, source, "unmanaged"); }
 }
 return null;
}

export async function resolveComponent(host: ComponentHost, id: ComponentId, explicit?: string, options: { probeVersion?: boolean; validatorExecutable?: string } = {}): Promise<ComponentResolution> {
 const { join } = host.path;
 const component = (await componentDefinitions(host)).find(item => item.id === id)!;
 const missing = (inventory: ComponentResolution["inventory"] = "absent", path: string | null = null): ComponentResolution => ({ id, usable: false, source: null, path, version: null, pinned: null, inventory, reason: `${id === "browser" ? "Browser" : id === "java" ? "Java 17 or newer" : "veraPDF"} is ${inventory === "damaged" ? "damaged" : "not installed"}; checks not run. Run check setup ${component.checks.join(" ")}.` });
 try {
 let value = explicit;
 let selectionName = explicit === undefined ? undefined : "the executable argument";
 let classpath: string | undefined;
 let wrapperJava = false;
 const validator = validatorSelection(host, id === "verapdf" ? explicit : options.validatorExecutable);
 if (id === "verapdf") { value = validator.value; classpath = validator.classpath; }
 if (id === "java" && value === undefined) {
  // verapdf.bat ignores JAVA_HOME. VERAPDF_JAVA belongs only to Check's direct launcher.
  const keys = validator.direct ? ["VERAPDF_JAVA"] : host.platform === "win32" ? ["JAVACMD"] : ["JAVACMD", "JAVA_HOME"];
  for (const key of keys) {
   const override = variable(host, key);
   if (!override) continue;
   value = key === "JAVA_HOME" ? await posixJavaHome(host, override) : override;
   selectionName = key;
   break;
  }
  // A wrapper chooses its own Java; an unrelated managed JRE cannot replace that choice.
  wrapperJava = options.validatorExecutable !== undefined || !!validator.value && !validator.direct;
  if (!wrapperJava && !validator.direct) {
   const definition = (await componentDefinitions(host)).find(item => item.id === "verapdf")!;
   wrapperJava = await checkInventory(componentDirectory(host, definition), definition, host) !== "intact"
    && !!await executablePath(host, "verapdf");
  }
 }
 if (id === "browser" && component.entryPoint && value === undefined && playwrightVariable(host, "PLAYWRIGHT_BROWSERS_PATH"))
  value = join(browserCache(host), component.entryPoint);
 async function found(path: string, source: "explicit" | "setup" | "system", inventory: ComponentResolution["inventory"], probeTool = path): Promise<ComponentResolution> {
  let version: string | null = null;
  // Validation obtains veraPDF's version from its JSON, so wrappers need no version command.
  if (!version && !(id === "verapdf" && options.probeVersion === false)) {
   const result = await host.run(probeTool, classpath ? veraPdfJavaArgs(classpath, ["--version"]) : ["--version"],
    id === "verapdf" ? veraPdfEnvironment(host.env, host.platform) : javaEnvironment(host.env, host.platform as NodeJS.Platform));
   const output = result.stdout + "\n" + result.stderr;
   version = id === "java" ? output.match(/Temurin-([\d.]+\+\d+)/)?.[1] ?? output.match(/(?:openjdk|java)\s+(?:version\s+)?"?([\d.]+(?:\+\d+)?)/i)?.[1] ?? null : id === "verapdf" ? output.match(/veraPDF\s+([\d.]+)/)?.[1] ?? null : output.match(/(?:Chromium|Chrome[^\r\n]*?)\s+([\d.]+)/)?.[1] ?? null;
   if (result.code !== 0 || !version) return { ...missing(inventory, path), source, version, reason: `${id} did not report a version successfully: ${output.trim() || `exit ${result.code}`}; checks not run. Run check setup ${component.checks.join(" ")}.` };
   if (id === "java" && (!version || Number(version.split(".")[0]) < 17 || result.code !== 0)) return { ...missing(inventory, path), source, version, pinned: false };
  }
  return { id, usable: true, source, path, version, pinned: version === null ? null : version === component.version, inventory, ...(classpath ? { classpath } : {}) };
 }
 if (value !== undefined) {
  if (!value.trim()) throw new Error(`${id} executable must not be empty`);
  const path = await executablePath(host, value, "explicit");
  const result = path ? await found(path, "explicit", "unmanaged") : { ...missing("unmanaged", value), source: "explicit" as const };
  if (id === "java" && !result.usable && selectionName)
   result.reason = `Java selected by ${selectionName} at ${value} is unusable${result.version ? ` (version ${result.version})` : ""}. Fix or clear ${selectionName} to use Java 17 or newer; setup cannot replace an explicit selection.`;
  return result;
 }
 if (!component.entryPoint) return missing();
 const managed = componentDirectory(host, component);
 const inventory = await checkInventory(managed, component, host);
 if (inventory === "intact" && !wrapperJava) {
  if (id === "verapdf") {
   const java = await resolveComponent(host, "java");
   classpath = join(managed, "payload", "bin", "*");
   if (!java.usable) return { ...missing(inventory, join(managed, component.entryPoint)), source: "setup", classpath, reason: java.reason };
   return found(join(managed, component.entryPoint), "setup", inventory, java.path!);
  }
  return found(join(managed, component.entryPoint), "setup", inventory);
 }
 let discoveryDiagnostic: string | undefined;
 if (id === "java" && host.platform !== "win32") {
  let home: string | undefined;
  if (host.platform === "darwin") {
   if (await exists(host, "/usr/libexec/java_home", true)) {
    const result = await host.run("/usr/libexec/java_home", [], host.env);
    home = result.stdout.replace(/[\r\n]+$/, "") || undefined;
    if (result.code !== 0 || !home) discoveryDiagnostic = `Java home discovery returned no usable result: ${result.stderr || result.code}. veraPDF uses ${home || "Java on PATH"}.`;
   } else home = `/System/Library/Frameworks/JavaVM.framework/Versions/${variable(host, "JAVA_VERSION") || "CurrentJDK"}/Home`;
  } else if (await exists(host, "/etc/gentoo-release")) {
   const result = await host.run("java-config", ["--jre-home"], host.env);
   home = result.stdout.replace(/[\r\n]+$/, "") || undefined;
   if (result.code !== 0 || !home) discoveryDiagnostic = `Java home discovery returned no usable result: ${result.stderr || result.code}. veraPDF uses ${home || "Java on PATH"}.`;
  }
  if (home) {
   const value = await posixJavaHome(host, home), path = await executablePath(host, value);
   const result = path ? await found(path, "system", "unmanaged") : missing("unmanaged", value);
   if (discoveryDiagnostic) result.reason = [discoveryDiagnostic, result.reason].filter(Boolean).join(" ");
   return result;
  }
 }
 if (id === "java" || id === "verapdf") {
  const path = await executablePath(host, id === "java" ? "java" : "verapdf");
  if (path) {
   const result = await found(path, "system", "unmanaged");
   if (discoveryDiagnostic) result.reason = [discoveryDiagnostic, result.reason].filter(Boolean).join(" ");
   return { ...result, ...(inventory === "damaged" ? { inventory } : {}) };
  }
 }
 // Existing developer Playwright caches remain usable without requiring setup.
 if (id === "browser") {
  const path = await executablePath(host, join(browserCache(host), component.entryPoint), "explicit");
  if (path) return { ...await found(path, "explicit", "unmanaged"), ...(inventory === "damaged" ? { inventory } : {}) };
 }
 const result = missing(inventory, inventory === "damaged" ? managed : null);
 if (discoveryDiagnostic) result.reason = `${discoveryDiagnostic} ${result.reason}`;
 return result;
 } catch (error) {
  if (!(error instanceof ComponentAccessError)) throw error;
  return { ...missing(error.inventory, error.path), source: error.source,
   reason: `${id} at ${error.path} could not be accessed: ${error.message}; checks not run. Run check setup ${component.checks.join(" ")}.` };
 }
}

export async function doctor(host: ComponentHost, checks = ["pdf", "html"]) {
 if (checks.some(check => !["pdf", "html"].includes(check))) throw new Error("Doctor checks: pdf, html");
 const manifest = await componentDefinitions(host);
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
// Playwright utils/hostPlatform.ts maps every Windows architecture to win64;
// registry EXECUTABLE_PATHS describes runtime layouts independently of Check's download pins.
function browserLayout(platform: string, arch: string, override?: string, osRelease?: string, cpuModels?: string[]) {
 if (override) {
  if (override === "<unknown>") return null;
  platform = override === "win64" ? "win32" : override.startsWith("mac") ? "darwin" : "linux";
  arch = override.endsWith("arm64") ? "arm64" : "x64";
 }
 // Playwright uses Apple CPU models on macOS 11+, including x64 Node under Rosetta.
 if (!override && platform === "darwin" && cpuModels)
  arch = Number(osRelease?.split(".")[0] ?? 20) >= 20 && cpuModels.some(model => model.includes("Apple")) ? "arm64" : "x64";
 if (platform === "darwin" && ["x64", "arm64"].includes(arch)) return { directory: `chrome-headless-shell-mac-${arch}`, executable: "chrome-headless-shell" };
 if (platform === "linux" && arch === "x64") return { directory: "chrome-headless-shell-linux64", executable: "chrome-headless-shell" };
 if (platform === "linux" && arch === "arm64") return { directory: "chrome-linux", executable: "headless_shell" };
 if (platform === "win32") return { directory: "chrome-headless-shell-win64", executable: "chrome-headless-shell.exe" };
 return null;
}
export function browserTarget(platform: string, arch: string) {
 const target = browserLayout(platform, arch);
 if (!target) throw new Error(`Runtime assembly supports macOS arm64 and Windows x64 only; received ${platform} ${arch}`);
 return target;
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
