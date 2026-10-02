// Where Guidepup keeps the screen reader assets that `@guidepup/setup install` downloads.
// Guidepup resolves the same paths internally but does not export them, so this mirrors
// its resolveCachePath and manifest lookup (Guidepup 0.34). Recheck after a Guidepup upgrade.

import { stat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface ManifestAsset { version: string }
interface Manifest { screenReaders: Array<{ id: string; assets: ManifestAsset[] }> }

export const SETUP_COMMAND = "corepack pnpm dlx @guidepup/setup@0.29.1 install";

export function guidepupCachePath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
	if (env.GUIDEPUP_SCREEN_READERS_PATH) return resolve(env.GUIDEPUP_SCREEN_READERS_PATH);
	if (platform === "darwin") return resolve(homedir(), "Library", "Caches", "guidepup");
	if (platform === "win32") return resolve(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "guidepup");
	return resolve(homedir(), ".cache", "guidepup");
}

export async function guidepupPackage(): Promise<{ root: string; version: string; manifest: Manifest }> {
	const require = createRequire(import.meta.url);
	const root = resolve(dirname(require.resolve("@guidepup/guidepup")), "..");
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
	const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
	return { root, version: pkg.version, manifest };
}

/** The portable NVDA executable and its asset version; throws with the install command if it is missing. */
export async function nvdaExecutable(cache = guidepupCachePath()): Promise<{ executable: string; assetVersion: string; guidepupVersion: string }> {
	const { manifest, version } = await guidepupPackage();
	const asset = manifest.screenReaders.find((reader) => reader.id === "nvda")?.assets[0];
	if (!asset) throw new Error("Guidepup manifest has no NVDA asset");
	const executable = join(cache, "nvda", "all", asset.version, "extracted", "nvda.exe");
	await stat(executable).catch((cause: unknown) => { throw new Error(`Portable NVDA is missing. Run ${SETUP_COMMAND} nvda`, { cause }); });
	return { executable, assetVersion: asset.version, guidepupVersion: version };
}
