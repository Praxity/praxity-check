import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
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
    const host = setupHost({ platform, arch, home: root, env: { CHECK_COMPONENTS_DIR: join(root, "components"), PATH: "" }, print: line => printed.push(line),
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
    assert.equal(await downloadVerified(pin, path, host), path);
    assert.deepEqual(await fs.readFile(path), bytes);
    host.fetchFile = async () => { throw new Error("Cached bytes must not download"); };
    assert.equal(await downloadVerified(pin, path, host), path);
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
