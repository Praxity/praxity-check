import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

/**
 * `npx serve` 301-rewrites `.html` to clean URLs, which strands an automated
 * browser on the wrong page and has already cost a debugging session. This
 * server never rewrites and never redirects.
 */

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".vtt": "text/vtt",
	".pdf": "application/pdf",
};

export interface StaticServer {
	origin: string;
	close: () => Promise<void>;
}

/** HTTP and WebSocket requests may reach only the server started for this run. */
export function isAuditServerUrl(value: string, serverOrigin: string): boolean {
	const url = new URL(value);
	if (url.protocol === "ws:") url.protocol = "http:";
	if (url.protocol === "wss:") url.protocol = "https:";
	return url.origin === new URL(serverOrigin).origin;
}

/**
 * Resolve a request path inside the root, following symlinks before the
 * containment check -- a folder input can contain a link pointing anywhere.
 * Returns null when the target is outside the root or missing.
 */
export async function resolveWithinRoot(root: string, urlPath: string): Promise<string | null> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;

	const relative = decoded.replace(/^\/+/, "");
	const candidate = relative === "" ? join(root, "index.html") : resolve(root, relative);

	try {
		const real = await realpath(candidate);
		const realRoot = await realpath(root);
		if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;

		const info = await stat(real);
		if (info.isDirectory()) return resolveWithinRoot(root, `${decoded.replace(/\/+$/, "")}/index.html`);
		return real;
	} catch {
		return null;
	}
}

export async function serve(root: string): Promise<StaticServer> {
	const server: Server = createServer((req, res) => {
		void (async () => {
			const path = (req.url ?? "/").split("?")[0] ?? "/";
			const file = await resolveWithinRoot(root, path);
			if (!file) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("not found");
				return;
			}
			res.writeHead(200, {
				"content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
				"cache-control": "no-store",
			});
			createReadStream(file).pipe(res);
		})();
	});

	await new Promise<void>((ok, fail) => {
		server.once("error", fail);
		// Loopback only. Binding wider would expose untrusted package content to
		// the network (spec §4).
		server.listen(0, "127.0.0.1", () => {
			server.off("error", fail);
			ok();
		});
	});

	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((ok) => {
				server.closeAllConnections();
				server.close(() => ok());
			}),
	};
}
