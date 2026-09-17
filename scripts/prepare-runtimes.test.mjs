import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserRuntime, prepareRuntimes } from "./prepare-runtimes.mjs";

test("browser assembly rejects mismatched caches and requires browser license", async t => {
	const cache = await mkdtemp(join(tmpdir(), "check browsers "));
	t.after(() => rm(cache, { recursive: true, force: true }));
	await mkdir(join(cache, "chromium_headless_shell-1"));
	await assert.rejects(browserRuntime(cache), /ENOENT/);
	const { createRequire } = await import("node:module");
	const { dirname } = await import("node:path");
	const { readFile } = await import("node:fs/promises");
	const require = createRequire(import.meta.url);
	const core = createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json");
	const revision = JSON.parse(await readFile(join(dirname(core), "browsers.json"), "utf8")).browsers.find(item => item.name === "chromium-headless-shell").revision;
	const runtime = join(cache, `chromium_headless_shell-${revision}`, "chrome-headless-shell-mac-arm64");
	await mkdir(runtime, { recursive: true });
	await writeFile(join(runtime, "chrome-headless-shell"), "test executable");
	await assert.rejects(browserRuntime(cache), /LICENSE.headless_shell/);
	await writeFile(join(runtime, "LICENSE.headless_shell"), "test license");
	assert.equal((await browserRuntime(cache)).revision, revision);
});

test("assembly requires explicit sources", async () => {
	await assert.rejects(prepareRuntimes({}), /Required: --poppler|macOS arm64 only/);
});
