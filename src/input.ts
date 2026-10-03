import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { MAX_TOTAL_BYTES, MAX_ENTRIES, asUnsafe, extractZip, type Limits } from "./archives.ts";
export { UnsafeArchiveError, type Limits } from "./archives.ts";

export interface Input {
	/** Directory to serve. For a zip, a temp dir; for a folder, the folder itself. */
	root: string;
	wasZip: boolean;
	cleanup: () => Promise<void>;
}

export async function openInput(inputPath: string, limits: Limits = {}): Promise<Input> {
	const target = resolve(inputPath);
	const info = await stat(target);

	if (info.isDirectory()) {
		return { root: target, wasZip: false, cleanup: async () => {} };
	}

	const root = await mkdtemp(join(tmpdir(), "praxity-check-"));
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

/** A private copy binds evidence to file contents, including local assets. */
export async function snapshotInput(inputPath: string): Promise<Input & { contentSha256: string }> {
	const source = await openInput(inputPath);
	const root = await mkdtemp(join(tmpdir(), "praxity-check-snapshot-"));
	let total = 0;
	let entries = 0;
	const files: Array<[string, string]> = [];
	const same = (a: import("node:fs").Stats, b: import("node:fs").Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
	const copy = async (relative = "") => {
		const directory = join(source.root, relative);
		const before = await lstat(directory);
		if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Snapshot input must contain only regular files and directories; symlinks are unsupported");
		for (const entry of (await readdir(directory)).sort()) {
			if (++entries > MAX_ENTRIES) throw new Error(`Snapshot exceeds ${MAX_ENTRIES} entries`);
			const name = relative ? `${relative}/${entry}` : entry;
			const path = join(source.root, name);
			const info = await lstat(path);
			if (info.isDirectory()) {
				await mkdir(join(root, name), { mode: 0o700 });
				await copy(name);
			} else {
				if (!info.isFile() || info.isSymbolicLink()) throw new Error("Snapshot input must contain only regular files and directories; symlinks are unsupported");
				const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				const hash = createHash("sha256");
				try {
					if (!same(info, await file.stat())) throw new Error("Input changed while preparing snapshot");
					await pipeline(file.createReadStream({ autoClose: false }), async function* (chunks) {
						for await (const chunk of chunks) {
							total += chunk.length;
							if (total > MAX_TOTAL_BYTES) throw new Error(`Snapshot exceeds ${MAX_TOTAL_BYTES} bytes`);
							hash.update(chunk);
							yield chunk;
						}
					}, createWriteStream(join(root, name), { flags: "wx", mode: 0o400 }));
					if (!same(info, await file.stat()) || !same(info, await lstat(path))) throw new Error("Input changed while preparing snapshot");
				} finally { await file.close(); }
				files.push([name, hash.digest("hex")]);
			}
		}
		if (!same(before, await lstat(directory))) throw new Error("Input changed while preparing snapshot");
	};
	try {
		await copy();
		return { root, wasZip: source.wasZip, contentSha256: createHash("sha256").update(JSON.stringify(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex"), cleanup: () => rm(root, { recursive: true, force: true }) };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	} finally { await source.cleanup(); }
}

/** Resolve existing parents so an output alias cannot overwrite the input. */
export async function assertOutputOutside(output: string, protectedPaths: string[]) {
	const canonical = async (path: string): Promise<string> => {
		try { return await realpath(path); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return join(await canonical(dirname(path)), basename(path));
		}
	};
	const destination = await canonical(resolve(output));
	for (const path of protectedPaths) {
		const protectedPath = await canonical(resolve(path));
		if (destination === protectedPath || destination.startsWith(protectedPath + sep)) throw new Error("Output must be outside the input and retained review bundle");
	}
}
