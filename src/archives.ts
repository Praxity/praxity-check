import { gunzipSync } from "node:zlib";
import * as nodeFs from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
/** Extraction limits bound disk use when unpacking untrusted content. */
// Video-heavy courses can legitimately exceed 512MB unpacked. The ratio check
// below is what actually defends against a bomb; this cap only bounds disk use.
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_ENTRIES = 20000;
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
    component?: boolean;
    validateOnly?: boolean;
}
/** Below this, a high ratio is normal (a 40-byte file of zeroes compresses hard). */
const RATIO_FLOOR_BYTES = 1024 * 1024;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
export class UnsafeArchiveError extends Error {
}
/**
 * yauzl validates entry names and declared sizes itself and rejects with a plain
 * Error before our own guards ever see the entry. The archive is still refused,
 * but the caller cannot tell "malicious" from "corrupt" â€” so the ones that mean
 * an attack get relabelled. Our guards below stay in place for what yauzl does
 * not cover: symlinks, entry count, ratio, and real expanded bytes.
 */
const YAUZL_UNSAFE = /invalid relative path|absolute path|too many bytes in the stream|invalid characters in fileName/i;
export function asUnsafe(err: unknown): Error {
    if (err instanceof UnsafeArchiveError)
        return err;
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
export async function extractZip(zipPath: string | Buffer, root: string, limits: Limits = {}, files: typeof import("node:fs/promises") = nodeFs): Promise<void> {
    const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
    const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
    const maxRatio = limits.maxRatio ?? MAX_RATIO;
    const zipBytes = Buffer.isBuffer(zipPath) ? zipPath : limits.component ? await files.readFile(zipPath) : undefined;
    if (zipBytes && zipBytes.length > maxBytes)
        throw new UnsafeArchiveError("Component archive exceeds download limit");
    const seen = new Set<string>();
    const zip = await new Promise<yauzl.ZipFile>((ok, fail) => {
        const callback = (err: Error | null, file: yauzl.ZipFile) => err ? fail(err) : ok(file);
        if (zipBytes)
            yauzl.fromBuffer(zipBytes, { lazyEntries: true, autoClose: true }, callback);
        else
            yauzl.open(zipPath as string, { lazyEntries: true, autoClose: true }, callback);
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
                    const dest = limits.component ? entryPath(root, entry.fileName) : safeEntryPath(root, entry.fileName);
                    if (limits.component) {
                        const key = dest.toLowerCase();
                        if (seen.has(key))
                            throw new UnsafeArchiveError(`Duplicate archive path: ${entry.fileName}`);
                        seen.add(key);
                        const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
                        if (kind && kind !== 0x8000 && kind !== 0x4000)
                            throw new UnsafeArchiveError(`Archive contains a special file: ${entry.fileName}`);
                    }
                    if (entry.fileName.endsWith("/")) {
                        if (!limits.validateOnly)
                            await files.mkdir(dest, { recursive: true });
                        zip.readEntry();
                        return;
                    }
                    // The declared size is attacker-controlled, so it gates cheaply here and
                    // the real byte count below is what actually enforces the cap.
                    if (entry.uncompressedSize > RATIO_FLOOR_BYTES &&
                        entry.uncompressedSize / Math.max(entry.compressedSize, 1) > maxRatio) {
                        throw new UnsafeArchiveError(`archive entry has a suspicious compression ratio: ${entry.fileName}`);
                    }
                    if (limits.validateOnly) {
                        totalBytes += entry.uncompressedSize;
                        if (totalBytes > maxTotalBytes)
                            throw new UnsafeArchiveError(`archive expands beyond ${maxTotalBytes} bytes`);
                        zip.readEntry();
                        return;
                    }
                    await files.mkdir(dirname(dest), { recursive: true });
                    const file = await files.open(dest, limits.component ? "wx" : "w", limits.component ? ((entry.externalFileAttributes >>> 16) & 0o777) || 0o644 : 0o666);
                    try {
                        const read = await new Promise<NodeJS.ReadableStream>((ok, no) => {
                            zip.openReadStream(entry, (err, stream) => (err ? no(err) : ok(stream)));
                        });
                        read.on("data", (chunk: Buffer) => {
                            totalBytes += chunk.length;
                            if (totalBytes > maxTotalBytes) {
                                read.emit("error", new UnsafeArchiveError(`archive expands beyond ${maxTotalBytes} bytes`));
                            }
                        });
                        await pipeline(read, file.createWriteStream());
                    }
                    finally {
                        await file.close();
                    }
                    zip.readEntry();
                }
                catch (err) {
                    stop(err as Error);
                }
            })();
        });
        zip.readEntry();
    });
}
// Component archives are pinned, but extraction also enforces a filesystem boundary.
const maxBytes = 512 * 1024 * 1024;
function entryPath(root: string, name: string) {
    if (!name || name.includes("\\") || name.includes(":") || name.includes("\0") || name.startsWith("/") || name.split("/").includes(".."))
        throw new Error(`Unsafe archive path: ${name}`);
    if (name.split("/").some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
        throw new Error(`Unsafe archive path: ${name}`);
    const path = resolve(root, name);
    if (path !== root && !path.startsWith(root + sep))
        throw new Error(`Archive path escapes target: ${name}`);
    return path;
}
function tarNumber(bytes: Buffer) {
    const value = bytes.toString("ascii").replace(/\0/g, "").trim();
    if (value && !/^[0-7]+$/.test(value))
        throw new Error("Invalid tar number");
    const number = parseInt(value || "0", 8);
    if (!Number.isSafeInteger(number) || number < 0)
        throw new Error("Invalid tar size");
    return number;
}
function paxRecord(bytes: Buffer) {
    const values: Record<string, string> = {};
    for (let offset = 0; offset < bytes.length;) {
        const space = bytes.indexOf(32, offset), length = Number(bytes.subarray(offset, space).toString());
        if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length)
            throw new Error("Invalid PAX record");
        const text = bytes.subarray(space + 1, offset + length - 1).toString("utf8"), equals = text.indexOf("=");
        if (equals < 1)
            throw new Error("Invalid PAX field");
        values[text.slice(0, equals)] = text.slice(equals + 1);
        offset += length;
    }
    return values;
}
async function tarArchive(compressed: Buffer, root: string, files: typeof nodeFs) {
    const bytes = gunzipSync(compressed, { maxOutputLength: maxBytes });
    const text = (buffer: Buffer) => buffer.toString("utf8").split("\0")[0]!;
    const seen = new Set<string>(), links: {
        path: string;
        target: string;
    }[] = [];
    let pax: Record<string, string> = {}, longName: string | undefined, longLink: string | undefined, count = 0, ended = false;
    let expandedBytes = 0;
    const charge = (size: number) => {
        expandedBytes += size;
        if (expandedBytes > maxBytes)
            throw new UnsafeArchiveError(`archive expands beyond ${maxBytes} bytes`);
    };
    for (let offset = 0; offset + 512 <= bytes.length;) {
        const header = bytes.subarray(offset, offset + 512);
        offset += 512;
        if (header.every(byte => byte === 0)) {
            if (bytes.subarray(offset).some(byte => byte !== 0))
                throw new Error("Unexpected data after tar end");
            ended = true;
            break;
        }
        if (++count > MAX_ENTRIES)
            throw new Error("Too many component archive entries");
        const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (checksum !== tarNumber(header.subarray(148, 156)))
            throw new Error("Tar header checksum mismatch");
        const size = tarNumber(header.subarray(124, 136)), type = text(header.subarray(156, 157));
        if (offset + size > bytes.length)
            throw new Error("Truncated tar entry");
        const data = bytes.subarray(offset, offset + size);
        offset += Math.ceil(size / 512) * 512;
        if (type === "x") {
            pax = paxRecord(data);
            continue;
        }
        if (type === "g") {
            const global = paxRecord(data);
            if (global.path || global.linkpath || global.size)
                throw new Error("Unsafe global PAX path");
            continue;
        }
        if (type === "L") {
            longName = text(data);
            continue;
        }
        if (type === "K") {
            longLink = text(data);
            continue;
        }
        const prefix = text(header.subarray(345, 500)), name = pax.path ?? longName ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join("/");
        const targetName = pax.linkpath ?? longLink ?? text(header.subarray(157, 257));
        if (pax.size && Number(pax.size) !== size)
            throw new Error("Unsupported PAX size override");
        pax = {};
        longName = undefined;
        longLink = undefined;
        const path = entryPath(root, name), key = path.toLowerCase();
        if (seen.has(key))
            throw new Error(`Duplicate archive path: ${name}`);
        seen.add(key);
        if (type === "5") {
            await files.mkdir(path, { recursive: true });
            continue;
        }
        if (type === "1" || type === "2") {
            if (!targetName || targetName.startsWith("/") || targetName.includes(":") || targetName.includes("\\"))
                throw new Error(`Unsafe archive link: ${name}`);
            const target = entryPath(root, posix.normalize(type === "2" ? posix.join(posix.dirname(name), targetName) : targetName));
            links.push({ path, target });
            continue;
        }
        if (type !== "0" && type !== "")
            throw new Error(`Unsupported tar entry type: ${type}`);
        charge(data.length);
        await files.mkdir(dirname(path), { recursive: true });
        await files.writeFile(path, data, { flag: "wx", mode: tarNumber(header.subarray(100, 108)) & 0o777 });
    }
    if (!ended || longName || longLink || Object.keys(pax).length)
        throw new Error("Truncated tar archive");
    // Temurin links licence texts inside the archive. Materialize only internal regular files;
    // never create filesystem links or follow a link outside this staging directory.
    while (links.length) {
        let progress = false;
        for (let index = links.length - 1; index >= 0; index--) {
            const link = links[index]!;
            try {
                const target = await files.lstat(link.target);
                if (!target.isFile())
                    throw new Error(`Archive link target is not a file: ${link.target}`);
                // Materialized links consume disk space just like ordinary extracted files.
                charge(target.size);
                await files.mkdir(dirname(link.path), { recursive: true });
                await files.copyFile(link.target, link.path, nodeFs.constants.COPYFILE_EXCL);
                links.splice(index, 1);
                progress = true;
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
        }
        if (!progress)
            throw new Error("Archive contains unresolved or cyclic links");
    }
}
export async function extractComponentArchive(archive: string | { name: string; bytes: Buffer }, root: string, files: typeof nodeFs, validateOnly = false) {
    const path = typeof archive === "string" ? archive : archive.name;
    const bytes = typeof archive === "string" ? await files.readFile(archive) : archive.bytes;
    if (path.endsWith(".zip"))
        await extractZip(bytes, resolve(root), { maxTotalBytes: maxBytes, component: true, validateOnly }, files);
    else if (path.endsWith(".tar.gz") && !validateOnly)
        await tarArchive(bytes, resolve(root), files);
    else
        throw new Error(`Unsupported component archive: ${path}`);
}
