import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { packageArtifact } from "./package.mjs";

const windows = process.platform === "win32";
const repository = fileURLToPath(new URL("../", import.meta.url));

async function scratch(t) {
	const directory = await mkdtemp(join(tmpdir(), "standalone check "));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function verifyInventory(artifact) {
	const manifest = JSON.parse(await readFile(join(artifact, "capabilities.json"), "utf8"));
	assert.equal(manifest.tool, "praxity-check");
	assert.equal(manifest.version, "0.6.0");
	assert.match(manifest.sourceRevision, /^[0-9a-f]{40}$/);
	assert.equal(typeof manifest.dirty, "boolean");
	assert.equal(manifest.nodeRequirement, ">=22.18");
	assert.match(manifest.note, /not capability claims/);
	assert.deepEqual(manifest.inventoryExcludes, ["capabilities.json"]);
	const paths = [];
	async function walk(directory, prefix = "") {
		for (const name of await readdir(directory)) {
			const path = prefix + name;
			const stat = await lstat(join(directory, name));
			if (stat.isDirectory()) await walk(join(directory, name), path + "/");
			else {
				assert.ok(stat.isFile(), `${path} must be a regular file`);
				assert.ok(!/\.(map|log)$/i.test(path), `${path} must not carry build maps or logs`);
				assert.ok(!path.includes("\\") && !path.startsWith("/"));
				assert.ok(path.split("/").filter(part => part === "node_modules").length <= 1, `Nested dependencies leaked: ${path}`);
				if (path !== "capabilities.json") paths.push(path);
			}
		}
	}
	await walk(artifact);
	assert.deepEqual(manifest.files.map(file => file.path).sort(), paths.sort());
	for (const file of manifest.files) {
		const bytes = await readFile(join(artifact, file.path));
		assert.equal(file.size, bytes.length, file.path);
		assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"), file.path);
	}
	for (const path of ["LICENSE", "LICENSING.md", "NOTICE.md", "THIRD-PARTY-NOTICES.md", "runtime/LICENSE", "node_modules/playwright-core/ThirdPartyNotices.txt", "node_modules/playwright/lib/transform/babelBundle.js.LICENSE"]) {
		assert.ok(manifest.legalFiles.includes(path), `Missing legal path: ${path}`);
	}
	for (const path of ["LICENSE", "LICENSING.md", "NOTICE.md", "skill/SKILL.md"]) {
		assert.deepEqual(await readFile(join(artifact, path)), await readFile(join(repository, path)));
	}
	return manifest;
}

function run(launcher, args, root) {
	const env = windows
		? { PATH: join(root, "empty PATH"), SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, USERPROFILE: root }
		: { PATH: join(root, "empty PATH"), HOME: root, TMPDIR: root };
	if (windows) {
		// Node cannot execFile a .cmd. The absolute system shell is the only external launcher tool.
		const command = `"${launcher}" ${args.map(arg => `"${arg}"`).join(" ")}`;
		return spawnSync(join(process.env.SystemRoot, "System32", "cmd.exe"), ["/d", "/s", "/c", `"${command}"`], { cwd: root, env, encoding: "utf8", windowsVerbatimArguments: true });
	}
	return spawnSync(launcher, args, { cwd: root, env, encoding: "utf8" });
}

async function proveArtifact(staged, root, html) {
	const artifact = join(root, "relocated Check with spaces");
	await rename(staged, artifact);
	const manifest = await verifyInventory(artifact);
	assert.equal(manifest.platform, process.platform);
	assert.equal(manifest.arch, process.arch);
	const launcher = join(artifact, windows ? "bin/praxity-check.cmd" : "bin/praxity-check");
	assert.equal(manifest.entryPoint, windows ? "bin/praxity-check.cmd" : "bin/praxity-check");
	const help = run(launcher, ["--help"], root);
	assert.equal(help.status, 0, help.stderr || String(help.error));
	assert.match(help.stdout, /compare-pdf/);
	const invalid = run(launcher, ["unknown-command"], root);
	assert.equal(invalid.status, 2, invalid.stderr);

	if (html) {
		assert.equal(manifest.payloads.chromiumHeadlessShell, true);
		const course = join(root, "synthetic HTML course");
		await mkdir(course);
		await writeFile(join(course, "index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Practice lesson</title></head><body><main><h1>Practice lesson</h1><p>Read the paragraph, then continue.</p><button type="button">Continue</button></main></body></html>');
		const output = join(root, "HTML machine report.json");
		const result = run(launcher, ["check", course, "--json", output], root);
		assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
		const report = JSON.parse(await readFile(output, "utf8"));
		assert.equal(report.schemaVersion, 4);
		assert.equal(report.pages.length, 1);
		assert.ok(report.evaluations.length > 0);
		assert.ok(report.evaluations.some(item => item.outcome === "passed"));
		assert.equal(report.counts.confidence.high, 0);
		assert.ok(report.pages.every(page => page.audited));
		const versions = JSON.parse(await readFile(join(artifact, "dependencies/runtime-versions.json"), "utf8"));
		assert.equal(report.environment.browser.version, versions.browser.browserVersion);
		// A failing synthetic page checks that the wrapper preserves findings exit code 1 too.
		await writeFile(join(course, "index.html"), '<!doctype html><html lang="en"><head><title>Practice lesson</title></head><body><main><h1>Practice lesson</h1><button></button></main></body></html>');
		const failing = run(launcher, ["check", course, "--json", join(root, "failing report.json")], root);
		assert.equal(failing.status, 1, failing.stderr || failing.stdout);
	}

	if (!manifest.payloads.poppler) {
		assert.equal(manifest.payloads.java, false);
		assert.equal(manifest.payloads.veraPDF, false);
		const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"];
		let pdf = "%PDF-1.4\n";
		const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
		const xref = Buffer.byteLength(pdf);
		pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		const input = join(root, "synthetic input.pdf");
		const output = join(root, "PDF machine report.json");
		await writeFile(input, pdf);
		const result = run(launcher, ["check", input, "--json", output], root);
		assert.equal(result.status, 2, result.stderr || String(result.error));
		const report = JSON.parse(await readFile(output, "utf8"));
		assert.equal(report.machineStatus, "incomplete");
		assert.ok(report.evidence.some(item => item.tool === "pdfinfo" && /ENOENT/.test(item.error)));
		assert.ok(report.evaluations.some(item => item.rule === "pdf.open" && item.outcome === "untested"));
	}
}

test("standalone Check relocates and reports missing PDF tools with an empty PATH", async t => {
	const root = await scratch(t);
	const distribution = process.env.CHECK_NODE_DIST ?? (windows ? dirname(process.execPath) : dirname(dirname(process.execPath)));
	const supplied = join(root, "supplied Node distribution");
	await mkdir(join(supplied, windows ? "" : "bin"), { recursive: true });
	await cp(join(distribution, windows ? "node.exe" : "bin/node"), join(supplied, windows ? "node.exe" : "bin/node"));
	await cp(join(distribution, "LICENSE"), join(supplied, "LICENSE"));
	const staged = join(root, "staged");
	execFileSync(process.execPath, [fileURLToPath(new URL("package.mjs", import.meta.url)), "--node", supplied, "--output", staged]);
	await rm(supplied, { recursive: true });
	await proveArtifact(staged, root, false);
});

test("supplied browser artifact checks HTML after relocation with an empty PATH", { skip: !process.env.CHECK_ARTIFACT && "Set CHECK_ARTIFACT to prove a built browser artifact" }, async t => {
	const root = await scratch(t);
	const staged = join(root, "staged");
	await cp(process.env.CHECK_ARTIFACT, staged, { recursive: true });
	await proveArtifact(staged, root, true);
});

test("macOS target layout and inventory can be packaged without a Mac", async t => {
	const root = await scratch(t);
	const node = join(root, "macOS Node distribution");
	await mkdir(join(node, "bin"), { recursive: true });
	await writeFile(join(node, "bin/node"), "synthetic arm64 runtime");
	await writeFile(join(node, "LICENSE"), "synthetic runtime license");
	const output = await packageArtifact({ node, output: join(root, "artifact"), platform: "darwin", arch: "arm64" }, () => ({ version: "v24.19.0", platform: "darwin", arch: "arm64" }));
	const manifest = await verifyInventory(output);
	assert.equal(manifest.platform, "darwin");
	assert.equal(manifest.arch, "arm64");
	assert.equal(manifest.entryPoint, "bin/praxity-check");
	assert.equal(await readFile(join(output, "runtime/node"), "utf8"), "synthetic arm64 runtime");
	await assert.rejects(lstat(join(output, "runtime/node.exe")), /ENOENT/);
	const launcher = await readFile(join(output, "bin/praxity-check"), "utf8");
	assert.match(launcher, /^#!\/bin\/sh/);
	assert.match(launcher, /exec "\$CHECK_DIR\/runtime\/node" "\$CHECK_DIR\/lib\/cli.js" "\$@"/);
	assert.doesNotMatch(launcher, /dirname|node.exe/);
});

test("packaging rejects supplied Node and dependency target mismatches before writing output", async t => {
	const root = await scratch(t);
	const values = { node: root, output: join(root, "artifact"), platform: "win32", arch: "x64" };
	await assert.rejects(packageArtifact(values, () => ({ version: "v24.19.0", platform: "darwin", arch: "arm64" })), /Node target mismatch/);
	await writeFile(join(root, "LICENSE"), "synthetic license");
	await writeFile(join(root, "NOTICE.md"), "synthetic notice");
	await writeFile(join(root, "runtime-versions.json"), JSON.stringify({ platform: "darwin", arch: "arm64" }));
	await assert.rejects(packageArtifact({ ...values, dependencies: root }, () => ({ version: "v24.19.0", platform: "win32", arch: "x64" })), /Dependencies target mismatch/);
	await assert.rejects(lstat(values.output), /ENOENT/);
});

test("packaging rejects same-target stale browser metadata and missing browser notices", async t => {
	const root = await scratch(t);
	const node = join(root, "Node distribution");
	const dependencies = join(root, "dependencies");
	const output = join(root, "artifact");
	await mkdir(node);
	await mkdir(dependencies);
	await writeFile(join(node, "LICENSE"), "synthetic Node license");
	await writeFile(join(dependencies, "NOTICE.md"), "synthetic runtime notice");
	// A synthetic macOS cache makes stale-runtime rejection independent of the native host cache.
	const require = createRequire(import.meta.url);
	const core = createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json");
	const expected = JSON.parse(await readFile(join(dirname(core), "browsers.json"), "utf8")).browsers.find(browser => browser.name === "chromium-headless-shell");
	const browser = { ...expected, playwright: JSON.parse(await readFile(core, "utf8")).version };
	const cache = join(dependencies, "browsers", `chromium_headless_shell-${browser.revision}`, "chrome-headless-shell-mac-arm64");
	await mkdir(cache, { recursive: true });
	await writeFile(join(cache, "chrome-headless-shell"), "synthetic Mac runtime");
	await writeFile(join(cache, "LICENSE.headless_shell"), "synthetic browser license");
	await writeFile(join(cache, "ABOUT"), "synthetic credits");
	const values = { node, dependencies, output, platform: "darwin", arch: "arm64" };
	const inspector = () => ({ version: "v24.19.0", platform: "darwin", arch: "arm64" });
	for (const field of ["revision", "browserVersion", "playwright"]) {
		await writeFile(join(dependencies, "runtime-versions.json"), JSON.stringify({ platform: "darwin", arch: "arm64", browser: { ...browser, [field]: "stale" } }));
		await assert.rejects(packageArtifact(values, inspector), /does not match installed Playwright/);
	}
	await writeFile(join(dependencies, "runtime-versions.json"), JSON.stringify({ platform: "darwin", arch: "arm64", browser }));
	await rm(join(cache, "ABOUT"));
	await assert.rejects(packageArtifact(values, inspector), /lacks its executable, license or credits/);
	await assert.rejects(lstat(output), /ENOENT/);
});
