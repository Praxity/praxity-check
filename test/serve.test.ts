import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isAuditServerUrl, serve } from "../src/serve.ts";

test("network requests are limited to the check server origin", () => {
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

function request(
	origin: string,
	path: string,
	options: Pick<RequestOptions, "method" | "headers"> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
	const url = new URL(origin);
	return new Promise((resolve, reject) => {
		httpRequest(
			{ hostname: url.hostname, port: url.port, path, ...options },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
				);
				response.on("error", reject);
			},
		).on("error", reject).end();
	});
}

test("serve keeps static files inside a loopback-only root", async (t) => {
	const fixture = await mkdtemp(join(tmpdir(), "praxity-check-serve-test-"));
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

test("serve reports file lengths and supports single byte ranges", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "praxity-check-ranges-test-"));
	const wav = Buffer.alloc(244);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(236, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(8000, 24);
	wav.writeUInt32LE(16000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(200, 40);
	for (let offset = 44; offset < wav.length; offset++) wav[offset] = offset;
	await writeFile(join(root, "audio.wav"), wav);
	await writeFile(join(root, "empty.txt"), "");

	try {
		const server = await serve(root);
		try {
			await t.test("full WAV response advertises its length and byte ranges", async () => {
				const response = await request(server.origin, "/audio.wav");
				assert.equal(response.status, 200);
				assert.equal(response.headers["content-type"], "audio/wav");
				assert.equal(response.headers["content-length"], "244");
				assert.equal(response.headers["accept-ranges"], "bytes");
				assert.equal(response.headers["cache-control"], "no-store");
				assert.equal(response.headers["content-range"], undefined);
				assert.deepEqual(response.body, wav);
			});

			for (const [range, start, end] of [
				["bytes=0-99", 0, 99],
				["bytes=0-0", 0, 0],
				["bytes=100-", 100, 243],
				["bytes=-20", 224, 243],
				["bytes=240-999", 240, 243],
				["bytes=-999999999999999999999999", 0, 243],
				["bytes=240-999999999999999999999999", 240, 243],
				["BYTES=0-99", 0, 99],
			] as const) {
				await t.test(`serves ${range} with exact bytes and range metadata`, async () => {
					const response = await request(server.origin, "/audio.wav", { headers: { range } });
					assert.equal(response.status, 206);
					assert.equal(response.headers["content-type"], "audio/wav");
					assert.equal(response.headers["accept-ranges"], "bytes");
					assert.equal(response.headers["content-range"], `bytes ${start}-${end}/244`);
					assert.equal(response.headers["content-length"], String(end - start + 1));
					assert.deepEqual(response.body, wav.subarray(start, end + 1));
				});
			}

			await t.test("rejects malformed, multiple, and unsatisfiable ranges", async () => {
				for (const range of [
					"bytes=244-", "bytes=999999999999999999999999-", "bytes=99-0",
					"bytes=-0", "bytes=-", "bytes=", "bytes=abc-def", "bytes=0-1,4-5",
					"bytes=1.5-2", "bytes=+1-2", "bytes=0--1", "bytes=0-1 trailing",
				]) {
					const response = await request(server.origin, "/audio.wav", { headers: { range } });
					assert.equal(response.status, 416, range);
					assert.equal(response.headers["content-range"], "bytes */244", range);
					assert.equal(response.headers["content-length"], "0", range);
					assert.equal(response.body.length, 0, range);
				}
			});

			await t.test("HEAD reports full length without a body and ignores Range", async () => {
				for (const headers of [{}, { range: "bytes=0-99" }, { range: "bytes=invalid" }]) {
					const response = await request(server.origin, "/audio.wav", { method: "HEAD", headers });
					assert.equal(response.status, 200);
					assert.equal(response.headers["content-length"], "244");
					assert.equal(response.headers["accept-ranges"], "bytes");
					assert.equal(response.headers["content-range"], undefined);
					assert.equal(response.body.length, 0);
				}
			});

			await t.test("empty files have zero length and reject byte ranges", async () => {
				const full = await request(server.origin, "/empty.txt");
				assert.equal(full.status, 200);
				assert.equal(full.headers["content-length"], "0");
				assert.equal(full.body.length, 0);
				for (const range of ["bytes=0-0", "bytes=0-", "bytes=-1"]) {
					const response = await request(server.origin, "/empty.txt", { headers: { range } });
					assert.equal(response.status, 416, range);
					assert.equal(response.headers["content-range"], "bytes */0", range);
					assert.equal(response.headers["content-length"], "0", range);
					assert.equal(response.body.length, 0, range);
				}
			});
		} finally {
			await server.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
