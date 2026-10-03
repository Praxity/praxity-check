import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { crc32, gzipSync } from "node:zlib";
import { extractComponentArchive } from "../src/archives.ts";
import { componentDirectory, componentManifest, doctor, resolveComponent, runtimePins, type Component } from "../src/components.ts";
import { checkPdfAccessibility } from "../src/pdf-accessibility.ts";
import { downloadVerified, setup, setupCli, setupHost, type SetupHost } from "../src/setup.ts";
type Entry = {
    name: string;
    data?: string;
    link?: string;
    type?: string;
    mode?: number;
};
function zip(entries: Entry[]) {
    const local: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name), data = Buffer.from(entry.data ?? "fixture"), header = Buffer.alloc(30), record = Buffer.alloc(46);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt32LE(crc32(data), 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(name.length, 26);
        record.writeUInt32LE(0x02014b50);
        record.writeUInt16LE(0x314, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt32LE(crc32(data), 16);
        record.writeUInt32LE(data.length, 20);
        record.writeUInt32LE(data.length, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt32LE(((entry.mode ?? 0x81ed) << 16) >>> 0, 38);
        record.writeUInt32LE(offset, 42);
        local.push(header, name, data);
        central.push(record, name);
        offset += header.length + name.length + data.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}
function tar(entries: Entry[]) {
    const output: Buffer[] = [];
    for (const entry of entries) {
        const header = Buffer.alloc(512), data = Buffer.from(entry.type === "2" || entry.type === "1" ? "" : entry.data ?? "fixture");
        header.write(entry.name);
        header.write("0000755\0", 100);
        header.write("0000000\0", 108);
        header.write("0000000\0", 116);
        header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
        header.fill(32, 148, 156);
        header.write(entry.type ?? "0", 156);
        if (entry.link)
            header.write(entry.link, 157);
        header.write("ustar\0", 257);
        header.write("00", 263);
        const sum = header.reduce((total, byte) => total + byte, 0);
        header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
        output.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    }
    return gzipSync(Buffer.concat([...output, Buffer.alloc(1024)]));
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t: test.TestContext, platform = "win32", arch = "x64") {
    const root = await fs.mkdtemp(join(tmpdir(), "setup fixtures "));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const printed: string[] = [], archiveBytes = new Map<string, Buffer>();
    const host = setupHost({ platform, arch, cpuModels: [arch === "arm64" ? "Apple" : "Intel"], osRelease: "24.0.0", home: root, env: { CHECK_COMPONENTS_DIR: join(root, "components"), PATH: "" }, print: line => printed.push(line),
        fetchFile: async (url) => new Response(Uint8Array.from(archiveBytes.get(url)!)), confirm: async () => true });
    const manifest = await componentManifest(host);
    for (const component of manifest) {
        let bytes: Buffer;
        const name = `${component.id}${component.id === "java" && platform !== "win32" ? ".tar.gz" : ".zip"}`;
        if (component.id === "java") {
            const entries = [{ name: component.entryPoint, data: "fixture Java" }, { name: `${runtimePins.java.directory}/legal/LICENSE`, data: "fixture licence" }];
            bytes = platform === "win32" ? zip(entries) : tar(entries);
        }
        else if (component.id === "verapdf")
            bytes = zip([{ name: `${runtimePins.veraPDF.directory}/verapdf-izpack-installer-${component.version}.jar` }]);
        else
            bytes = zip([{ name: component.entryPoint.split("/").slice(1).join("/") }]);
        const url = `https://upstream.example/${name}`;
        component.archives = [{ url, sha256: hash(bytes), size: bytes.length }];
        archiveBytes.set(url, bytes);
    }
    host.manifest = async () => manifest;
    host.run = async (file, args) => {
        if (args.includes("-jar")) {
            const xml = await fs.readFile(args.at(-1)!, "utf8"), target = xml.match(/<installpath>(.*?)<\/installpath>/)![1]!.replaceAll("&amp;", "&");
            await fs.mkdir(join(target, "bin"), { recursive: true });
            await fs.writeFile(join(target, "bin", `cli-${runtimePins.veraPDF.version}.jar`), "installed CLI");
            return { stdout: "Automated installation done", stderr: "", code: 0 };
        }
        return { stdout: args.includes("org.verapdf.apps.GreenfieldCliWrapper") ? "veraPDF 1.30.2" : file.includes("java") ? "openjdk 17.0.20.1+1 Temurin-17.0.20.1+1" : "Chromium 151.0.7922.34", stderr: "", code: 0 };
    };
    host.installBrowser = async (directory, archives) => {
        const path = join(root, "installer-input.zip");
        await fs.writeFile(path, archives.values().next().value!);
        await extractComponentArchive(path, join(directory, "chromium_headless_shell-1234"), fs);
    };
    return { host, manifest, printed, archiveBytes, root };
}
test("setup installs ZIP browser, Java and headless veraPDF fixtures and inventories them", async (t) => {
    const { host, manifest } = await fixture(t);
    const result = await setup({ yes: true, selectors: ["pdf", "html"] }, host);
    assert.deepEqual(result.installed, ["java", "browser", "verapdf"]);
    for (const component of manifest) {
        const found = await resolveComponent(host, component.id);
        assert.equal(found.source, "setup");
        assert.equal(found.inventory, "intact");
        assert.equal(found.version, component.version);
    }
    assert.equal((await doctor(host)).exitCode, 0);
    assert.deepEqual((await setup({ yes: true }, host)).installed, []);
});

for (const offline of [false, true]) {
 for (const variable of [
  "PLAYWRIGHT_DOWNLOAD_HOST", "npm_config_playwright_download_host", "npm_package_config_playwright_download_host",
  "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST", "npm_config_playwright_chromium_download_host", "npm_package_config_playwright_chromium_download_host",
  "PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST", "npm_config_playwright_firefox_download_host", "npm_package_config_playwright_firefox_download_host",
  "PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST", "npm_config_playwright_webkit_download_host", "npm_package_config_playwright_webkit_download_host",
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
 ]) test(`production browser installer uses verified archives despite ${variable} ${offline ? "offline" : "downloaded"}`, async t => {
  const { root } = await fixture(t, process.platform, process.arch);
  const component = (await componentManifest({ platform: process.platform, arch: process.arch })).find(c => c.id === "browser")!;
  const archives = new Map<string, Buffer>();
  for (const archive of component.archives) {
   const name = basename(new URL(archive.url).pathname);
   const entry = name.includes("headless-shell") ? component.entryPoint.split("/").slice(1).join("/")
    : name.startsWith("ffmpeg") ? process.platform === "win32" ? "ffmpeg-win64.exe" : process.platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-linux" : "PrintDeps.exe";
   const bytes = zip([{ name: entry, data: `verified ${name}` }]);
   archives.set(name, bytes);
   archive.sha256 = hash(bytes); archive.size = bytes.length;
  }
  const redirected: string[] = [];
  const other = createServer((request, response) => {
   redirected.push(request.url!);
   response.writeHead(502); response.end("Unverified mirror or proxy must not receive installer requests");
  });
  await new Promise<void>(ok => other.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise<void>((ok, no) => other.close(error => error ? no(error) : ok())));
  const address = other.address();
  assert.ok(address && typeof address !== "string");
  const env: NodeJS.ProcessEnv = { ...process.env, CHECK_COMPONENTS_DIR: join(root, "components"),
   CHECK_TEST_UNTRUSTED_INSTALLER_OPTION: "must not cross the allowlist", NODE_OPTIONS: "--require=missing-installer-hook",
   NO_PROXY: "unrelated.example", no_proxy: "unrelated.example", [variable]: `http://127.0.0.1:${address.port}` };
  const host = setupHost({ env, print: () => {}, manifest: async () => [component],
   fetchFile: async url => new Response(Uint8Array.from(archives.get(basename(new URL(url).pathname))!)) });
  const run = host.run;
  host.run = async (file, args, env) => {
   // Exercise the real installer and check its environment at the process boundary.
   for (const name of ["PLAYWRIGHT_DOWNLOAD_HOST", "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST", "PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST", "PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST"]) {
    for (const key of [name, `npm_config_${name.toLowerCase()}`, `npm_package_config_${name.toLowerCase()}`]) {
     assert.equal(new URL(env[key]!).hostname, "127.0.0.1", key);
     assert.equal(env[key], env.PLAYWRIGHT_DOWNLOAD_HOST, key);
    }
   }
   assert.match(env.NO_PROXY!, /(?:^|,)127\.0\.0\.1(?:,|$)/);
   assert.equal(env.no_proxy, env.NO_PROXY);
   assert.equal(env.CHECK_TEST_UNTRUSTED_INSTALLER_OPTION, undefined);
   assert.equal(env.NODE_OPTIONS, undefined);
   assert.ok(Object.keys(env).every(key => !/proxy$/i.test(key) || key.toUpperCase() === "NO_PROXY"));
   return run(file, args, env);
  };
  const from = join(root, "offline");
  if (offline) {
   await fs.mkdir(from);
   for (const [name, bytes] of archives) await fs.writeFile(join(from, name), bytes);
   host.fetchFile = async () => { throw new Error("Offline setup must not fetch"); };
  }
  assert.deepEqual((await setup({ yes: true, selectors: ["browser"], ...(offline ? { from } : {}) }, host)).installed, ["browser"]);
  assert.deepEqual(redirected, [], "Only Check's verified loopback server may receive downloads");
  const path = join(componentDirectory(host, component), component.entryPoint);
  assert.equal(await fs.readFile(path, "utf8"), `verified ${basename(new URL(component.archives[0]!.url).pathname)}`);
 });
}
test("managed Java validation on POSIX excludes inherited JVM options", async (t) => {
    const { host } = await fixture(t, "linux", "x64");
    await setup({ yes: true, selectors: ["pdf"] }, host);
    host.env.JAVA_TOOL_OPTIONS = "-javaagent:unexpected.jar";
    host.env.JAVA_OPTS = "-invalid-option";
    const run = host.run;
    host.run = async (file, args, env) => {
        if (args.includes("--version")) return run(file, args, env);
        if (env.JAVA_TOOL_OPTIONS || env.JAVA_OPTS) return { stdout: "", stderr: "Inherited JVM options", code: 2 };
        return { stdout: JSON.stringify({ report: {
            buildInformation: { releaseDetails: [{ id: "core", version: "1.30.2" }] },
            jobs: [{ validationResult: [{ profileName: "PDF/UA-1 validation profile", jobEndStatus: "normal", compliant: true, details: { passedRules: 1, failedRules: 0, passedChecks: 1, failedChecks: 0 } }] }],
            batchSummary: { totalJobs: 1, failedParsingJobs: 0, failedEncryptedJobs: 0, outOfMemory: 0, veraExceptions: 0, validationSummary: { failedJobCount: 0, totalJobCount: 1, successfulJobCount: 1, compliantPdfaCount: 1, nonCompliantPdfaCount: 0 } }
        } }), stderr: "", code: 0 };
    };
    const result = await checkPdfAccessibility("fixture.pdf", { profile: "ua1" }, host);
    assert.equal(result.machineStatus, "complete");
    assert.equal(result.validator.machineCompliant, true);
    assert.equal(result.evaluations[0]?.outcome, "passed");
});

test("offline setup verifies the same hashes and never calls the network", async (t) => {
    const { host, manifest, archiveBytes, root } = await fixture(t), offline = join(root, "offline archives");
    await fs.mkdir(offline);
    for (const component of manifest)
        for (const archive of component.archives)
            await fs.writeFile(join(offline, basename(archive.url)), archiveBytes.get(archive.url)!);
    host.fetchFile = async () => { throw new Error("Offline setup reached the network"); };
    assert.equal(await setupCli(["--from", offline, "--yes", "pdf", "html"], host), 0);
    assert.equal((await doctor(host)).exitCode, 0);
});
test("missing offline archive and mismatched hashes leave no intact installation", async (t) => {
    const { host, manifest, root } = await fixture(t), offline = join(root, "offline");
    await fs.mkdir(offline);
    host.fetchFile = async () => { throw new Error("Must not fetch offline"); };
    await assert.rejects(setup({ yes: true, from: offline, selectors: ["java"] }, host), /ENOENT/);
    await fs.writeFile(join(offline, "java.zip"), "untrusted non-archive");
    await assert.rejects(setup({ yes: true, from: offline, selectors: ["java"] }, host), /SHA-256 mismatch/);
    await assert.rejects(fs.lstat(componentDirectory(host, manifest.find(c => c.id === "java")!)), /ENOENT/);
    assert.deepEqual(await fs.readdir(host.env.CHECK_COMPONENTS_DIR!), []);
});
test("list shows purpose, version, size, licence, URL and hash without writing", async (t) => {
    const { host, printed } = await fixture(t);
    host.confirm = async () => { throw new Error("List must not prompt"); };
    host.fetchFile = async () => { throw new Error("List must not download"); };
    assert.equal(await setupCli(["--list"], host), 0);
    assert.equal(printed.length, 3);
    assert.match(printed.join("\n"), /PDF\/UA.*\nDownload: \d+ bytes\nLicence:.*\nhttps:.*\nSHA-256:/);
    await assert.rejects(fs.lstat(host.env.CHECK_COMPONENTS_DIR!), /ENOENT/);
});
test("refusing components leaves their checks not run with a setup command", async (t) => {
    const { host } = await fixture(t);
    host.confirm = async () => false;
    assert.deepEqual((await setup({}, host)).refused, ["java", "browser", "verapdf"]);
    assert.equal((await doctor(host)).exitCode, 1);
    const pdf = await checkPdfAccessibility("unused.pdf", { profile: "ua1" }, host);
    assert.equal(pdf.machineStatus, "incomplete");
    assert.match(pdf.evaluations[0]!.reason, /Run check setup pdf/);
    assert.equal((await resolveComponent(host, "browser")).usable, false);
});
test("interrupted browser installation cannot publish an intact version", async (t) => {
    const { host, manifest } = await fixture(t);
    host.installBrowser = async (directory) => { await fs.writeFile(join(directory, "partial"), "partial"); throw new Error("Interrupted"); };
    await assert.rejects(setup({ yes: true, selectors: ["browser"] }, host), /Interrupted/);
    const browser = manifest.find(c => c.id === "browser")!;
    await assert.rejects(fs.lstat(componentDirectory(host, browser)), /ENOENT/);
    assert.deepEqual(await fs.readdir(host.env.CHECK_COMPONENTS_DIR!), []);
    assert.equal((await resolveComponent(host, "browser")).usable, false);
});
test("Java tar.gz installs on Linux and macOS and versions stay side by side", async (t) => {
    for (const platform of ["linux", "darwin"]) {
        const { host, manifest } = await fixture(t, platform, "arm64");
        const java = manifest.find(c => c.id === "java")!, older = componentDirectory(host, { id: "java", version: "older" });
        await fs.mkdir(older, { recursive: true });
        await fs.writeFile(join(older, "retained"), "old version");
        assert.deepEqual((await setup({ yes: true, selectors: ["java"] }, host)).installed, ["java"]);
        assert.equal((await resolveComponent(host, "java")).inventory, "intact");
        assert.equal(await fs.readFile(join(older, "retained"), "utf8"), "old version");
        await fs.writeFile(join(componentDirectory(host, java), java.entryPoint), "changed");
        await assert.rejects(setup({ yes: true, selectors: ["java"] }, host), /already exists but is not intact/);
    }
});
test("system Java 17+ is reused and older Java is replaced by the pinned setup JRE", async (t) => {
    const { host, root } = await fixture(t), system = join(root, "bin", "java.exe");
    await fs.mkdir(dirname(system));
    await fs.writeFile(system, "system Java");
    host.env.PATH = dirname(system);
    assert.deepEqual((await setup({ yes: true, selectors: ["java"] }, host)).reused, ["java"]);
    assert.equal((await resolveComponent(host, "java")).source, "system");
    const run = host.run;
    host.run = (file, args, env) => file === system ? Promise.resolve({ stdout: "openjdk 11.0.28", stderr: "", code: 0 }) : run(file, args, env);
    assert.deepEqual((await setup({ yes: true, selectors: ["java"] }, host)).installed, ["java"]);
});
test("verified malicious ZIP archives cannot escape staging or install links", async (t) => {
    for (const entries of [[{ name: "../escaped" }], [{ name: "/absolute" }], [{ name: "C:/outside" }], [{ name: "file:stream" }], [{ name: "link", mode: 0xa1ff }], [{ name: "duplicate" }, { name: "Duplicate" }]]) {
        const { host, manifest, archiveBytes, root } = await fixture(t), java = manifest.find(c => c.id === "java")!;
        const bytes = zip(entries);
        java.archives[0]!.sha256 = hash(bytes);
        archiveBytes.set(java.archives[0]!.url, bytes);
        await assert.rejects(setup({ yes: true, selectors: ["java"] }, host), /path|symlink|Duplicate/i);
        assert.equal((await resolveComponent(host, "java")).usable, false);
        await assert.rejects(fs.lstat(join(root, "escaped")), /ENOENT/);
    }
});
test("tar extraction materializes internal links and refuses escapes, cycles and corrupt headers", async (t) => {
    const { root } = await fixture(t);
    const safe = join(root, "safe.tar.gz"), target = join(root, "safe");
    await fs.writeFile(safe, tar([{ name: "legal/base/LICENSE", data: "literal licence" }, { name: "legal/other/LICENSE", type: "2", link: "../base/LICENSE" }]));
    await extractComponentArchive(safe, target, fs);
    assert.equal(await fs.readFile(join(target, "legal/other/LICENSE"), "utf8"), "literal licence");
    assert.equal((await fs.lstat(join(target, "legal/other/LICENSE"))).isSymbolicLink(), false);
    for (const entries of [[{ name: "../outside" }], [{ name: "legal/link", type: "2", link: "../../outside" }], [{ name: "link", type: "2", link: "/outside" }], [{ name: "link", type: "2", link: "link" }]]) {
        const path = join(root, "unsafe.tar.gz");
        await fs.writeFile(path, tar(entries));
        await assert.rejects(extractComponentArchive(path, join(root, "unsafe"), fs), /path|link/i);
    }
    await fs.writeFile(join(root, "corrupt.tar.gz"), gzipSync(Buffer.alloc(512, 42)));
    await assert.rejects(extractComponentArchive(join(root, "corrupt.tar.gz"), join(root, "corrupt"), fs), /tar/i);
});
test("download verifier preserves the original hash, cache and HTTP failure guarantees", async (t) => {
    const { host, root } = await fixture(t), bytes = Buffer.from("Synthetic official archive"), path = join(root, "verified.zip");
    const pin = { url: "https://official.example/payload.zip", sha256: "e92c343da0eb439f6014bec5c00f840772e33b5399c0ec0d9b84ae62399286f1" };
    host.fetchFile = async () => new Response(bytes);
    assert.deepEqual(await downloadVerified(pin, path, host), bytes);
    assert.deepEqual(await fs.readFile(path), bytes);
    host.fetchFile = async () => { throw new Error("Cached bytes must not download"); };
    assert.deepEqual(await downloadVerified(pin, path, host), bytes);
    await fs.writeFile(path, "corrupt cached bytes");
    await assert.rejects(downloadVerified(pin, path, host), /SHA-256 mismatch/);
    assert.equal(await fs.readFile(path, "utf8"), "corrupt cached bytes");
    const refused = join(root, "refused.zip");
    host.fetchFile = async () => new Response("untrusted bytes");
    await assert.rejects(downloadVerified(pin, refused, host), /SHA-256 mismatch/);
    await assert.rejects(fs.lstat(refused), /ENOENT/);
    host.fetchFile = async () => new Response("missing", { status: 404 });
    await assert.rejects(downloadVerified(pin, refused, host), /Download failed \(404\)/);
    await assert.rejects(fs.lstat(refused), /ENOENT/);
});
test("setup rejects unknown selectors and incomplete options", async (t) => {
    const { host } = await fixture(t);
    await assert.rejects(setupCli(["--from"], host), /incomplete/);
    await assert.rejects(setupCli(["unknown"], host), /Unknown setup/);
});

for (const offline of [true, false]) {
    for (const [platform, id] of [["win32", "java"], ["linux", "java"], ["win32", "browser"]] as const) {
        test(`setup installs verified bytes despite ${offline ? "offline" : "downloaded"} ${platform} ${id} archive replacement`, async t => {
            const { host, manifest, archiveBytes, root } = await fixture(t, platform);
            const component = manifest.find(c => c.id === id)!, archive = component.archives[0]!;
            const name = basename(archive.url), original = archiveBytes.get(archive.url)!;
            const entry = id === "browser" ? component.entryPoint.split("/").slice(1).join("/") : component.entryPoint;
            const replacement = (name.endsWith(".tar.gz") ? tar : zip)([{ name: entry, data: "unverified replacement" }]);
            const from = join(root, "offline");
            if (offline) {
                await fs.mkdir(from);
                await fs.writeFile(join(from, name), original);
            }
            let reads = 0;
            host.fs = { ...fs,
                readFile: (async (path: string, ...args: unknown[]) => {
                    const bytes = await (fs.readFile as Function)(path, ...args);
                    if (offline && basename(String(path)) === name && ++reads === 2)
                        await fs.writeFile(path, replacement);
                    return bytes;
                }) as typeof fs.readFile,
                writeFile: (async (path: string, data: Buffer, ...args: unknown[]) => {
                    await (fs.writeFile as Function)(path, !offline && basename(String(path)) === name ? replacement : data, ...args);
                }) as typeof fs.writeFile,
            };
            const result = await setup({ yes: true, selectors: [id], ...(offline ? { from } : {}) }, host);
            assert.deepEqual(result.installed, [id]);
            const installed = await resolveComponent(host, id);
            assert.equal(installed.inventory, "intact");
            assert.equal(await fs.readFile(installed.path!, "utf8"), id === "java" ? "fixture Java" : "fixture");
        });
    }
}

test("tar link copies count toward the expanded byte limit before copying", async t => {
    const { root } = await fixture(t);
    // The filesystem adapter avoids allocating hundreds of MiB in this regression test.
    for (const type of ["1", "2"]) {
        for (const count of [511, 512, 600]) {
            let copies = 0;
            const files = { ...fs, copyFile: async () => {
                if (++copies > 511) throw new Error("Copied beyond the byte budget");
            } };
            const path = join(root, `links-${type}-${count}.tar.gz`);
            await fs.writeFile(path, tar([
                { name: "base", data: "x".repeat(1024 * 1024) },
                ...Array.from({ length: count }, (_, index) => ({ name: `link-${index}`, type, link: "base" })),
            ]));
            const extracted = extractComponentArchive(path, join(root, `links-${type}-${count}`), files);
            if (count === 511) await assert.doesNotReject(extracted);
            else await assert.rejects(extracted, /expands beyond/);
        }
    }
});

test("component ZIP and tar archives cap entries at 20000", async t => {
    const { root } = await fixture(t);
    const files = { ...fs, mkdir: async () => undefined, writeFile: async () => {} } as typeof fs;
    for (const format of ["zip", "tar.gz"]) {
        for (const count of [20000, 20001]) {
            const bytes = (format === "zip" ? zip : tar)(Array.from({ length: count }, (_, i) => ({ name: `file-${i}`, data: "" })));
            const extracted = extractComponentArchive({ name: `entries.${format}`, bytes }, join(root, `entries-${format}-${count}`), files, format === "zip");
            if (count === 20000) await assert.doesNotReject(extracted);
            else await assert.rejects(extracted, /more than 20000 entries|too many.*entries/i);
        }
    }
});

test("setup rejects unusable explicit Java before downloads even with a managed JRE", async t => {
    for (const variable of ["JAVA_HOME", "JAVACMD", "VERAPDF_JAVA"]) {
        for (const installed of [false, true]) {
            const { host, root } = await fixture(t, variable === "JAVA_HOME" ? "linux" : "win32");
            if (installed) await setup({ yes: true, selectors: ["java"] }, host);
            const home = join(root, "old-java"), executable = join(home, "bin", host.platform === "win32" ? "java.exe" : "java");
            await fs.mkdir(dirname(executable), { recursive: true });
            await fs.writeFile(executable, "old explicit Java");
            host.env[variable] = variable === "JAVA_HOME" ? home : executable;
            const run = host.run;
            host.run = (file, args, env) => file === executable
                ? Promise.resolve({ stdout: 'java version "11.0.28"', stderr: "", code: 0 }) : run(file, args, env);
            host.fetchFile = async () => { throw new Error("Downloaded despite an unusable override"); };
            await assert.rejects(setup({ yes: true, selectors: ["pdf", "html"] }, host), new RegExp(`${variable}.*[Ff]ix or clear ${variable}`));
        }
    }
});

test("setup diagnoses missing and failing explicit Java selections", async t => {
    for (const failure of ["missing", "failed probe"]) {
        const { host, root } = await fixture(t);
        const executable = join(root, "java.exe");
        host.env.javacmd = executable;
        if (failure === "failed probe") {
            await fs.writeFile(executable, "failing Java");
            host.run = async () => ({ stdout: "openjdk 17.0.20.1+1", stderr: "startup failed", code: 1 });
        }
        host.fetchFile = async () => { throw new Error("Must not download"); };
        await assert.rejects(setup({ yes: true, selectors: ["java"] }, host), /[Ff]ix or clear JAVACMD/);
        assert.deepEqual((await setup({ list: true, selectors: ["java"] }, host)).installed, []);
    }
});

test("setup reuses Java selected by the launcher despite inactive overrides", async t => {
 for (const platform of ["win32", "linux", "darwin"]) {
  const { host, root } = await fixture(t, platform);
  const home = join(root, "jdk"), good = join(home, "bin", platform === "win32" ? "java.exe" : "java");
  const old = join(root, "old-java");
  await fs.mkdir(dirname(good), { recursive: true });
  await fs.writeFile(good, "Java 17"); await fs.writeFile(old, "Java 11");
  host.run = async file => ({ stdout: file === old ? "openjdk 11.0.28" : "openjdk 17.0.20.1+1", stderr: "", code: 0 });
  host.fetchFile = async () => { throw new Error("Must reuse the launcher's Java"); };
  const base = { ...host.env, ...(platform === "win32" ? { PATH: dirname(good) } : {}) };
  const cases = [
   { VERAPDF_JAVA: "", JAVACMD: "", JAVA_HOME: home },
   { VERAPDF_JAVA: "", JAVACMD: good, JAVA_HOME: join(root, "missing") },
   { VERAPDF: "wrapper", VERAPDF_JAVA: old, JAVACMD: good },
   ...(platform === "win32" ? [] : [{ VERAPDF_JAVA: old, JAVACMD: good }, { VERAPDF_JAVA: old, JAVACMD: "", JAVA_HOME: home }]),
  ];
  for (const env of cases) {
   host.env = { ...base, ...env };
   assert.deepEqual((await setup({ yes: true, selectors: ["java"] }, host)).reused, ["java"]);
   assert.equal((await resolveComponent(host, "java")).path, good);
  }
 }
});

test("setup cannot report reuse when intact components fail their probes", async t => {
    for (const id of ["java", "verapdf", "browser"] as const) {
        const { host } = await fixture(t);
        await setup({ yes: true }, host);
        const installed = await resolveComponent(host, id), run = host.run;
        host.run = async (file, args, env) => (id === "verapdf" ? args.includes("-classpath") : file === installed.path)
            ? { stdout: "", stderr: "startup failed", code: 1 } : run(file, args, env);
        await assert.rejects(setup({ yes: true, selectors: [id] }, host), /did not report a version successfully/);
    }
});


test("setup ignores Windows JAVA_HOME when the wrapper uses Java on PATH", async t => {
 for (const installed of [false, true]) for (const JAVA_HOME of ["", "missing-home", "old-home"]) await t.test(`${installed ? "managed" : "fresh"} ${JAVA_HOME || "empty"}`, async t => {
  const { host, root } = await fixture(t);
  if (installed) await setup({ yes: true, selectors: ["java"] }, host);
  const system = join(root, "system", "java.exe"), oldHome = join(root, "old-home"), old = join(oldHome, "bin", "java.exe");
  for (const file of [system, old]) { await fs.mkdir(dirname(file), { recursive: true }); await fs.writeFile(file, "Java fixture"); }
  const run = host.run;
  host.run = (file, args, env) => file === old ? Promise.resolve({ stdout: "openjdk 11.0.28", stderr: "", code: 0 }) : run(file, args, env);
  host.fetchFile = async () => { throw new Error("The wrapper's Java needs no download"); };
  for (const JAVACMD of [undefined, ""]) for (const VERAPDF_JAVA of [undefined, "", old]) {
   host.env = { ...host.env, PATH: dirname(system), JAVA_HOME: JAVA_HOME ? join(root, JAVA_HOME) : "", JAVACMD, VERAPDF_JAVA, VERAPDF: "verapdf-wrapper" };
   assert.deepEqual((await setup({ yes: true, selectors: ["java"] }, host)).reused, ["java"]);
   const java = await resolveComponent(host, "java");
   assert.equal(java.path, system); assert.equal(java.source, "system"); assert.equal(java.usable, true);
  }
 });
});
