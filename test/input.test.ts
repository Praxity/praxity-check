import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import { crc32, createDeflateRaw } from "node:zlib";

import { openInput, UnsafeArchiveError } from "../src/input.ts";

const MAX_TOTAL_BYTES = 1024 * 1024;
const TEST_LIMITS = { maxTotalBytes: MAX_TOTAL_BYTES };
const MAX_ENTRIES = 20_000;

type ZipEntry = {
	name: string;
	data?: Buffer;
	method?: 0 | 8;
	uncompressedSize?: number;
	externalAttributes?: number;
	crc?: number;
};

function zip(entries: readonly ZipEntry[]): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const data = entry.data ?? Buffer.alloc(0);
		const method = entry.method ?? 0;
		const size = entry.uncompressedSize ?? data.length;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x800, 6);
		header.writeUInt16LE(method, 8);
		header.writeUInt32LE(entry.crc ?? crc32(data), 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(size, 22);
		header.writeUInt16LE(name.length, 26);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(0x0314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(0x800, 8);
		directory.writeUInt16LE(method, 10);
		directory.writeUInt32LE(entry.crc ?? crc32(data), 16);
		directory.writeUInt32LE(data.length, 20);
		directory.writeUInt32LE(size, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE((entry.externalAttributes ?? 0) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);

		local.push(header, name, data);
		central.push(directory, name);
		offset += header.length + name.length + data.length;
	}

	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

async function rejection(path: string): Promise<unknown> {
	return openInput(path, TEST_LIMITS).then(
		async (input) => {
			await input.cleanup();
			return null;
		},
		(error: unknown) => error,
	);
}

async function deflatedZeros(size: number): Promise<{ data: Buffer; crc: number }> {
	const stream = createDeflateRaw({ level: 9 });
	const chunks: Buffer[] = [];
	stream.on("data", (chunk: Buffer) => chunks.push(chunk));
	const done = finished(stream);
	const block = Buffer.alloc(8 * 1024 * 1024);
	let checksum = 0;
	for (let remaining = size; remaining > 0; remaining -= block.length) {
		const chunk = block.subarray(0, Math.min(remaining, block.length));
		checksum = crc32(chunk, checksum);
		if (!stream.write(chunk)) {
			await once(stream, "drain");
		}
	}
	stream.end();
	await done;
	return { data: Buffer.concat(chunks), crc: checksum };
}

test("openInput rejects unsafe archives and extracts safe ones", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "prax-audit-input-test-"));
	try {
		await t.test("rejects zip slip without writing outside the extraction root", async () => {
			const controlledTmp = join(root, "tmp");
			await mkdir(controlledTmp);
			const archive = join(root, "zip-slip.zip");
			await writeFile(archive, zip([{ name: "../../escaped.txt", data: Buffer.from("escaped") }]));

			const previousTmp = process.env.TMPDIR;
			process.env.TMPDIR = controlledTmp;
			const error = await rejection(archive);
			if (previousTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmp;

			const escaped = await stat(join(root, "escaped.txt")).then(
				() => true,
				() => false,
			);
			assert.equal(escaped, false, "zip slip wrote outside the extraction root");
			assert.ok(
				error instanceof UnsafeArchiveError,
				error instanceof Error ? `expected UnsafeArchiveError, got: ${error.message}` : "no rejection",
			);
		});

		for (const [label, name] of [
			["POSIX absolute path", "/tmp/escaped.txt"],
			["Windows absolute path", String.raw`C:\escaped.txt`],
		] as const) {
			await t.test(`rejects a ${label}`, async () => {
				const archive = join(root, `${label.replaceAll(" ", "-")}.zip`);
				await writeFile(archive, zip([{ name, data: Buffer.from("escaped") }]));
				const error = await rejection(archive);
				assert.ok(
					error instanceof UnsafeArchiveError,
					error instanceof Error ? `expected UnsafeArchiveError, got: ${error.message}` : "no rejection",
				);
			});
		}

		await t.test("rejects symlink entries", async () => {
			const archive = join(root, "symlink.zip");
			await writeFile(
				archive,
				zip([
					{
						name: "link",
						data: Buffer.from("../../escaped.txt"),
						externalAttributes: 0xa000 << 16,
					},
				]),
			);
			assert.ok((await rejection(archive)) instanceof UnsafeArchiveError);
		});

		await t.test("rejects more than MAX_ENTRIES", async () => {
			const archive = join(root, "too-many.zip");
			await writeFile(
				archive,
				zip(Array.from({ length: MAX_ENTRIES + 1 }, () => ({ name: "directory/" }))),
			);
			assert.ok((await rejection(archive)) instanceof UnsafeArchiveError);
		});

		await t.test("rejects total expanded bytes over MAX_TOTAL_BYTES", async () => {
			const size = MAX_TOTAL_BYTES + 1;
			const compressed = await deflatedZeros(size);
			const padded = Buffer.concat([
				compressed.data,
				Buffer.alloc(Math.max(0, Math.ceil(size / 100) - compressed.data.length)),
			]);
			const archive = join(root, "decompression-bomb.zip");
			await writeFile(
				archive,
				zip([
					{ name: "bomb.bin", data: padded, method: 8, uncompressedSize: size, crc: compressed.crc },
				]),
			);
			assert.ok((await rejection(archive)) instanceof UnsafeArchiveError);
		});

		await t.test("enforces the streamed-byte cap when the header understates size", async () => {
			const archive = join(root, "lying-decompression-bomb.zip");
			const compressed = await deflatedZeros(MAX_TOTAL_BYTES + 1);
			await writeFile(
				archive,
				zip([
					{
						name: "bomb.bin",
						data: compressed.data,
						method: 8,
						uncompressedSize: 1,
						crc: compressed.crc,
					},
				]),
			);
			const error = await rejection(archive);
			assert.ok(
				error instanceof UnsafeArchiveError,
				error instanceof Error ? `expected UnsafeArchiveError, got: ${error.message}` : "no rejection",
			);
		});

		await t.test("extracts a normal zip and cleanup removes its temp directory", async () => {
			const archive = join(root, "safe.zip");
			await writeFile(
				archive,
				zip([{ name: "course/page.html", data: Buffer.from("<h1>Safe course</h1>") }]),
			);
			const input = await openInput(archive);
			assert.equal(input.wasZip, true);
			assert.equal(
				await readFile(join(input.root, "course/page.html"), "utf8"),
				"<h1>Safe course</h1>",
			);
			await input.cleanup();
			await assert.rejects(stat(input.root), { code: "ENOENT" });
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
