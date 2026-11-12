import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const hash = "a".repeat(64);
export async function retainedBundle(pageCount = 3) {
	const directory = await mkdtemp(join(tmpdir(), "pdf-acceptance-test-"));
	const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
	const artifacts = [];
	for (const page of [1, 2]) {
		const image = `page-${page}.png`, facts = `page-${page}.json`;
		const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), factsBytes = JSON.stringify({ page, words: [] });
		await writeFile(join(directory, image), imageBytes);
		await writeFile(join(directory, facts), factsBytes);
		artifacts.push({ page, image, imageSha256: sha256(imageBytes), facts, factsSha256: sha256(factsBytes) });
	}
	const manifest = { schemaVersion: "pdf-review-bundle-2", documentSha256: hash, pageCount, selectedPages: [1, 2], tier: "inference", focus: "visual", checks: ["design"], coverage: pageCount === 2 ? "all-pages" : "sample", context: { audience: "New staff", use: "Read instructions" }, artifacts };
	const manifestBytes = JSON.stringify(manifest), manifestPath = join(directory, "manifest.json");
	await writeFile(manifestPath, manifestBytes);
	const boundReview = { schemaVersion: "pdf-review-4", documentSha256: hash, bundleSha256: sha256(manifestBytes), tier: "inference", focus: "visual", checks: ["design"], pagesReviewed: [1], reviewer: { model: "test-model" }, findings: [] };
	return { directory, manifest, manifestPath, boundReview };
}
