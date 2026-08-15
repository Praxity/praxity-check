import assert from "node:assert/strict";
import test from "node:test";

import { clusterSpeechEvents, resolveScreenReaderPage } from "../src/screen-reader.ts";

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
