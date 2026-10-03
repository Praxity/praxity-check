import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { packageArtifact } from "./package.mjs";
import { syntheticPdfUa } from "./package-pdf-fixture.mjs";

const windows = process.platform === "win32";
const repository = fileURLToPath(new URL("../", import.meta.url));

test("operator instructions require doctor for component availability", async () => {
	for (const path of ["skill/SKILL.md", "docs/nvda-driver.md"]) {
		const text = await readFile(join(repository, path), "utf8");
		assert.match(text, /doctor pdf/, path);
		assert.doesNotMatch(text, /supplies headless Chromium|supplied dependency payload|Windows packages can include those runtimes/, path);
	}
});

test("operator instructions explain setup for optional components", async () => {
	for (const path of ["skill/SKILL.md", "docs/nvda-driver.md"]) {
		const text = await readFile(join(repository, path), "utf8");
		assert.match(text, /setup pdf/, path);
		if (path === "skill/SKILL.md") assert.match(text, /setup html/, path);
	}
});

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
	for (const path of ["notices/pdfium/FreeType-FTL.TXT", "notices/pdfium/PDFium-LICENSE", "notices/pdfium/OpenJPEG-LICENSE", "node_modules/@embedpdf/pdfium/LICENSE", "LICENSE", "LICENSING.md", "NOTICE.md", "THIRD-PARTY-NOTICES.md", "runtime/LICENSE", "node_modules/playwright-core/ThirdPartyNotices.txt", "node_modules/playwright/lib/transform/babelBundle.js.LICENSE"]) {
		assert.ok(manifest.legalFiles.includes(path), `Missing legal path: ${path}`);
	}
	for (const path of ["LICENSE", "LICENSING.md", "NOTICE.md", "skill/SKILL.md"]) {
		assert.deepEqual(await readFile(join(artifact, path)), await readFile(join(repository, path)));
	}
	return manifest;
}

function run(launcher, args, root, inherited = {}) {
	const env = windows
		? { PATH: join(root, "empty PATH"), SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, USERPROFILE: root }
		: { PATH: join(root, "empty PATH"), HOME: root, TMPDIR: root };
	if (process.env.CHECK_COMPONENTS_DIR) env.CHECK_COMPONENTS_DIR = process.env.CHECK_COMPONENTS_DIR;
 Object.assign(env, inherited);
	if (windows) {
		// Node cannot execFile a .cmd. The absolute system shell is the only external launcher tool.
		const command = `"${launcher}" ${args.map(arg => `"${arg}"`).join(" ")}`;
		return spawnSync(join(process.env.SystemRoot, "System32", "cmd.exe"), ["/d", "/s", "/c", `"${command}"`], { cwd: root, env, encoding: "utf8", windowsVerbatimArguments: true });
	}
	return spawnSync(launcher, args, { cwd: root, env, encoding: "utf8" });
}

async function verifyPng(path, expectedSha256) {
	const bytes = await readFile(path);
	assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256);
	return bytes;
}

async function proveWindowsPdf(launcher, root) {
	const input = join(root, "synthetic accessible letter.pdf");
	const source = syntheticPdfUa();
	await writeFile(input, source);
	const output = join(root, "PDF UA passing report.json");
	const passing = run(launcher, ["check", input, "--tier", "deterministic", "--checks", "accessibility", "--json", output], root, {
		JAVA_TOOL_OPTIONS: "-javaagent:missing.jar", JDK_JAVA_OPTIONS: "--invalid-option",
		_JAVA_OPTIONS: "-invalid-option", JAVA_OPTS: "-invalid-option", CLASSPATH_PREFIX: join(root, "external classpath"),
	});
	assert.equal(passing.status, 0, passing.stderr || passing.stdout || String(passing.error));
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.equal(report.machineStatus, "complete");
	assert.equal(report.pdfuaValidation.profile, "ua1");
	assert.equal(report.pdfuaValidation.machineCompliant, true);
	assert.equal(report.pdfuaValidation.coverage.status, "complete");
	assert.equal(report.findings.length, 0);
	assert.ok(report.evaluations.some(item => item.rule === "pdfua.machine" && item.outcome === "passed"));
	assert.equal(report.facts.pages.length, 1);
	assert.deepEqual(report.facts.words.map(word => word.text), ["A"]);
	for (const operation of ["open", "pages", "fonts", "images", "words"]) assert.ok(report.evidence.some(item => item.operation === operation && item.outcome === "passed"), operation + " must extract facts");

	// Changing this one PDF/UA requirement checks both the finding and launcher exit code.
	const failingInput = join(root, "synthetic title display failure.pdf");
	await writeFile(failingInput, syntheticPdfUa({ displayTitle: false }));
	const failingOutput = join(root, "PDF UA failing report.json");
	const failing = run(launcher, ["check", failingInput, "--tier", "deterministic", "--checks", "accessibility", "--json", failingOutput], root);
	assert.equal(failing.status, 1, failing.stderr || failing.stdout || String(failing.error));
	const failedReport = JSON.parse(await readFile(failingOutput, "utf8"));
	assert.equal(failedReport.machineStatus, "complete");
	assert.equal(failedReport.pdfuaValidation.profile, "ua1");
	assert.equal(failedReport.pdfuaValidation.machineCompliant, false);
	assert.equal(failedReport.pdfuaValidation.coverage.status, "complete");
	assert.ok(failedReport.findings.some(item => item.rule === "pdfua:ISO 14289-1:2014:7.1:10" && item.message === "The PDF is not set to display its document title."));
	assert.ok(failedReport.evaluations.some(item => item.rule === "pdfua.machine" && item.outcome === "failed"));

	const reviewDirectory = join(root, "PDF accessibility manual review");
	const review = run(launcher, ["prepare-review", input, "--tier", "inference", "--checks", "accessibility", "--reviewer", "manual", "--output", reviewDirectory], root);
	assert.equal(review.status, 0, review.stderr || review.stdout || String(review.error));
	const bundle = JSON.parse(await readFile(join(reviewDirectory, "manifest.json"), "utf8"));
	assert.equal(bundle.schemaVersion, "pdf-review-bundle-3");
	assert.equal(bundle.documentSha256, createHash("sha256").update(source).digest("hex"));
	assert.deepEqual(bundle.checks, ["accessibility"]);
	assert.deepEqual(bundle.selectedPages, [1]);
	assert.equal(bundle.artifacts.length, 1);
	await verifyPng(join(reviewDirectory, bundle.artifacts[0].image), bundle.artifacts[0].imageSha256);
	const facts = JSON.parse(await readFile(join(reviewDirectory, bundle.artifacts[0].facts), "utf8"));
	assert.deepEqual(facts.words.map(word => word.text), ["A"]);

	// Design evidence exercises real PDFium spans and detail crops.
	const designDirectory = join(root, "PDF design evidence manual review");
	const design = run(launcher, ["prepare-review", input, "--tier", "inference", "--checks", "design", "--reviewer", "manual", "--design-evidence", "--output", designDirectory], root);
	assert.equal(design.status, 0, design.stderr || design.stdout || String(design.error));
	const designBundle = JSON.parse(await readFile(join(designDirectory, "manifest.json"), "utf8"));
	const evidence = JSON.parse(await readFile(join(designDirectory, "design-evidence.json"), "utf8"));
	assert.equal(evidence.schemaVersion, "pdf-design-evidence-2");
	assert.equal(evidence.documentSha256, bundle.documentSha256);
	assert.deepEqual(designBundle.checks, ["design"]);
	assert.equal(evidence.engine.name, "PDFium");
	assert.equal(evidence.pages.length, 1);
	const page = evidence.pages[0];
	assert.equal(page.mappingSupported, true);
	assert.equal(page.extraction.engine.name, "PDFium");
	assert.deepEqual(page.spans.map(span => span.text), ["A"]);
	assert.ok(page.crops.length > 0, "Design evidence must retain an actual detail crop");
	const xml = await readFile(join(designDirectory, page.source));
	assert.equal(createHash("sha256").update(xml).digest("hex"), page.sourceSha256);
	for (const crop of page.crops) {
		assert.equal(crop.render.engine.name, "PDFium");
		const png = await verifyPng(join(designDirectory, crop.image), crop.imageSha256);
		assert.equal(png.readUInt32BE(16), crop.pixels.width);
		assert.equal(png.readUInt32BE(20), crop.pixels.height);
		assert.ok(designBundle.designEvidence.artifacts.some(item => item.path === crop.image && item.sha256 === crop.imageSha256));
	}
}

async function proveArtifact(staged, root, html) {
	const artifact = join(root, "relocated Check with spaces");
	await rename(staged, artifact);
	const manifest = await verifyInventory(artifact);
	assert.equal(manifest.platform, process.platform);
	assert.equal(manifest.arch, process.arch);
	const launcher = join(artifact, windows ? "bin/praxity-check.cmd" : "bin/praxity-check");
	assert.equal(manifest.entryPoint, windows ? "bin/praxity-check.cmd" : "bin/praxity-check");
	const launcherText = await readFile(launcher, "utf8");
	assert.doesNotMatch(launcherText, /(?:set "|export )PATH=/);
	assert.doesNotMatch(launcherText, /CHECK_POPPLER|POPPLER_DATADIR|FONTCONFIG/);
	assert.ok(manifest.files.some(f=>f.path==="node_modules/@embedpdf/pdfium/dist/pdfium.wasm"));
	assert.ok(manifest.files.some(f=>f.path==="node_modules/@embedpdf/pdfium/dist/index.js"));
	assert.ok(!manifest.files.some(f=>/poppler/i.test(f.path)));
 assert.ok(!manifest.files.some(f => /^(dependencies|browsers|java|verapdf)\//.test(f.path) || /chrome-headless-shell|cli-1\.30\.2\.jar|bin\/java(?:\.exe)?$/.test(f.path)));
 assert.equal(manifest.payloads.java,false);assert.equal(manifest.payloads.veraPDF,false);
 assert.doesNotMatch(launcherText,/PLAYWRIGHT_BROWSERS_PATH|JAVA_HOME|JAVACMD|VERAPDF/);
	const help = run(launcher, ["--help"], root);
	assert.equal(help.status, 0, help.stderr || String(help.error));
	assert.match(help.stdout, /compare-pdf/);
	const invalid = run(launcher, ["unknown-command"], root);
	assert.equal(invalid.status, 2, invalid.stderr);

	if (html) {
		assert.equal(manifest.payloads.chromiumHeadlessShell, false);
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
		assert.equal(report.environment.components[0].source, "setup");
		// A failing synthetic page checks that the wrapper preserves findings exit code 1 too.
		await writeFile(join(course, "index.html"), '<!doctype html><html lang="en"><head><title>Practice lesson</title></head><body><main><h1>Practice lesson</h1><button></button></main></body></html>');
		const failing = run(launcher, ["check", course, "--json", join(root, "failing report.json")], root);
		assert.equal(failing.status, 1, failing.stderr || failing.stdout);
	}


	assert.equal(manifest.payloads.pdfium, true);
	const input = join(root, "engine PDF.pdf"), output = join(root, "engine report.json");
	await writeFile(input, await readFile(join(repository, "test/fixtures/pdf-facts.pdf")));
	const checked = run(launcher, ["check", input, "--pdfua", "off", "--json", output], root);
	assert.equal(checked.status, 1, checked.stderr || checked.stdout || String(checked.error));
	const report = JSON.parse(await readFile(output,"utf8"));
	assert.equal(report.schemaVersion, "pdf-2");
	assert.equal(report.machineStatus, "complete");
	assert.deepEqual(report.facts.words.map(w=>w.text), ["PDF", "facts", "fixture"]);
	assert.equal(report.engine.version, "2.15.1");
	const reviewDir = join(root, "engine review");
	const prepared = run(launcher, ["prepare-review", input, "--checks", "design", "--tier", "inference", "--reviewer", "manual", "--design-evidence", "--output", reviewDir], root);
	assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout || String(prepared.error));
	const bundle = JSON.parse(await readFile(join(reviewDir, "manifest.json"),"utf8"));
	assert.equal(bundle.schemaVersion, "pdf-review-bundle-3");
	assert.equal(bundle.renderer.name, "PDFium");
	const png=await verifyPng(join(reviewDir,bundle.artifacts[0].image),bundle.artifacts[0].imageSha256);
	assert.equal(png.readUInt32BE(20),1600);
	if (windows && html) {
		await proveWindowsPdf(launcher, root);
	}
}

test("standalone Check relocates and reads and renders PDFs with an empty PATH", async t => {
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

test("supplied artifact uses setup components after relocation with an empty PATH", { skip: !process.env.CHECK_ARTIFACT && "Set CHECK_ARTIFACT to prove a built runtime artifact" }, async t => {
	if (!process.env.CHECK_COMPONENTS_DIR) throw new Error("CHECK_COMPONENTS_DIR is required to prove installed PDF and HTML components");
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
	assert.doesNotMatch(launcher, /export PATH=/);
	assert.match(launcher, /exec "\$CHECK_DIR\/runtime\/node" "\$CHECK_DIR\/lib\/cli.js" "\$@"/);
	assert.doesNotMatch(launcher, /dirname|node.exe/);
});

test("packaging rejects supplied Node and dependency target mismatches before writing output", async t => {
	const root = await scratch(t);
	const values = { node: root, output: join(root, "artifact"), platform: "win32", arch: "x64" };
	await assert.rejects(packageArtifact(values, () => ({ version: "v24.19.0", platform: "darwin", arch: "arm64" })), /Node target mismatch/);
	await assert.rejects(lstat(values.output), /ENOENT/);
});

test("package refuses runtime bundling before creating output", async t => {
 const root=await scratch(t);await writeFile(join(root,"LICENSE"),"fixture license");
 const output=join(root,"output");
 await assert.rejects(packageArtifact({node:root,output,dependencies:root},()=>({version:process.version,platform:process.platform,arch:process.arch})),/install components with check setup/);
 await assert.rejects(lstat(output),/ENOENT/);
});

test("package excludes hermetic browser caches inside npm dependencies", async t => {
	const root = await scratch(t), node = join(root, "Node"), dependency = join(root, "fake dependency");
	await mkdir(node); await writeFile(join(node, "node.exe"), "fixture Node"); await writeFile(join(node, "LICENSE"), "fixture licence");
	await mkdir(join(dependency, ".local-browsers", "chromium_headless_shell-1234"), { recursive: true });
	await writeFile(join(dependency, "package.json"), JSON.stringify({ version: "1.0.0", license: "MIT" }));
	await writeFile(join(dependency, "index.js"), "fixture dependency");
	await writeFile(join(dependency, ".local-browsers", "chromium_headless_shell-1234", "browser.exe"), "must not ship");
	const artifact = await packageArtifact({ node, output: join(root, "artifact"), platform: "win32", arch: "x64" }, () => ({ version: "v24.19.0", platform: "win32", arch: "x64" }), async () => dependency);
	const manifest = JSON.parse(await readFile(join(artifact, "capabilities.json"), "utf8"));
	assert.ok(manifest.files.some(file => file.path.endsWith("/index.js")));
	assert.ok(!manifest.files.some(file => file.path.includes(".local-browsers") || file.path.endsWith("/browser.exe")));
});
