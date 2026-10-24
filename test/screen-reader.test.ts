import assert from "node:assert/strict";
import test from "node:test";

import { voiceOverGuidepupVersion, withCauses, clusterSpeechEvents, resolveScreenReaderPage } from "../src/screen-reader.ts";

test("screen-reader page stays on the local audit origin and keeps its query", () => {
	const pages = [{ file: "lesson/page.html", url: "http://127.0.0.1:41000/lesson/page.html" }];
	assert.deepEqual(
		resolveScreenReaderPage(pages, "http://127.0.0.1:41000", "lesson/page.html?mode=duplicate"),
		{ file: "lesson/page.html", url: "http://127.0.0.1:41000/lesson/page.html?mode=duplicate" },
	);
	assert.throws(
		() => resolveScreenReaderPage(pages, "http://127.0.0.1:41000", "https://example.com/page.html"),
		/inside the audited package/,
	);
});

test("speech-log bursts count as one event each", () => {
	assert.deepEqual(clusterSpeechEvents([4000, 4003, 4007, 6350, 6354]), [4000, 6350]);
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
	assert.equal(voiceOverGuidepupVersion(), "0.24.1", "VoiceOver evidence names the Guidepup that ran");
});
