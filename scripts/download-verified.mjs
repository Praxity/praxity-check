import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export async function downloadVerified(input, path, { fetchFile = fetch } = {}) {
	let bytes;
	try { bytes = await readFile(path); } catch (error) {
		if (error.code !== "ENOENT") throw error;
		const response = await fetchFile(input.url);
		if (!response.ok) throw new Error(`Download failed (${response.status}): ${input.url}`);
		bytes = Buffer.from(await response.arrayBuffer());
		// A caller may execute this path, so unverified bytes must never be written there.
		if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error(`SHA-256 mismatch: ${input.url}`);
		await writeFile(path, bytes, { flag: "wx" });
	}
	if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error(`SHA-256 mismatch: ${path}`);
	return path;
}
