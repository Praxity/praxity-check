import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, posix } from "node:path";
import test from "node:test";
import { checkPdfAccessibility } from "../src/pdf-accessibility.ts";
import { componentHost, componentDirectory, componentManifest, componentsDirectory, doctorCli, resolveComponent, writeInventory, veraPdfCommand, type ComponentHost, type ComponentId } from "../src/components.ts";

async function fixture(t: test.TestContext, platform = process.platform as string, arch = process.arch as string) {
 const root = await fs.mkdtemp(join(tmpdir(), "check components "));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const foreignPosix = process.platform === "win32" && platform !== "win32";
 const home = foreignPosix ? "/check-components" : root;
 // Simulated POSIX paths have no drive letters. Only this adapter maps them to host files.
 const files = foreignPosix ? new Proxy(fs, { get(target, key: keyof typeof fs) {
  const fn = target[key];
  if (typeof fn !== "function") return fn;
  return (...args: unknown[]) => {
   const map = (value: unknown) => typeof value === "string" && value.startsWith(home)
    ? join(root, ...posix.relative(home, value).split("/")) : value;
   args[0] = map(args[0]);
   if (["rename", "copyFile", "symlink"].includes(key)) args[1] = map(args[1]);
   return (fn as Function)(...args);
  };
 } }) : fs;
 const host = componentHost({ env: {}, platform, arch, home, cwd: home, cpuModels: [arch === "arm64" ? "Apple" : "Intel"], osRelease: "24.0.0", fs: files,
  ...(foreignPosix ? { path: posix } : {}),
  run: async (file, args) => ({ stdout: args.includes("-classpath") ? "veraPDF 1.30.2" : file.includes("java") ? "openjdk 17.0.20.1+1" : file.includes("verapdf") || file.endsWith(".jar") ? "veraPDF 1.30.2" : "Chromium 151.0.7922.34", stderr: "", code: 0 }) });
 if (platform === "darwin") {
  const access = host.fs.access;
  host.fs = { ...host.fs, access: (async (path, mode) => {
   if (path === "/usr/libexec/java_home") return;
   return access(path, mode);
  }) as typeof fs.access };
  const run = host.run;
  host.run = async (file, args, env) => file === "/usr/libexec/java_home" ? { stdout: home, stderr: "", code: 0 } : run(file, args, env);
 }
 host.env = { CHECK_COMPONENTS_DIR: host.path.join(home, "components"), PATH: host.path.join(home, platform === "darwin" ? "bin" : "system") };
 return host;
}
async function install(host: ComponentHost, id: ComponentId) {
 const component = (await componentManifest(host)).find(item => item.id === id)!;
 const root = componentDirectory(host, component), path = host.path.join(root, component.entryPoint);
 await host.fs.mkdir(host.path.dirname(path), { recursive: true });
 await host.fs.writeFile(path, "fake runtime");
 await writeInventory(root, component, host);
 return path;
}

test("components use platform data folders and explicit overrides", () => {
 assert.equal(componentsDirectory({ env: {}, platform: "darwin", home: "/user" }), join("/user", "Library/Application Support/Praxity Check/components"));
 assert.equal(componentsDirectory({ env: {}, platform: "linux", home: "/user" }), join("/user", ".local/share/praxity-check/components"));
 assert.equal(componentsDirectory({ env: { XDG_DATA_HOME: "/data" }, platform: "linux", home: "/user" }), join("/data", "praxity-check/components"));
 assert.equal(componentsDirectory({ env: { LOCALAPPDATA: "/local" }, platform: "win32", home: "/user" }), join("/local", "Praxity/Check/components"));
 assert.equal(componentsDirectory({ env: { CHECK_COMPONENTS_DIR: "/chosen" }, platform: "linux", home: "/user" }), resolve("/chosen"));
});

test("explicit beats setup, setup beats system, and damaged files never count as intact", async t => {
 const host = await fixture(t);
 const managed = await install(host, "java");
 const system = join(host.env.PATH!, host.platform === "win32" ? "java.exe" : "java");
 await fs.mkdir(dirname(system), { recursive: true }); await fs.writeFile(system, "system runtime");
 assert.equal((await resolveComponent(host, "java")).source, "setup");
 assert.equal((await resolveComponent(host, "java", system)).source, "explicit");
 host.env.JAVACMD = system;
 assert.equal((await resolveComponent(host, "java")).source, "explicit");
 delete host.env.JAVACMD;
 await fs.writeFile(managed, "changed DLL or executable");
 const fallback = await resolveComponent(host, "java");
 assert.equal(fallback.inventory, "damaged"); assert.equal(fallback.source, "system");
 await fs.rm(system);
 const missing = await resolveComponent(host, "java");
 assert.equal(missing.usable, false); assert.equal(missing.inventory, "damaged"); assert.match(missing.reason!, /Run check setup pdf/);
});

test("inventories reject missing, extra and symlink files; interrupted installs are absent", async t => {
 const host = await fixture(t), path = await install(host, "verapdf");
 assert.equal((await resolveComponent(host, "verapdf")).usable, false, "A jar needs Java");
 await install(host, "java");
 assert.equal((await resolveComponent(host, "verapdf")).usable, true);
 await fs.writeFile(join(dirname(path), "injected.jar"), "extra");
 assert.equal((await resolveComponent(host, "verapdf")).inventory, "damaged");
 await fs.rm(join(dirname(path), "injected.jar")); await fs.rm(path);
 assert.equal((await resolveComponent(host, "verapdf")).inventory, "damaged");
 const browser = (await componentManifest(host)).find(c => c.id === "browser")!;
 const interrupted = join(componentDirectory(host, browser), browser.entryPoint);
 await fs.mkdir(dirname(interrupted), { recursive: true }); await fs.writeFile(interrupted, "partial");
 assert.equal((await resolveComponent(host, "browser")).inventory, "absent");
});

test("system Java below 17 cannot satisfy PDF checks", async t => {
 const host = await fixture(t), path = join(host.env.PATH!, host.platform === "win32" ? "java.exe" : "java");
 await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, "old java");
 host.run = async () => ({ stdout: 'java version "11.0.28"', stderr: "", code: 0 });
 assert.equal((await resolveComponent(host, "java")).usable, false);
});

test("a linked managed component root is damaged", async t => {
 const host = await fixture(t);
 await install(host, "java");
 const component = (await componentManifest(host)).find(c => c.id === "java")!;
 const managed = componentDirectory(host, component), moved = managed + "-moved";
 await fs.rename(managed, moved);
 await fs.symlink(moved, managed, host.platform === "win32" ? "junction" : "dir");
 assert.equal((await resolveComponent(host, "java")).inventory, "damaged");
});

test("doctor text and JSON share facts and exit codes for selected checks", async t => {
 const host = await fixture(t), printed: string[] = [];
 assert.equal(await doctorCli(["pdf"], host, text => printed.push(text)), 1);
 assert.match(printed[0]!, /verapdf: missing.*check setup pdf/);
 await install(host, "java"); await install(host, "verapdf");
 assert.equal(await doctorCli(["--json", "pdf"], host, text => printed.push(text)), 0);
 const json = JSON.parse(printed[1]!);
 assert.equal(json.components.find((c: { id: string }) => c.id === "java").source, "setup");
 assert.equal(json.components.find((c: { id: string }) => c.id === "java").pinned, true);
 assert.equal(await doctorCli([], host, () => {}), 1);
 await install(host, "browser"); assert.equal(await doctorCli([], host, () => {}), 0);
 await assert.rejects(doctorCli(["other"], host), /Doctor checks/);
});

test("missing PDF component produces not-run coverage and an actionable reason", async t => {
 const host = await fixture(t);
 const result = await checkPdfAccessibility("unused.pdf", { profile: "ua1" }, host);
 assert.equal(result.machineStatus, "incomplete"); assert.equal(result.evaluations[0]?.outcome, "untested");
 assert.match(result.evaluations[0]!.reason, /checks not run.*Run check setup pdf/);
 assert.equal(result.validator.machineCompliant, undefined);
});

test("inaccessible validators retain PDF not-run evidence and doctor diagnostics", async t => {
 for (const code of ["EACCES", "EPERM"]) await t.test(code, async t => {
  const host = await fixture(t), denied = host.path.join(host.home, "verapdf");
  host.env.VERAPDF = denied;
  const stat = host.fs.stat;
  host.fs = { ...host.fs, stat: (async (path, ...args) => {
   if (path === denied) throw Object.assign(new Error("Permission denied"), { code });
   return stat(path, ...args);
  }) as typeof fs.stat };
  const result = await checkPdfAccessibility("unused.pdf", { profile: "ua1" }, host);
  assert.equal(result.machineStatus, "incomplete");
  assert.equal(result.evaluations[0]?.outcome, "untested");
  assert.equal(result.validator.machineCompliant, undefined);
  assert.equal(result.components[0]!.path, denied);
  assert.match(result.evaluations[0]!.reason, new RegExp(`${code}.*Permission denied.*checks not run.*check setup pdf`));
  const printed: string[] = [];
  assert.equal(await doctorCli(["pdf", "--json"], host, text => printed.push(text)), 1);
  const validator = JSON.parse(printed[0]!).components.find((item: { id: string }) => item.id === "verapdf");
  assert.equal(validator.path, denied);
  assert.equal(validator.source, "explicit");
  assert.match(validator.reason, /Permission denied/);
 });
});

test("managed component access failures preserve their location in doctor", async t => {
 for (const operation of ["lstat", "readFile", "readdir"] as const) await t.test(operation, async t => {
  const host = await fixture(t);
  const executable = await install(host, "browser");
  const component = (await componentManifest(host)).find(item => item.id === "browser")!;
  const root = componentDirectory(host, component);
  const denied = operation === "readdir" ? root : host.path.join(root, ".inventory.json");
  const fn = host.fs[operation];
  host.fs = { ...host.fs, [operation]: async (path: string, ...args: unknown[]) => {
   if (path === denied) throw Object.assign(new Error("Permission denied"), { code: "EACCES", path: denied });
   return (fn as Function)(path, ...args);
  } };
  const result = await resolveComponent(host, "browser");
  assert.equal(result.usable, false, executable);
  assert.equal(result.inventory, "damaged");
  assert.equal(result.source, "setup");
  assert.equal(result.path, denied);
  assert.match(result.reason!, /EACCES.*Permission denied.*check setup html/);
  assert.equal(await doctorCli(["html"], host, () => {}), 1);
 });
});

test("component discovery propagates unexpected filesystem failures", async t => {
 const host = await fixture(t);
 host.fs = { ...host.fs, stat: async () => { throw new Error("unexpected adapter failure"); } };
 await assert.rejects(resolveComponent(host, "verapdf", host.path.join(host.home, "verapdf")), /unexpected adapter failure/);
});

test("doctor CLI returns 1 and missing HTML checks save not-run coverage", async t => {
 const host = await fixture(t), target = join(host.home, "course"), report = join(host.home, "report.json");
 await fs.mkdir(target); await fs.writeFile(join(target, "index.html"), "<html><title>Test</title></html>");
 const env = { ...process.env, ...host.env, PLAYWRIGHT_BROWSERS_PATH: join(host.home, "missing-browser") };
 const doctor = spawnSync(process.execPath, [resolve("src/cli.ts"), "doctor", "html", "--json"], { env, encoding: "utf8" });
 assert.equal(doctor.status, 1, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).exitCode, 1);
 const check = spawnSync(process.execPath, [resolve("src/cli.ts"), "check", target, "--json", report], { env, encoding: "utf8" });
 assert.equal(check.status, 2, check.stderr);
 const result = JSON.parse(await fs.readFile(report, "utf8"));
 assert.equal(result.pages[0].audited, false);
 assert.match(result.evaluations[0].reason, /Run check setup html/);
});

test("Temurin build numbers identify the pinned Java runtime", async t => {
 const host = await fixture(t), path = join(host.home, "java.exe");
 await fs.writeFile(path, "fake Java");
 host.run = async () => ({ stdout: 'openjdk 17.0.20.1 2026-09-29\nOpenJDK Runtime Environment Temurin-17.0.20.1+1 (build 17.0.20.1+1)', stderr: "", code: 0 });
 const java = await resolveComponent(host, "java", path);
 assert.equal(java.version, "17.0.20.1+1"); assert.equal(java.pinned, true);
});

test("unsupported download targets still resolve explicit validators", async t => {
 for (const [platform, arch] of [["win32", "arm64"], ["freebsd", "x64"]]) {
  const host = await fixture(t, platform!, arch!);
  const path = host.path.join(host.home, "verapdf-wrapper");
  await host.fs.writeFile(path, "wrapper");
  const validator = await resolveComponent(host, "verapdf", path);
  assert.equal(validator.usable, true);
  assert.equal(validator.path, path);
  assert.equal(validator.source, "explicit");
  assert.equal(validator.version, "1.30.2");
  await assert.rejects(componentManifest(host), /Unsupported components target/);
 }
});

test("unsupported download targets support system lookup and doctor", async t => {
 const host = await fixture(t, "freebsd", "x64");
 await host.fs.mkdir(host.env.PATH!, { recursive: true });
 for (const name of ["java", "verapdf"]) await host.fs.writeFile(host.path.join(host.env.PATH!, name), "system tool");
 const printed: string[] = [];
 assert.equal((await resolveComponent(host, "verapdf")).source, "system");
 assert.equal((await resolveComponent(host, "java")).usable, true);
 assert.equal(await doctorCli(["pdf", "--json"], host, text => printed.push(text)), 0);
 assert.equal(JSON.parse(printed[0]!).components.find((c: { id: string }) => c.id === "browser").usable, false);
 assert.equal(await doctorCli(["html"], host, () => {}), 1);
 const browser = host.path.join(host.home, "browser");
 await host.fs.writeFile(browser, "browser");
 assert.equal((await resolveComponent(host, "browser", browser)).usable, true);
});

test("Java overrides follow the active launcher precedence and skip empty variables", async t => {
 for (const platform of ["win32", "linux", "darwin"]) {
  const host = await fixture(t, platform);
  const good = host.path.join(host.home, "jdk", "bin", platform === "win32" ? "java.exe" : "java");
  const old = host.path.join(host.home, "old-java");
  await host.fs.mkdir(host.path.dirname(good), { recursive: true });
  await host.fs.writeFile(good, "Java 17"); await host.fs.writeFile(old, "Java 11");
  host.run = async file => ({ stdout: file === "/usr/libexec/java_home" ? host.home : file === old ? "openjdk 11.0.28" : "openjdk 17.0.20.1+1", stderr: "", code: 0 });
  const system = host.path.join(host.env.PATH!, platform === "win32" ? "java.exe" : "java");
  await host.fs.mkdir(host.path.dirname(system), { recursive: true }); await host.fs.writeFile(system, "Java 17", { mode: 0o700 });
  const base = { ...host.env };
  const cases: [string, NodeJS.ProcessEnv, string, boolean][] = [
   ["empty JAVACMD follows the platform launcher", { JAVACMD: "", JAVA_HOME: host.path.join(host.home, "jdk") }, platform === "win32" ? system : good, true],
   ["empty VERAPDF_JAVA falls through to JAVACMD", { VERAPDF_JAVA: "", JAVACMD: good }, good, true],
   ["JAVACMD beats JAVA_HOME", { JAVACMD: good, JAVA_HOME: host.path.join(host.home, "missing") }, good, true],
   ["active old JAVACMD blocks JAVA_HOME", { JAVACMD: old, JAVA_HOME: host.path.join(host.home, "jdk") }, old, false],
   ["VERAPDF_JAVA has platform precedence", { VERAPDF_JAVA: old, JAVACMD: good, JAVA_HOME: host.path.join(host.home, "jdk") }, platform === "win32" ? old : good, platform !== "win32"],
   ["explicit Windows validator bypasses VERAPDF_JAVA", { VERAPDF: "wrapper", VERAPDF_JAVA: old, JAVACMD: good }, good, true],
  ];
  for (const [name, env, path, usable] of cases) await t.test(`${platform}: ${name}`, async () => {
   host.env = { ...base, ...env };
   const java = await resolveComponent(host, "java");
   assert.equal(java.path, path); assert.equal(java.usable, usable); assert.equal(java.source, path === system ? "system" : "explicit");
  });
  await t.test(`${platform}: empty variables allow system Java`, async () => {
   await host.fs.mkdir(base.PATH!, { recursive: true });
   const system = host.path.join(base.PATH!, platform === "win32" ? "java.exe" : "java");
   await host.fs.writeFile(system, "Java 17");
   host.env = { ...base, VERAPDF_JAVA: "", JAVACMD: "", JAVA_HOME: "" };
   assert.equal((await resolveComponent(host, "java")).source, "system");
  });
 }
});

test("doctor requires successful identifiable version probes", async t => {
 const host = await fixture(t);
 host.env.JAVACMD = await install(host, "java");
 const path = join(host.home, "verapdf-wrapper");
 await fs.writeFile(path, "wrapper");
 host.env.VERAPDF = path;
 for (const probe of [
  { stdout: "", stderr: "startup failed", code: 1 },
  { stdout: "veraPDF 1.30.2", stderr: "startup failed", code: 1 },
  { stdout: "", stderr: "", code: 0 },
  { stdout: "", stderr: "could not start", code: null },
 ]) {
  host.run = async () => probe;
  assert.equal(await doctorCli(["pdf"], host, () => {}), 1);
  assert.equal((await resolveComponent(host, "verapdf")).usable, false);
 }
 host.run = async file => ({ stdout: file.includes("java") ? "openjdk 17.0.20.1+1" : "veraPDF 1.30.2", stderr: "", code: 0 });
 assert.equal(await doctorCli(["pdf"], host, () => {}), 0);
});

test("doctor probes managed veraPDF and Java despite intact inventories", async t => {
 const host = await fixture(t);
 await install(host, "java");
 await install(host, "verapdf");
 host.run = async (_file, args) => args.includes("-classpath")
  ? { stdout: "", stderr: "startup failed", code: 1 }
  : { stdout: "openjdk 17.0.20.1+1", stderr: "", code: 0 };
 const verapdf = await resolveComponent(host, "verapdf");
 assert.equal(verapdf.inventory, "intact");
 assert.equal(verapdf.usable, false);
 assert.equal(await doctorCli(["pdf"], host, () => {}), 1);
 host.run = async () => ({ stdout: "", stderr: "Permission denied", code: null });
 assert.equal((await resolveComponent(host, "java")).usable, false);
});

test("relative Playwright caches resolve from INIT_CWD", async t => {
 const host = await fixture(t);
 host.env.INIT_CWD = join(host.home, "caller");
 host.env.PLAYWRIGHT_BROWSERS_PATH = "browser-cache";
 const browser = (await componentManifest(host)).find(c => c.id === "browser")!;
 const path = resolve(host.env.INIT_CWD, "browser-cache", browser.entryPoint);
 await fs.mkdir(dirname(path), { recursive: true });
 await fs.writeFile(path, "browser");
 const result = await resolveComponent(host, "browser");
 assert.equal(result.path, path);
 assert.equal(result.usable, true);
 assert.equal(await doctorCli(["html"], host, () => {}), 0);
 host.env.PLAYWRIGHT_BROWSERS_PATH = resolve(host.env.INIT_CWD, "browser-cache");
 assert.equal((await resolveComponent(host, "browser")).path, path);
});


test("empty veraPDF variables allow managed and system validators", async t => {
 for (const source of ["setup", "system"] as const) await t.test(source, async t => {
  const host = await fixture(t, "win32");
  const path = source === "setup" ? await install(host, "verapdf") : host.path.join(host.env.PATH!, "verapdf.bat");
  if (source === "setup") await install(host, "java");
  else { await host.fs.mkdir(host.path.dirname(path), { recursive: true }); await host.fs.writeFile(path, "wrapper"); }
  for (const VERAPDF of [undefined, ""]) {
   host.env = { ...host.env, VERAPDF, VERAPDF_JAVA: "" };
   const result = await resolveComponent(host, "verapdf");
   assert.equal(result.path, path); assert.equal(result.source, source); assert.equal(result.usable, true);
   assert.equal(veraPdfCommand(host.env, "win32", undefined, []).tool, "verapdf");
  }
 });
});

// veraPDF 1.30.2 verapdf.bat: JAVACMD or PATH, never JAVA_HOME.
// POSIX verapdf: JAVACMD, JAVA_HOME, then PATH. Check's Windows direct launcher uses VERAPDF_JAVA.
test("Java selection matches each launcher across absent empty valid old and invalid overrides", async t => {
 for (const platform of ["win32", "darwin", "linux"]) for (const launcher of ["wrapper", "direct", "matched", "flag"]) await t.test(`${platform} ${launcher}`, async t => {
  const host = await fixture(t, platform), { join, dirname } = host.path;
  const system = join(host.env.PATH!, platform === "win32" ? "java.exe" : "java");
  const goodHome = join(host.home, "good"), oldHome = join(host.home, "old"), invalidHome = join(host.home, "invalid");
  const good = join(goodHome, "bin", platform === "win32" ? "java.exe" : "java"), old = join(oldHome, "bin", platform === "win32" ? "java.exe" : "java"), invalid = join(invalidHome, "bin", platform === "win32" ? "java.exe" : "java");
  for (const path of [system, good, old]) { await host.fs.mkdir(dirname(path), { recursive: true }); await host.fs.writeFile(path, "Java", { mode: 0o700 }); }
  host.run = async file => ({ stdout: file === "/usr/libexec/java_home" ? host.home : file === old ? 'openjdk version "11.0.28"' : 'openjdk version "17.0.20.1"', stderr: "", code: 0 });
  const values = [undefined, "", good, old, invalid], homes = [undefined, "", goodHome, oldHome, invalidHome];
  const base = { ...host.env };
  for (const [i, VERAPDF_JAVA] of values.entries()) for (const [j, JAVACMD] of values.entries()) for (const [k, JAVA_HOME] of homes.entries()) {
   const wrapper = join(host.home, "verapdf-wrapper");
   host.env = { ...base, VERAPDF_JAVA, JAVACMD, JAVA_HOME, ...(launcher === "wrapper" ? { VERAPDF: wrapper } : launcher === "matched" ? { VERAPDF: VERAPDF_JAVA } : {}) };
   const selected = platform === "win32" && ["direct", "matched"].includes(launcher) && VERAPDF_JAVA ? VERAPDF_JAVA
    : JAVACMD || (platform !== "win32" && JAVA_HOME ? join(JAVA_HOME, "bin", "java") : system);
   const result = await resolveComponent(host, "java", undefined, launcher === "flag" ? { validatorExecutable: wrapper } : {});
   const label = `${platform} ${launcher} VERAPDF_JAVA=${i} JAVACMD=${j} JAVA_HOME=${k}`;
   assert.equal(result.path, selected, label);
   assert.equal(result.usable, selected !== old && selected !== invalid, label);
   assert.equal(result.source, selected === system ? "system" : "explicit", label);
  }
 });
});

test("a wrapper uses system Java even when managed Java is installed", async t => {
 for (const platform of ["win32", "linux"]) await t.test(platform, async t => {
  const host = await fixture(t, platform), { join, dirname } = host.path;
  await install(host, "java");
  const system = join(host.env.PATH!, platform === "win32" ? "java.exe" : "java"), wrapper = join(host.env.PATH!, platform === "win32" ? "verapdf.bat" : "verapdf");
  await host.fs.mkdir(dirname(system), { recursive: true });
  for (const path of [system, wrapper]) await host.fs.writeFile(path, "system executable", { mode: 0o700 });
  for (const VERAPDF of [undefined, wrapper]) {
   host.env.VERAPDF = VERAPDF;
   assert.equal((await resolveComponent(host, "java")).path, system);
  }
 });
});

test("validator flags always bypass direct Java and empty flags still fail", async t => {
 const host = await fixture(t, "win32"), wrapper = host.path.join(host.home, "verapdf-wrapper"), java = host.path.join(host.home, "java.exe");
 for (const path of [wrapper, java]) await host.fs.writeFile(path, "executable");
 host.env = { ...host.env, VERAPDF_JAVA: java, VERAPDF_CLASSPATH: "jars/*" };
 assert.equal((await resolveComponent(host, "verapdf", wrapper)).path, wrapper);
 await assert.rejects(resolveComponent(host, "verapdf", ""), /must not be empty/);
 const command = veraPdfCommand(host.env, "win32", wrapper, ["--version"]);
 assert.equal(command.tool, wrapper); assert.deepEqual(command.args, ["--version"]);
});

// Ask the installed registry itself, in a new process so it rereads each environment.
test("browser lookup matches the installed Playwright registry on every runtime target", async t => {
 const require = createRequire(import.meta.url), core = createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json");
 for (const [platform, arch, cpu, release] of [
  ["win32", "x64"], ["win32", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"],
  ["darwin", "x64", "Apple", "24.0.0"], ["darwin", "x64", "Apple", "19.0.0"],
 ]) await t.test(`${platform} ${arch}${cpu ? ` ${cpu} ${release}` : ""}`, async t => {
  const host = await fixture(t); host.platform = platform!; host.arch = arch!; host.cpuModels = [cpu ?? (arch === "arm64" ? "Apple" : "Intel")]; host.osRelease = release ?? "24.0.0";
  const base = { ...host.env, LOCALAPPDATA: join(host.home, "local"), XDG_CACHE_HOME: join(host.home, "xdg") };
  const cache = join(host.home, "cache"), caller = join(host.home, "caller");
  const cases: [string, NodeJS.ProcessEnv, boolean][] = [
   ["absent", {}, true], ["empty", { PLAYWRIGHT_BROWSERS_PATH: "" }, true],
   ["absolute", { PLAYWRIGHT_BROWSERS_PATH: cache }, true], ["invalid", { PLAYWRIGHT_BROWSERS_PATH: cache }, false],
   ["relative with INIT_CWD", { PLAYWRIGHT_BROWSERS_PATH: "cache", INIT_CWD: caller }, true],
   ["relative with empty INIT_CWD", { PLAYWRIGHT_BROWSERS_PATH: "cache", INIT_CWD: "" }, true],
   ["relative without INIT_CWD", { PLAYWRIGHT_BROWSERS_PATH: "cache" }, true],
   ["local", { PLAYWRIGHT_BROWSERS_PATH: "0" }, true],
   ["npm config", { npm_config_playwright_browsers_path: cache }, true],
   ["npm package config", { npm_package_config_playwright_browsers_path: cache }, true],
   ["direct beats npm", { PLAYWRIGHT_BROWSERS_PATH: cache, npm_config_playwright_browsers_path: "ignored" }, true],
   ["empty masks npm", { PLAYWRIGHT_BROWSERS_PATH: "", npm_config_playwright_browsers_path: "ignored" }, true],
   ["npm config beats package", { npm_config_playwright_browsers_path: cache, npm_package_config_playwright_browsers_path: "ignored" }, true],
   ["empty npm masks package", { npm_config_playwright_browsers_path: "", npm_package_config_playwright_browsers_path: "ignored" }, true],
   ["npm INIT_CWD", { PLAYWRIGHT_BROWSERS_PATH: "cache", npm_config_init_cwd: caller }, true],
   ["empty INIT_CWD masks npm", { PLAYWRIGHT_BROWSERS_PATH: "cache", INIT_CWD: "", npm_config_init_cwd: caller }, true],
   ["host platform override", { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "win64" }, true],
   ["empty cache home", { LOCALAPPDATA: "", XDG_CACHE_HOME: "" }, true],
   ["relative cache home", { LOCALAPPDATA: "local", XDG_CACHE_HOME: "xdg", INIT_CWD: caller }, true],
  ];
  for (const [name, env, usable] of cases) {
   host.env = { ...base, ...env };
   const childEnv = { ...process.env };
   for (const key of Object.keys(childEnv)) if (/^(PLAYWRIGHT_|npm_config_(playwright_|init_cwd)|npm_package_config_(playwright_|init_cwd)|INIT_CWD|LOCALAPPDATA|XDG_CACHE_HOME)/i.test(key)) delete childEnv[key];
   Object.assign(childEnv, host.env);
   const code = `const os=require('os'); os.platform=()=>${JSON.stringify(platform)}; os.arch=()=>${JSON.stringify(arch)}; os.homedir=()=>${JSON.stringify(host.home)}; os.release=()=>${JSON.stringify(host.osRelease)}; os.cpus=()=>${JSON.stringify(host.cpuModels.map(model => ({ model })))}; Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}}); process.cwd=()=>${JSON.stringify(host.cwd)}; const {registry}=require(${JSON.stringify(join(dirname(core), "lib/coreBundle.js"))}).registry; console.log(JSON.stringify(registry.findExecutable('chromium-headless-shell').executablePath()));`;
   const oracle = spawnSync(process.execPath, ["-e", code], { env: childEnv, encoding: "utf8", windowsHide: true });
   assert.equal(oracle.status, 0, oracle.stderr);
   const expected = JSON.parse(oracle.stdout) as string;
   host.fs = { ...fs, stat: (async path => {
    if (String(path) === expected && usable) return { isFile: () => true };
    throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
   }) as typeof fs.stat };
   const result = await resolveComponent(host, "browser");
   assert.equal(result.usable, usable, `${platform} ${arch}: ${name}: ${expected}`);
   if (usable) assert.equal(result.path, expected, `${platform} ${arch}: ${name}`);
  }
 });
});

// Optional upstream oracle. CHECK_TEST_VERAPDF_LAUNCHERS contains the unmodified 1.30.2 launchers.
test("Windows Java lookup agrees with the installed veraPDF batch launcher", { skip: process.platform !== "win32" || !process.env.CHECK_TEST_VERAPDF_LAUNCHERS }, async t => {
 const host = await fixture(t); host.run = componentHost().run;
 const source = join(host.home, "Java.cs"), system = join(host.env.PATH!, "java.exe");
 await fs.mkdir(dirname(system), { recursive: true });
 await fs.writeFile(source, `using System; using System.Reflection; class Java { static void Main() { Console.WriteLine(Assembly.GetExecutingAssembly().Location); Console.WriteLine(Assembly.GetExecutingAssembly().Location.Contains("old-java") ? "openjdk 11.0.28" : "openjdk 17.0.20.1"); } }`);
 const compiled = spawnSync(join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", `/out:${system}`, source], { encoding: "utf8", windowsHide: true });
 assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
 const wrapper = join(process.env.CHECK_TEST_VERAPDF_LAUNCHERS!, "verapdf.bat"), override = join(host.home, "override-java.exe");
 const old = join(host.home, "old-java.exe");
 await fs.copyFile(system, override); await fs.copyFile(system, old);
 const base = { ...process.env, ...host.env, VERAPDF: wrapper, OS: "Windows_NT" };
 for (const VERAPDF_JAVA of [undefined, "", override, old, "missing-java"]) for (const JAVACMD of [undefined, "", override, old, "missing-java"]) for (const JAVA_HOME of [undefined, "", host.home, "missing-home"]) {
  host.env = { ...base, VERAPDF_JAVA, JAVACMD, JAVA_HOME };
  const real = spawnSync(join(process.env.SystemRoot!, "System32/cmd.exe"), ["/d", "/s", "/c", `""${wrapper}" --version"`], { env: host.env, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  const expected = real.stdout.split(/\r?\n/).find(line => line.endsWith(".exe"));
  const result = await resolveComponent(host, "java");
  if (expected) { assert.equal(result.path, expected); assert.equal(result.usable, expected !== old); }
  else { assert.notEqual(real.status, 0, real.stdout); assert.equal(result.usable, false); }
 }
});


test("POSIX Java home and OS discovery match veraPDF 1.30.2", async t => {
 for (const platform of ["linux", "darwin"]) await t.test(platform, async t => {
  const host = await fixture(t, platform), { join, dirname } = host.path;
  const home = join(host.home, "ibm"), ibm = join(home, "jre/sh/java"), standard = join(home, "bin/java");
  for (const path of [ibm, standard]) { await host.fs.mkdir(dirname(path), { recursive: true }); await host.fs.writeFile(path, "Java", { mode: 0o700 }); }
  host.env.JAVA_HOME = home;
  assert.equal((await resolveComponent(host, "java")).path, ibm);
  host.env.JAVACMD = standard;
  assert.equal((await resolveComponent(host, "java")).path, standard);
  delete host.env.JAVA_HOME; delete host.env.JAVACMD;
  const access = host.fs.access;
  host.fs = { ...host.fs, access: (async (path, mode) => {
   if (path === "/etc/gentoo-release" && platform === "linux" || path === "/usr/libexec/java_home" && platform === "darwin") return;
   return access(path, mode);
  }) as typeof fs.access };
  const run = host.run;
  host.run = async (file, args, env) => file === "java-config" || file === "/usr/libexec/java_home" ? { stdout: home, stderr: "", code: 0 } : run(file, args, env);
  const java = await resolveComponent(host, "java");
  assert.equal(java.path, ibm); assert.equal(java.source, "system"); assert.equal(java.usable, true);
  host.run = async () => ({ stdout: "", stderr: "discovery failed", code: 1 });
  assert.equal((await resolveComponent(host, "java")).usable, false);
 });
});

test("POSIX Java lookup agrees with the installed veraPDF shell launcher", { skip: !process.env.CHECK_TEST_VERAPDF_LAUNCHERS || process.platform === "win32" && !process.env.CHECK_TEST_POSIX_SHELL }, async t => {
 const host = await fixture(t, "linux"), { join, dirname } = host.path;
 const shell = process.env.CHECK_TEST_POSIX_SHELL || "/bin/sh";
 const nativeRoot = await host.fs.realpath(host.home);
 const unixPath = (path: string) => {
  if (process.platform !== "win32") return path;
  const result = spawnSync(shell, ["-c", 'cygpath -u "$1"', "cygpath", path], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
 };
 const unixRoot = unixPath(nativeRoot), wrapper = unixPath(join(process.env.CHECK_TEST_VERAPDF_LAUNCHERS!, "verapdf"));
 const goodHome = join(host.home, "good"), oldHome = join(host.home, "old"), good = join(goodHome, "bin/java"), old = join(oldHome, "bin/java"), system = join(host.env.PATH!, "java");
 for (const path of [good, old, system]) {
  await host.fs.mkdir(dirname(path), { recursive: true });
  await host.fs.writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$0"\necho 'openjdk ${path === old ? "11.0.28" : "17.0.20.1"}'\n`, { mode: 0o700 });
 }
 host.run = async file => ({ stdout: file === old ? "openjdk 11.0.28" : "openjdk 17.0.20.1", stderr: "", code: 0 });
 const base = { ...host.env };
 const unixValue = (value: string | undefined) => value?.replace(host.home, unixRoot);
 for (const VERAPDF_JAVA of [undefined, "", old]) for (const JAVACMD of [undefined, "", good, old, join(host.home, "missing-java")]) for (const JAVA_HOME of [undefined, "", goodHome, oldHome, join(host.home, "missing-home")]) {
  host.env = { ...base, VERAPDF_JAVA, JAVACMD, JAVA_HOME, VERAPDF: wrapper };
  const env = { ...process.env, VERAPDF_JAVA: unixValue(VERAPDF_JAVA), JAVACMD: unixValue(JAVACMD), JAVA_HOME: unixValue(JAVA_HOME), PATH: unixValue(base.PATH) + ":" + (process.platform === "win32" ? "/usr/bin:/bin" : process.env.PATH) };
  const real = spawnSync(shell, [wrapper, "--version"], { env, encoding: "utf8", windowsHide: true });
  const selected = real.stdout.split(/\r?\n/).find(line => line.startsWith(unixRoot));
  const result = await resolveComponent(host, "java");
  if (selected) { assert.equal(result.path, selected.replace(unixRoot, host.home)); assert.equal(result.usable, selected !== unixValue(old)); }
  else { assert.notEqual(real.status, 0, real.stdout); assert.equal(result.usable, false); }
 }
});


test("runtime browser overrides do not change verified download entry points", async () => {
 const target = { platform: "darwin", arch: "arm64" };
 const pinned = (await componentManifest(target)).find(c => c.id === "browser")!;
 const withOverrides = (await componentManifest(componentHost({ ...target, env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "win64" } }))).find(c => c.id === "browser")!;
 assert.equal(withOverrides.entryPoint, pinned.entryPoint);
 assert.deepEqual(withOverrides.archives, pinned.archives);
});


test("POSIX Java discovery falls back to PATH when the launcher gets no home", async t => {
 for (const platform of ["linux", "darwin"]) await t.test(platform, async t => {
  const host = await fixture(t, platform), path = host.path.join(host.env.PATH!, "java");
  await host.fs.mkdir(host.path.dirname(path), { recursive: true }); await host.fs.writeFile(path, "Java", { mode: 0o700 });
  const access = host.fs.access;
  host.fs = { ...host.fs, access: (async (path, mode) => {
   if (path === "/etc/gentoo-release" || path === "/usr/libexec/java_home") return;
   return access(path, mode);
  }) as typeof fs.access };
  for (const code of [0, 1, null]) {
   host.run = async (file) => file === "java-config" || file === "/usr/libexec/java_home"
    ? { stdout: "", stderr: "no Java home", code } : { stdout: "openjdk 17.0.20.1", stderr: "", code: 0 };
   const result = await resolveComponent(host, "java");
   assert.equal(result.path, path); assert.equal(result.usable, true); assert.equal(result.source, "system");
   assert.match(result.reason!, /Java home discovery/);
  }
 });
});
