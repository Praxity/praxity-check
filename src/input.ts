import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

/**
 * Extraction limits. We execute untrusted JavaScript from a downloaded archive,
 * so these are a security boundary, not tuning knobs (spec §4).
 */
// Video-heavy courses can legitimately exceed 512MB unpacked. The ratio check
// below is what actually defends against a bomb; this cap only bounds disk use.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_RATIO = 100;

/**
 * Injectable so the bomb tests can assert the caps with a small fixture. Proving
 * the 4GiB cap otherwise needs a 4GiB fixture, and a test too expensive to run
 * is a test that stops being run.
 */
export interface Limits {
	maxTotalBytes?: number;
	maxEntries?: number;
	maxRatio?: number;
}
/** Below this, a high ratio is normal (a 40-byte file of zeroes compresses hard). */
const RATIO_FLOOR_BYTES = 1024 * 1024;

const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

export interface Input {
	/** Directory to serve. For a zip, a temp dir; for a folder, the folder itself. */
	root: string;
	wasZip: boolean;
	cleanup: () => Promise<void>;
}

export class UnsafeArchiveError extends Error {}

/**
 * yauzl validates entry names and declared sizes itself and rejects with a plain
 * Error before our own guards ever see the entry. The archive is still refused,
 * but the caller cannot tell "malicious" from "corrupt" — so the ones that mean
 * an attack get relabelled. Our guards below stay in place for what yauzl does
 * not cover: symlinks, entry count, ratio, and real expanded bytes.
 */
const YAUZL_UNSAFE = /invalid relative path|absolute path|too many bytes in the stream|invalid characters in fileName/i;

function asUnsafe(err: unknown): Error {
	if (err instanceof UnsafeArchiveError) return err;
	const message = err instanceof Error ? err.message : String(err);
	return YAUZL_UNSAFE.test(message) ? new UnsafeArchiveError(message) : (err as Error);
}

/**
 * Reject before extracting, not after. A path is safe only if it resolves inside
 * the destination -- checking for ".." misses symlink chains and absolute paths
 * on the other platform's separator.
 */
function safeEntryPath(root: string, fileName: string): string {
	if (isAbsolute(fileName) || /^[a-zA-Z]:/.test(fileName)) {
		throw new UnsafeArchiveError(`archive entry has an absolute path: ${fileName}`);
	}
	if (fileName.split(/[\\/]/).includes("..")) {
		throw new UnsafeArchiveError(`archive entry escapes the root: ${fileName}`);
	}
	const dest = resolve(root, fileName);
	if (dest !== root && !dest.startsWith(root + sep)) {
		throw new UnsafeArchiveError(`archive entry escapes the root: ${fileName}`);
	}
	return dest;
}

function isSymlink(entry: yauzl.Entry): boolean {
	return ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;
}

async function extractZip(zipPath: string, root: string, limits: Limits = {}): Promise<void> {
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
	const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
	const maxRatio = limits.maxRatio ?? MAX_RATIO;
	const zip = await new Promise<yauzl.ZipFile>((ok, fail) => {
		yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, file) =>
			err ? fail(err) : ok(file),
		);
	});

	let entries = 0;
	let totalBytes = 0;

	await new Promise<void>((done, fail) => {
		const stop = (err: Error) => {
			zip.close();
			fail(err);
		};

		zip.on("error", fail);
		zip.on("end", () => done());
		zip.on("entry", (entry: yauzl.Entry) => {
			void (async () => {
				try {
					if (++entries > maxEntries) {
						throw new UnsafeArchiveError(`archive has more than ${maxEntries} entries`);
					}
					if (isSymlink(entry)) {
						throw new UnsafeArchiveError(`archive contains a symlink: ${entry.fileName}`);
					}

					const dest = safeEntryPath(root, entry.fileName);

					if (entry.fileName.endsWith("/")) {
						await mkdir(dest, { recursive: true });
						zip.readEntry();
						return;
					}

					// The declared size is attacker-controlled, so it gates cheaply here and
					// the real byte count below is what actually enforces the cap.
					if (
						entry.uncompressedSize > RATIO_FLOOR_BYTES &&
						entry.uncompressedSize / Math.max(entry.compressedSize, 1) > maxRatio
					) {
						throw new UnsafeArchiveError(
							`archive entry has a suspicious compression ratio: ${entry.fileName}`,
						);
					}

					await mkdir(dirname(dest), { recursive: true });
					const read = await new Promise<NodeJS.ReadableStream>((ok, no) => {
						zip.openReadStream(entry, (err, stream) => (err ? no(err) : ok(stream)));
					});

					read.on("data", (chunk: Buffer) => {
						totalBytes += chunk.length;
						if (totalBytes > maxTotalBytes) {
							read.emit(
								"error",
								new UnsafeArchiveError(`archive expands beyond ${maxTotalBytes} bytes`),
							);
						}
					});

					await pipeline(read, createWriteStream(dest));
					zip.readEntry();
				} catch (err) {
					stop(err as Error);
				}
			})();
		});

		zip.readEntry();
	});
}

export async function openInput(inputPath: string, limits: Limits = {}): Promise<Input> {
	const target = resolve(inputPath);
	const info = await stat(target);

	if (info.isDirectory()) {
		return { root: target, wasZip: false, cleanup: async () => {} };
	}

	const root = await mkdtemp(join(tmpdir(), "prax-audit-"));
	try {
		await extractZip(target, root, limits);
	} catch (err) {
		await rm(root, { recursive: true, force: true });
		throw asUnsafe(err);
	}
	return {
		root,
		wasZip: true,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
