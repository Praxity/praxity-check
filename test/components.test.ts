import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { checkPdfAccessibility } from "../src/pdf-accessibility.ts";
import { componentHost, componentDirectory, componentManifest, componentsDirectory, doctorCli, resolveComponent, writeInventory, type ComponentHost, type ComponentId } from "../src/components.ts";

async function fixture(t: test.TestContext) {
 const root = await fs.mkdtemp(join(tmpdir(), "check components "));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 return componentHost({ env: { CHECK_COMPONENTS_DIR: join(root, "components"), PATH: join(root, "system") }, home: root,
  run: async (file, args) => ({ stdout: args.includes("-classpath") ? "veraPDF 1.30.2" : file.includes("java") ? "openjdk 17.0.20.1+1" : file.includes("verapdf") || file.endsWith(".jar") ? "veraPDF 1.30.2" : "Chromium 151.0.7922.34", stderr: "", code: 0 }) });
}
async function install(host: ComponentHost, id: ComponentId) {
 const component = (await componentManifest(host)).find(item => item.id === id)!;
 const root = componentDirectory(host, component), path = join(root, component.entryPoint);
 await host.fs.mkdir(dirname(path), { recursive: true });
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
  const host = await fixture(t);
  host.platform = platform!; host.arch = arch!;
  const path = join(host.home, "verapdf-wrapper");
  await fs.writeFile(path, "wrapper");
  const validator = await resolveComponent(host, "verapdf", path);
  assert.equal(validator.usable, true);
  assert.equal(validator.path, path);
  assert.equal(validator.source, "explicit");
  assert.equal(validator.version, "1.30.2");
  await assert.rejects(componentManifest(host), /Unsupported components target/);
 }
});

test("unsupported download targets support system lookup and doctor", async t => {
 const host = await fixture(t);
 host.platform = "freebsd"; host.arch = "x64";
 await fs.mkdir(host.env.PATH!, { recursive: true });
 for (const name of ["java", "verapdf"]) await fs.writeFile(join(host.env.PATH!, name), "system tool");
 const printed: string[] = [];
 assert.equal((await resolveComponent(host, "verapdf")).source, "system");
 assert.equal((await resolveComponent(host, "java")).usable, true);
 assert.equal(await doctorCli(["pdf", "--json"], host, text => printed.push(text)), 0);
 assert.equal(JSON.parse(printed[0]!).components.find((c: { id: string }) => c.id === "browser").usable, false);
 assert.equal(await doctorCli(["html"], host, () => {}), 1);
 const browser = join(host.home, "browser");
 await fs.writeFile(browser, "browser");
 assert.equal((await resolveComponent(host, "browser", browser)).usable, true);
});

test("Java overrides follow the active launcher precedence and skip empty variables", async t => {
 for (const platform of ["win32", "linux", "darwin"]) {
  const host = await fixture(t);
  host.platform = platform;
  const good = join(host.home, "jdk", "bin", platform === "win32" ? "java.exe" : "java");
  const old = join(host.home, "old-java");
  await fs.mkdir(dirname(good), { recursive: true });
  await fs.writeFile(good, "Java 17"); await fs.writeFile(old, "Java 11");
  host.run = async file => ({ stdout: file === old ? "openjdk 11.0.28" : "openjdk 17.0.20.1+1", stderr: "", code: 0 });
  const base = { ...host.env };
  const cases: [string, NodeJS.ProcessEnv, string, boolean][] = [
   ["empty JAVACMD falls through to JAVA_HOME", { JAVACMD: "", JAVA_HOME: join(host.home, "jdk") }, good, true],
   ["empty VERAPDF_JAVA falls through to JAVACMD", { VERAPDF_JAVA: "", JAVACMD: good }, good, true],
   ["JAVACMD beats JAVA_HOME", { JAVACMD: good, JAVA_HOME: join(host.home, "missing") }, good, true],
   ["active old JAVACMD blocks JAVA_HOME", { JAVACMD: old, JAVA_HOME: join(host.home, "jdk") }, old, false],
   ["VERAPDF_JAVA has platform precedence", { VERAPDF_JAVA: old, JAVACMD: good, JAVA_HOME: join(host.home, "jdk") }, platform === "win32" ? old : good, platform !== "win32"],
   ["explicit Windows validator bypasses VERAPDF_JAVA", { VERAPDF: "wrapper", VERAPDF_JAVA: old, JAVACMD: good }, good, true],
  ];
  for (const [name, env, path, usable] of cases) await t.test(`${platform}: ${name}`, async () => {
   host.env = { ...base, ...env };
   const java = await resolveComponent(host, "java");
   assert.equal(java.path, path); assert.equal(java.usable, usable); assert.equal(java.source, "explicit");
  });
  await t.test(`${platform}: empty variables allow system Java`, async () => {
   await fs.mkdir(base.PATH!, { recursive: true });
   const system = join(base.PATH!, platform === "win32" ? "java.exe" : "java");
   await fs.writeFile(system, "Java 17");
   host.env = { ...base, VERAPDF_JAVA: "", JAVACMD: "", JAVA_HOME: "" };
   assert.equal((await resolveComponent(host, "java")).source, "system");
  });
 }
});

test("doctor requires successful identifiable version probes", async t => {
 const host = await fixture(t);
 await install(host, "java");
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
