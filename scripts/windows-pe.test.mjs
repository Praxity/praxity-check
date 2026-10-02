import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateWindowsPayload, windowsImports } from "./windows-pe.mjs";

function pe({ imports = [], delay = [], machine = 0x8664 } = {}) {
	const bytes = Buffer.alloc(2048), optional = 88, table = optional + 240;
	bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c);
	bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(machine, 68);
	bytes.writeUInt16LE(1, 70); bytes.writeUInt16LE(240, 84);
	bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(512, optional + 60); bytes.writeUInt32LE(16, optional + 108);
	bytes.writeUInt32LE(0x1000, table + 12); bytes.writeUInt32LE(1536, table + 16); bytes.writeUInt32LE(512, table + 20);
	let names = 1200;
	for (const [index, list, offset, size, nameOffset] of [[1, imports, 512, 20, 12], [13, delay, 800, 32, 4]]) {
		if (!list.length) continue;
		bytes.writeUInt32LE(offset - 512 + 0x1000, optional + 112 + index * 8);
		bytes.writeUInt32LE((list.length + 1) * size, optional + 116 + index * 8);
		for (const [i, name] of list.entries()) {
			if (index === 13) bytes.writeUInt32LE(1, offset + i * size);
			bytes.writeUInt32LE(names - 512 + 0x1000, offset + i * size + nameOffset);
			bytes.write(name, names); names += name.length + 1;
		}
	}
	return bytes;
}

test("PE imports include ordinary and delayed dependencies and reject other architectures", () => {
	assert.deepEqual(windowsImports(pe({ imports: ["KERNEL32.dll"], delay: ["codec.dll"] })), [{ name: "kernel32.dll", delay: false }, { name: "codec.dll", delay: true }]);
	for (const bytes of [Buffer.alloc(0), pe({ machine: 0xaa64 }), pe({ machine: 0x14c }), pe().subarray(0, 100)]) assert.throws(() => windowsImports(bytes), /Invalid Windows x64 PE/);
	const malformed = pe({ imports: ["kernel32.dll"] });
	malformed.writeUInt32LE(0xffffff, 512 + 12);
	assert.throws(() => windowsImports(malformed), /Invalid Windows x64 PE/);
});

test("runtime closure rejects missing DLLs including compiler runtimes and traverses delayed DLL imports", async t => {
	const root = await mkdtemp(join(tmpdir(), "check PE "));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "bin"));
	await writeFile(join(root, "bin/tool.exe"), pe({ imports: ["kernel32.dll"], delay: ["codec.dll"] }));
	await assert.rejects(validateWindowsPayload(root), /Unresolved non-system DLL codec.dll/);
	await writeFile(join(root, "bin/codec.dll"), pe({ imports: ["vcruntime140.dll"] }));
	await assert.rejects(validateWindowsPayload(root), /Unresolved non-system DLL vcruntime140.dll/);
	await writeFile(join(root, "bin/vcruntime140.dll"), pe({ imports: ["api-ms-win-crt-runtime-l1-1-0.dll"] }));
	const records = await validateWindowsPayload(root, { executables: ["bin/tool.exe"] });
	assert.equal(records.find(record => record.path === "bin/tool.exe").imports[1].target, "bin/codec.dll");
	assert.equal(records.find(record => record.path === "bin/vcruntime140.dll").imports[0].system, true);
	await assert.rejects(validateWindowsPayload(root, { executables: ["bin/missing.exe"] }), /Missing Windows executable/);
});
