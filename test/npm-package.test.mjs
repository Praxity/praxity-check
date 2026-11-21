import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileRuntime } from "../scripts/package.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("npm runtime compilation emits every module, rewrites imports and removes stale output", async t => {
	await mkdir(join(root, "dist"), { recursive: true });
	const output = await mkdtemp(join(root, "dist", "npm-compile-"));
	t.after(() => rm(output, { recursive: true, force: true }));
	await writeFile(join(output, "obsolete.js"), "obsolete");
	await compileRuntime(output);
	const sources = await readdir(join(root, "src"));
	assert.deepEqual((await readdir(output)).sort(), sources.map(name => name.replace(/\.ts$/, ".js")).sort());
	for (const source of sources) {
		const compiled = await readFile(join(output, source.replace(/\.ts$/, ".js")), "utf8");
		assert.doesNotMatch(compiled, /(?:from\s*|import\s*\()["']\.\.?\/[^"']+\.ts["']/);
	}
	const cli = await readFile(join(output, "cli.js"), "utf8");
	assert.match(cli, /^#!\/usr\/bin\/env node\n/);
	assert.match(cli, /import\("\.\/components\.js"\)/);
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	assert.equal(pkg.bin["praxity-check"], "lib/cli.js");
	assert.equal(pkg.engines.node, ">=24.22.1 <25");
	assert.equal(pkg.private, true);
	assert.deepEqual(pkg.files, ["lib/", "notices/", "skill/", "README.md", "LICENSE", "LICENSING.md", "NOTICE.md"]);
});
