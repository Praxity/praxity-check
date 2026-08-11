import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discover } from "../src/discover.ts";

test("discover separates redirect stubs from auditable pages", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "prax-audit-discover-test-"));
	try {
		await mkdir(join(root, "nested"));
		await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
		await mkdir(join(root, ".hidden"));
		await Promise.all([
			writeFile(join(root, "lesson.html"), "<h1>Lesson</h1>"),
			writeFile(
				join(root, "meta-stub.html"),
				'<meta http-equiv="refresh" content="0;url=lesson.html">',
			),
			writeFile(
				join(root, "script-stub.html"),
				'<script>location.replace("lesson.html")</script>',
			),
			writeFile(
				join(root, "refreshing-content.html"),
				'<meta http-equiv="refresh" content="30;url=lesson.html"><p>This lesson remains visible while the learner decides whether to continue.</p>',
			),
			writeFile(
				join(root, "missing-stub.html"),
				'<meta http-equiv="refresh" content="0;url=missing.html">',
			),
			writeFile(join(root, "nested", "page.htm"), "<main>Nested lesson content</main>"),
			writeFile(join(root, "node_modules", "ignored", "package.html"), "<h1>Ignored</h1>"),
			writeFile(join(root, ".hidden", "secret.html"), "<h1>Hidden</h1>"),
		]);

		const result = await discover(root, "http://127.0.0.1:3000");

		await t.test("classifies a contentless meta refresh as a stub", () => {
			assert.ok(result.stubs.some(({ file }) => file === "meta-stub.html"));
			assert.ok(!result.pages.some(({ file }) => file === "meta-stub.html"));
		});

		await t.test("classifies a contentless location.replace as a stub", () => {
			assert.ok(result.stubs.some(({ file }) => file === "script-stub.html"));
			assert.ok(!result.pages.some(({ file }) => file === "script-stub.html"));
		});

		await t.test("keeps real content with a meta refresh as an auditable page", () => {
			assert.ok(
				result.pages.some(({ file }) => file === "refreshing-content.html"),
				"a meta refresh with real body content must remain an auditable page",
			);
			assert.ok(!result.stubs.some(({ file }) => file === "refreshing-content.html"));
		});

		await t.test("marks a stub with a missing target unresolved", () => {
			assert.deepEqual(
				result.stubs.find(({ file }) => file === "missing-stub.html"),
				{ file: "missing-stub.html", target: "missing.html", resolved: false },
			);
		});

		await t.test("finds nested pages and skips dependency and dot directories", () => {
			assert.ok(result.pages.some(({ file }) => file === join("nested", "page.htm")));
			assert.ok(![...result.pages, ...result.stubs].some(({ file }) => file.includes("node_modules")));
			assert.ok(![...result.pages, ...result.stubs].some(({ file }) => file.includes(".hidden")));
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
