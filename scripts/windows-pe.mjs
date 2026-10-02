import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

// These are OS components, not redistributable compiler runtimes such as vcruntime140.
const systemDlls = new Set(`advapi32 bcrypt bcryptprimitives cabinet comctl32 comdlg32 crypt32 cryptbase d2d1 d3d9 d3d11 dbghelp dnsapi dwrite dwmapi dxgi gdi32 gdiplus glu32 imm32 iphlpapi kernel32 kernelbase mpr msimg32 msvcrt netapi32 ntdll ole32 oleaut32 opengl32 powrprof propsys psapi rpcrt4 sechost secur32 setupapi shell32 shlwapi synchronization ucrtbase user32 userenv usp10 uxtheme version winhttp wininet winmm winspool wintrust ws2_32 wtsapi32`.split(" ").map(name => `${name}.dll`));
systemDlls.add("winspool.drv");
for (const name of ["winscard", "dsound", "mswsock", "ncrypt", "wsock32"]) systemDlls.add(`${name}.dll`);
export const isWindowsSystemDll = name => systemDlls.has(name.toLowerCase()) || /^(?:api|ext)-ms-win-[a-z0-9-]+\.dll$/i.test(name);

/** Read both ordinary and delay-load imports, without consulting the machine's PATH. */
export function windowsImports(bytes, name = "binary") {
	const fail = () => { throw new Error(`Invalid Windows x64 PE binary: ${name}`); };
	const bounds = (offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length) fail(); };
	bounds(0, 64);
	if (bytes.toString("ascii", 0, 2) !== "MZ") fail();
	const pe = bytes.readUInt32LE(0x3c);
	bounds(pe, 24);
	if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) fail();
	const sections = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20), optional = pe + 24;
	bounds(optional, optionalSize);
	if (optionalSize < 112 || bytes.readUInt16LE(optional) !== 0x20b) fail();
	const directoryCount = bytes.readUInt32LE(optional + 108);
	if (112 + Math.min(directoryCount, 16) * 8 > optionalSize) fail();
	const sectionTable = optional + optionalSize;
	bounds(sectionTable, sections * 40);
	const offsetOf = rva => {
		if (rva < bytes.readUInt32LE(optional + 60)) { bounds(rva, 1); return rva; }
		for (let i = 0; i < sections; i++) {
			const start = sectionTable + i * 40, address = bytes.readUInt32LE(start + 12), rawSize = bytes.readUInt32LE(start + 16);
			if (rva >= address && rva - address < rawSize) {
				const offset = bytes.readUInt32LE(start + 20) + rva - address;
				bounds(offset, 1); return offset;
			}
		}
		fail();
	};
	const stringAt = rva => {
		const offset = offsetOf(rva), end = bytes.indexOf(0, offset);
		if (end < offset || end - offset > 260) fail();
		const value = bytes.toString("ascii", offset, end);
		if (!/^[a-zA-Z0-9_.-]+\.(?:dll|drv)$/i.test(value)) fail();
		return value.toLowerCase();
	};
	const imports = [];
	for (const [index, size, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
		if (directoryCount <= index) continue;
		const entry = optional + 112 + index * 8, rva = bytes.readUInt32LE(entry), length = bytes.readUInt32LE(entry + 4);
		if (!rva && !length) continue;
		if (!rva || length < size) fail();
		const offset = offsetOf(rva);
		bounds(offset, length);
		let terminated = false;
		for (let cursor = offset; cursor + size <= offset + length; cursor += size) {
			if (bytes.subarray(cursor, cursor + size).every(byte => byte === 0)) { terminated = true; break; }
			let nameRva = bytes.readUInt32LE(cursor + nameOffset);
			if (index === 13 && !(bytes.readUInt32LE(cursor) & 1)) {
				const converted = BigInt(nameRva) - bytes.readBigUInt64LE(optional + 24);
				if (converted < 0n || converted > 0xffffffffn) fail();
				nameRva = Number(converted);
			}
			imports.push({ name: stringAt(nameRva), delay: index === 13 });
		}
		if (!terminated) fail();
	}
	return imports;
}

export async function validateWindowsPayload(root, { executables = [] } = {}) {
	const records = [];
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) {
				const bytes = await readFile(path);
				records.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes).digest("hex"), imports: windowsImports(bytes, path) });
			} else if (!entry.isFile()) throw new Error(`Windows payload must contain regular files: ${path}`);
		}
	}
	await visit(root);
	for (const executable of executables) if (!records.some(record => record.path.toLowerCase() === executable.replaceAll("\\", "/").toLowerCase())) throw new Error(`Missing Windows executable: ${executable}`);
	for (const record of records) {
		for (const imported of record.imports) {
			const candidates = [dirname(record.path), "bin", "bin/server"].map(directory => join(directory, imported.name).replaceAll("\\", "/").toLowerCase());
			const dependency = records.find(item => candidates.includes(item.path.toLowerCase()));
			if (dependency) imported.target = dependency.path;
			else if (isWindowsSystemDll(imported.name)) imported.system = true;
			else throw new Error(`Unresolved non-system DLL ${imported.name} imported by ${record.path}; dependency must be inside runtime`);
		}
	}
	return records;
}
