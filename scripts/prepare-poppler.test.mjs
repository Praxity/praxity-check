import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";

test("relocated Poppler tools process a synthetic PDF with Homebrew reads denied", { skip: process.platform !== "darwin" || !process.env.CHECK_POPPLER_RUNTIME }, async t => {
	const root = await mkdtemp(join(tmpdir(), "relocated Poppler "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runtime = join(root, "runtime with spaces");
	await cp(process.env.CHECK_POPPLER_RUNTIME, runtime, { recursive: true });
	const provenance = JSON.parse(await readFile(join(runtime, "notices/provenance.json"), "utf8"));
	for (const file of provenance.files) {
		assert.equal(createHash("sha256").update(await readFile(file.source)).digest("hex"), file.sha256, `Host file changed: ${file.source}`);
		execFileSync("/usr/bin/codesign", ["--verify", "--strict", join(runtime, file.target)]);
	}
	const stream = "BT /F1 12 Tf 40 100 Td (Synthetic Poppler test) Tj ET\n";
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	const input = join(root, "synthetic.pdf");
	await writeFile(input, pdf);
	const profile = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(provenance.prefix)}))`;
	const env = { PATH: "/usr/bin:/bin", HOME: root };
	for (const [name, path] of Object.entries({ POPPLER_DATADIR: "share/poppler", FONTCONFIG_FILE: "etc/fonts/fonts.conf", FONTCONFIG_PATH: "etc/fonts" })) {
		try {
			await access(join(runtime, path));
			env[name] = join(runtime, path);
		} catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	const run = (tool, args) => execFileSync("/usr/bin/sandbox-exec", ["-p", profile, join(runtime, "bin", tool), ...args], { cwd: root, env, encoding: "utf8" });
	assert.match(run("pdfinfo", [input]), /Pages:\s+1/);
	assert.match(run("pdffonts", [input]), /Helvetica/);
	assert.match(run("pdftotext", [input, "-"]), /Synthetic Poppler test/);
	assert.match(run("pdfimages", ["-list", input]), /page\s+num/);
	run("pdftoppm", ["-scale-to", "200", "-singlefile", "-png", input, join(root, "page")]);
	assert.equal((await readFile(join(root, "page.png"))).subarray(1, 4).toString(), "PNG");
	assert.match(run("pdftohtml", ["-xml", "-stdout", input]), /Synthetic Poppler test/);
	assert.ok((await readFile(join(runtime, "NOTICE.md"))).length);
});

test("preparation rejects outside roots, unresolved dylibs and filename collisions before writing output", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async t => {
	const { prepareHomebrewRuntime } = await import("./prepare-poppler.mjs");
	const root = await mkdtemp(join(tmpdir(), "Poppler rejection "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const output = join(root, "output");
	await assert.rejects(prepareHomebrewRuntime({ roots: ["/usr/bin/true"], output }), /outside allowed source roots/);
	const source = join(root, "value.c");
	const dependency = join(root, "libgone.dylib");
	await writeFile(source, "int value(void) { return 1; }\n");
	execFileSync("/usr/bin/clang", ["-dynamiclib", source, "-o", dependency, "-install_name", dependency]);
	const dependent = join(root, "libdependent.dylib");
	await writeFile(source, "extern int value(void); int caller(void) { return value(); }\n");
	execFileSync("/usr/bin/clang", ["-dynamiclib", source, dependency, "-o", dependent]);
	await rm(dependency);
	await assert.rejects(prepareHomebrewRuntime({ roots: [dependent], sourceRoots: [root], output }), /Unresolved dependency/);
	await writeFile(source, "int value(void) { return 1; }\n");
	execFileSync("/usr/bin/clang", ["-dynamiclib", source, "-o", dependency]);
	const other = join(root, "other");
	await mkdir(other);
	await cp(dependency, join(other, "libgone.dylib"));
	await assert.rejects(prepareHomebrewRuntime({ roots: [dependency, join(other, "libgone.dylib")], sourceRoots: [root], output }), /Unsafe filename collision/);
	await assert.rejects(readFile(join(output, "NOTICE.md")), { code: "ENOENT" });
});
