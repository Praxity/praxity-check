import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { guidepupCachePath, nvdaExecutable } from "../src/guidepup-assets.ts";
import { voiceOverGuidepupVersion, withCauses } from "../src/screen-reader.ts";

test("Guidepup's asset cache follows its override and per-platform defaults", () => {
	assert.equal(guidepupCachePath("darwin", { GUIDEPUP_SCREEN_READERS_PATH: "relative-cache" }), resolve("relative-cache"));
	assert.equal(guidepupCachePath("darwin", {}), resolve(homedir(), "Library", "Caches", "guidepup"));
	assert.equal(guidepupCachePath("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }), resolve("C:\\Users\\a\\AppData\\Local", "guidepup"));
	assert.equal(guidepupCachePath("linux", {}), resolve(homedir(), ".cache", "guidepup"));
});

test("a missing portable NVDA names the install command", async (t) => {
	const cache = await mkdtemp(join(tmpdir(), "praxity-guidepup-cache-"));
	t.after(() => rm(cache, { recursive: true, force: true }));
	await assert.rejects(nvdaExecutable(cache), /Portable NVDA is missing\. Run corepack pnpm dlx @guidepup\/setup@\S+ install nvda/);
});

test("start failures keep Guidepup's underlying cause in the message", () => {
	const mount = new Error("Failed to mount Guidepup VoiceOver preferences", { cause: new Error("hdiutil: attach failed\nmore detail") });
	const started = new Error("VoiceOver cannot be started", { cause: mount });
	assert.equal(withCauses(started).message, "VoiceOver cannot be started: Failed to mount Guidepup VoiceOver preferences: hdiutil: attach failed");
	assert.equal(withCauses(new Error("VoiceOver cannot be started\nVoiceOver cannot be started")).message, "VoiceOver cannot be started");
	assert.equal(withCauses("plain").message, "plain");
});

test("VoiceOver stays on the Guidepup version its workflow was validated with", async () => {
	// Guidepup 0.34.0 fails to start VoiceOver when its portable `.scrd.vou` is a directory.
	// Move VoiceOver only after a Mac run passes on the newer version.
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	assert.equal(require("@guidepup/guidepup-voiceover/package.json").version, "0.24.1");
	assert.equal(voiceOverGuidepupVersion(), "0.24.1", "VoiceOver evidence names the Guidepup that ran, not the NVDA pin");
});
