import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";


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

export function isAuditServerUrl(value: string, serverOrigin: string): boolean {
	const url = new URL(value);
	if (url.protocol === "ws:") url.protocol = "http:";
	if (url.protocol === "wss:") url.protocol = "https:";
	return url.origin === new URL(serverOrigin).origin;
}

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

function byteRange(value: string, size: number): { start: number; end: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
	if (!match || size === 0) return null;
	const first = match[1] ?? "";
	const last = match[2] ?? "";
	if (first === "" && last === "") return null;

	const length = BigInt(size);
	if (first === "") {
		const suffix = BigInt(last);
		if (suffix === 0n) return null;
		return { start: suffix >= length ? 0 : Number(length - suffix), end: size - 1 };
	}
	const start = BigInt(first);
	const end = last === "" ? length - 1n : BigInt(last);
	if (start >= length || end < start) return null;
	return { start: Number(start), end: Number(end >= length ? length - 1n : end) };
}

function failResponse(res: ServerResponse, error: unknown): void {
	if (res.headersSent) {
		res.destroy(error instanceof Error ? error : new Error(String(error)));
		return;
	}
	res.removeHeader("content-range");
	res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "content-length": "0" });
	res.end();
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
			const { size } = await stat(file);
			res.setHeader("content-type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
			res.setHeader("cache-control", "no-store");
			res.setHeader("accept-ranges", "bytes");
			res.setHeader("content-length", size);

			const requestedRange = req.method === "GET" ? req.headers.range : undefined;
			const range = requestedRange === undefined ? undefined : byteRange(requestedRange, size);
			if (range === null) {
				res.writeHead(416, { "content-range": `bytes */${size}`, "content-length": "0" });
				res.end();
				return;
			}
			if (range) {
				res.statusCode = 206;
				res.setHeader("content-range", `bytes ${range.start}-${range.end}/${size}`);
				res.setHeader("content-length", range.end - range.start + 1);
			}
			if (req.method === "HEAD" || size === 0) {
				res.end();
				return;
			}
			const stream = createReadStream(file, range);
			stream.once("error", (error) => failResponse(res, error));
			res.once("close", () => stream.destroy());
			stream.pipe(res);
		})().catch((error: unknown) => failResponse(res, error));
	});

	await new Promise<void>((ok, fail) => {
		server.once("error", fail);
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
