#!/usr/bin/env node
import { open, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { requireNode } from "./node-runtime.ts";

const args = process.argv.slice(2);
try {
	const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	requireNode(process.version, metadata.engines.node);
	const target = args[1] ? resolve(args[1]) : undefined;
	let pdf = false;
	if (["check", "prepare-review"].includes(args[0] ?? "") && target && !["--help", "-h"].includes(args[1]!) && (await stat(target)).isFile()) {
		const file = await open(target, "r");
		try {
			const buffer = Buffer.alloc(1024);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			const header = buffer.subarray(0, bytesRead);
			const zip = extname(target).toLowerCase() === ".zip" || header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
			pdf = !zip && (extname(target).toLowerCase() === ".pdf" || header.includes(Buffer.from("%PDF-")));
		} finally { await file.close(); }
	}
	if (args[0] === "setup") {
		const { setupCli, setupHost } = await import("./setup.ts");
		const { createInterface } = await import("node:readline/promises");
		const host = setupHost({ confirm: async component => {
			if (!process.stdin.isTTY) throw new Error("Interactive setup requires a terminal; use --yes to consent in scripts.");
			const terminal = createInterface({ input: process.stdin, output: process.stdout });
			try { return /^y(?:es)?$/i.test((await terminal.question(`Install ${component.id}? [y/N] `)).trim()); }
			finally { terminal.close(); }
		} });
		process.exitCode = await setupCli(args.slice(1), host);
	} else if (args[0] === "doctor") {
		const { doctorCli } = await import("./components.ts");
		process.exitCode = await doctorCli(args.slice(1));
	} else if (args[0] === "compare-pdf") {
		const { pdfCompareCli } = await import("./pdf-compare.ts");
		process.exitCode = await pdfCompareCli(args);
	} else if (pdf && args[0] === "prepare-review") {
		const { pdfReviewCli } = await import("./pdf-review.ts");
		process.exitCode = await pdfReviewCli(args);
	} else if (pdf && args[0] === "check") {
		const { pdfCli } = await import("./pdf.ts");
		process.exitCode = await pdfCli(args);
	} else {
		const { htmlCli } = await import("./html-cli.ts");
		process.exitCode = await htmlCli(args);
	}
} catch (error) {
	console.error(`praxity-check: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 2;
}
