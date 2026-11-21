import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export interface DiscoveredPage {
	file: string;
	url: string;
}

export interface RedirectStub {
	file: string;
	target: string;
	resolved: boolean;
}

export interface Discovery {
	pages: DiscoveredPage[];
	stubs: RedirectStub[];
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

async function htmlFiles(root: string, dir = root, found: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) await htmlFiles(root, full, found);
		else if (/\.x?html?$/i.test(entry.name)) found.push(full);
	}
	return found;
}

interface Redirect {
	target: string;
	immediate: boolean;
}

function redirect(html: string): Redirect | null {
	const meta = html.match(
		/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']\s*([\d.]+)\s*;\s*url=([^"';]+)/i,
	);
	if (meta?.[2]) return { target: meta[2].trim(), immediate: Number(meta[1]) === 0 };
	const script = html.match(/location\.replace\(\s*["']([^"']+)["']/i);
	if (script?.[1]) return { target: script[1].trim(), immediate: true };
	return null;
}

const STUB_MAX_TEXT = 200;
const CONTENT_ELEMENT = /<(a\s|a>|img|button|input|select|textarea|video|audio|table|ul|ol|form|h[1-6])[\s>]/i;

function isStub(html: string): boolean {
	const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
	const stripped = body
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "");
	if (CONTENT_ELEMENT.test(stripped)) return false;
	const text = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	return text.length < STUB_MAX_TEXT;
}

function toUrl(origin: string, file: string): string {
	return `${origin}/${file.split(sep).map(encodeURIComponent).join("/")}`;
}

export async function discover(root: string, origin: string): Promise<Discovery> {
	const files = await htmlFiles(root);
	const known = new Set(files.map((f) => relative(root, f)));

	const pages: DiscoveredPage[] = [];
	const stubs: RedirectStub[] = [];

	for (const full of files.sort()) {
		const file = relative(root, full);
		const html = await readFile(full, "utf-8");
		const hop = redirect(html);

		if (hop?.immediate && isStub(html)) {
			const resolved = relative(root, resolve(root, file, "..", hop.target.split(/[?#]/)[0] ?? ""));
			stubs.push({ file, target: hop.target, resolved: known.has(resolved) });
			continue;
		}
		pages.push({ file, url: toUrl(origin, file) });
	}

	return { pages, stubs };
}
