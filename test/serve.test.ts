import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isAuditServerUrl, serve } from "../src/serve.ts";

test("network requests are limited to the audit server origin", () => {
	const origin = "http://127.0.0.1:4173";
	for (const [url, expected] of [
		["http://127.0.0.1:4173/page.html", true],
		["ws://127.0.0.1:4173/events", true],
		["http://127.0.0.1:3000/api", false],
		["http://localhost:4173/page.html", false],
		["https://127.0.0.1:4173/page.html", false],
		["http://127.0.0.1.example:4173/page.html", false],
	] as const) assert.equal(isAuditServerUrl(url, origin), expected, url);
});

function request(origin: string, path: string): Promise<{ status: number; body: Buffer }> {
	const url = new URL(origin);
	return new Promise((resolve, reject) => {
		get(
			{ hostname: url.hostname, port: url.port, path },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
				);
			},
		).on("error", reject);
	});
}

test("serve keeps static files inside a loopback-only root", async (t) => {
	const fixture = await mkdtemp(join(tmpdir(), "prax-audit-serve-test-"));
	const root = join(fixture, "public");
	await mkdir(root);
	const page = Buffer.from("<!doctype html><title>Literal page</title>");
	await writeFile(join(root, "page.html"), page);
	const outside = join(fixture, "secret.txt");
	await writeFile(outside, "secret");
	await symlink(outside, join(root, "linked-secret.txt"));

	try {
		const server = await serve(root);
		try {
			await t.test("serves a literal .html URL with its own bytes", async () => {
				const response = await request(server.origin, "/page.html");
				assert.equal(response.status, 200);
				assert.deepEqual(response.body, page);
			});

			await t.test("rejects plain and percent-encoded traversal", async () => {
				for (const path of [
					"/../../etc/passwd",
					"/%2e%2e%2f%2e%2e%2fetc/passwd",
					"/..%2f..%2fetc/passwd",
				]) {
					assert.equal((await request(server.origin, path)).status, 404, path);
				}
			});

			await t.test("does not serve a symlink whose target is outside the root", async () => {
				assert.equal((await request(server.origin, "/linked-secret.txt")).status, 404);
			});

			await t.test("rejects a null byte in the path", async () => {
				assert.equal((await request(server.origin, "/page.html%00.txt")).status, 404);
			});

			await t.test("binds only to IPv4 loopback", () => {
				assert.equal(new URL(server.origin).hostname, "127.0.0.1");
			});
		} finally {
			await server.close();
		}
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});
