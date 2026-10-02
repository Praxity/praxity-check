import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareWindowsJava, validateWindowsJava, windowsJavaPins } from "./prepare-windows-java.mjs";
import { downloadVerified } from "./download-verified.mjs";

test("official downloads require the pinned SHA-256 before saving or reusing bytes", async t => {
	const root = await mkdtemp(join(tmpdir(), "java downloads "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bytes = Buffer.from("Synthetic official archive"), path = join(root, "payload.zip");
	const pin = { url: "https://official.example/payload.zip", sha256: "e92c343da0eb439f6014bec5c00f840772e33b5399c0ec0d9b84ae62399286f1" };
	const fetched = [];
	assert.equal(await downloadVerified(pin, path, { fetchFile: async url => { fetched.push(url); return new Response(bytes); } }), path);
	assert.deepEqual(fetched, [pin.url]);
	assert.deepEqual(await readFile(path), bytes);
	assert.equal(await downloadVerified(pin, path, { fetchFile: async () => { throw new Error("Cached bytes must not download"); } }), path);
	await writeFile(path, "corrupt cached bytes");
	await assert.rejects(downloadVerified(pin, path), /SHA-256 mismatch/);
	assert.equal(await readFile(path, "utf8"), "corrupt cached bytes");
	const refused = join(root, "refused.zip");
	await assert.rejects(downloadVerified(pin, refused, { fetchFile: async () => new Response("untrusted bytes") }), /SHA-256 mismatch/);
	await assert.rejects(access(refused), /ENOENT/);
	await assert.rejects(downloadVerified(pin, refused, { fetchFile: async () => new Response("missing", { status: 404 }) }), /Download failed \(404\)/);
	await assert.rejects(access(refused), /ENOENT/);
});

test("preparation requires explicit directories and preserves an existing output", async t => {
	if (process.platform !== "win32" || process.arch !== "x64") {
		await assert.rejects(prepareWindowsJava({}), /requires Windows x64/);
		return;
	}
	await assert.rejects(prepareWindowsJava({}), /Required: --work/);
	const root = await mkdtemp(join(tmpdir(), "java output "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const marker = join(root, "retain.txt");
	await writeFile(marker, "Existing output");
	await assert.rejects(prepareWindowsJava({ work: join(root, "work"), output: root }), /EEXIST/);
	assert.equal(await readFile(marker, "utf8"), "Existing output");
});

test("prepared official Windows Java and veraPDF report their pinned versions", async t => {
	const runtime = process.env.CHECK_WINDOWS_JAVA_RUNTIME;
	if (!runtime || process.platform !== "win32") { t.skip("Set CHECK_WINDOWS_JAVA_RUNTIME to an official prepared runtime"); return; }
	const versions = await validateWindowsJava(join(runtime, "java"), join(runtime, "verapdf"));
	assert.match(versions.java, /Temurin-17\.0\.20\.1\+1/);
	assert.match(versions.veraPDF, /^veraPDF 1\.30\.2/);
	assert.ok(versions.imports.length > 0);
	for (const imported of versions.imports.flatMap(file => file.imports)) assert.ok(imported.system || imported.target);
	const recorded = JSON.parse(await readFile(join(runtime, "runtime-versions.json"), "utf8"));
	assert.equal(recorded.pins.java.sha256, windowsJavaPins.java.sha256);
	assert.equal(recorded.pins.veraPDF.sha256, windowsJavaPins.veraPDF.sha256);
});
