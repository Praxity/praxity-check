#!/usr/bin/env node
import { open, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const args = process.argv.slice(2);
try {
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
	if (args[0] === "compare-pdf") {
		const { pdfCompareCli } = await import("./pdf-compare.ts");
		process.exitCode = await pdfCompareCli(args);
	} else if (pdf && args[0] === "prepare-review") {
		const { pdfReviewCli } = await import("./pdf-review.ts");
		process.exitCode = await pdfReviewCli(args);
	} else if (pdf && args[0] === "check") {
		const { pdfCli } = await import("./pdf.ts");
		process.exitCode = await pdfCli(args);
	} else {
		await import("./html-cli.ts");
	}
} catch (error) {
	console.error(`praxity-check: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 2;
}
