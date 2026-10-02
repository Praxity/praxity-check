import { resolve } from "node:path";

export function popplerExecutable(tool: string): string {
	const bin = process.env.CHECK_POPPLER_BIN;
	// A declared bundle is authoritative; absolute paths let missing tools fail without PATH fallback.
	return bin === undefined ? tool : resolve(bin, `${tool}${process.platform === "win32" ? ".exe" : ""}`);
}
