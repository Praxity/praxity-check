import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareWindowsPoppler, validateWindowsPoppler } from "./prepare-poppler-windows.mjs";

test("Windows Poppler preparation rejects missing data, notices, sources and changed binary bytes", { skip: process.platform !== "win32" || !process.env.CHECK_POPPLER_INSTALL }, async t => {
	const root = await mkdtemp(join(tmpdir(), "Check Poppler validation "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "supplied source build");
	await cp(process.env.CHECK_POPPLER_INSTALL, source, { recursive: true });
	await validateWindowsPoppler(source);
	for (const path of ["share/poppler/cMap/Adobe-Japan1/UniJIS-UTF16-H", "etc/fonts/fonts.conf", "notices/dependencies/fontconfig/copyright", "notices/poppler/poppler-26.03.0.tar.xz", "notices/toolchain/sdk_license.rtf"]) {
		const saved = await readFile(join(source, path));
		await rm(join(source, path));
		const output = join(root, "rejected output");
		await assert.rejects(prepareWindowsPoppler(source, output), /ENOENT/);
		await assert.rejects(readFile(join(output, "bin/pdfinfo.exe")), /ENOENT/);
		await writeFile(join(source, path), saved);
	}
	const cmap = join(source, "share/poppler/cMap/Adobe-Japan1/UniJIS-UTF16-H"), originalCmap = await readFile(cmap);
	await writeFile(cmap, "");
	await assert.rejects(prepareWindowsPoppler(source, join(root, "corrupt data output")), /data file hash differs/);
	await writeFile(cmap, originalCmap);
	const executable = join(source, "bin/pdfinfo.exe"), saved = await readFile(executable);
	await writeFile(executable, Buffer.concat([saved, Buffer.from("changed")]));
	await assert.rejects(prepareWindowsPoppler(source, join(root, "changed output")), /binary hash differs/);
	await writeFile(executable, saved);
	await assert.rejects(prepareWindowsPoppler(source, source), /outside source runtime/);
	const output = join(root, "existing output");
	await mkdir(output);
	await writeFile(join(output, "kept"), "keep this file");
	await assert.rejects(prepareWindowsPoppler(source, output), /EEXIST/);
	assert.equal(await readFile(join(output, "kept"), "utf8"), "keep this file");
});
