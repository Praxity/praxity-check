import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { BlockedRequest } from "./report.ts";

export const OFFLINE_WEBRTC_ARG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
const EVIDENCE_WINDOW_MS = 1_000;

/** Installed before course scripts; the UDP flag alone does not reliably suppress STUN. */
export function blockWebRtc({ binding }: { binding?: string } = {}) {
	const notify = binding ? (globalThis as any)[binding] as () => Promise<void> : undefined;
	for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
		Object.defineProperty(globalThis, name, { configurable: false, writable: false, value: class {
			constructor() {
				void notify?.();
				throw new Error("WebRTC is blocked by Praxity Check; use --allow-network");
			}
		} });
	}
}

function authority(value: string): string {
	const url = new URL(value);
	return `${url.hostname}:${url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80")}`;
}

/** Deny traffic that Playwright routing misses, including redirects and workers. */
export async function blockAuditNetwork(auditOrigin: string, blocked: BlockedRequest[]) {
	const origin = new URL(auditOrigin);
	const redirects = new Map<string, string>();
	const browserPending = new Map<string, { request: BlockedRequest; at: number }[]>();
	const proxyPending = new Map<string, { request: BlockedRequest; at: number }[]>();
	const errors: string[] = [];
	let closing: Promise<void> | undefined;
	const key = (request: BlockedRequest) => {
		try {
			if (request.method === "CONNECT" || request.method === "WEBSOCKET" || new URL(request.url).protocol === "https:") return `tunnel\n${authority(request.url)}`;
		} catch { /* A direct proxy client can send an origin-form or malformed URL. */ }
		return `${request.method}\n${request.url}`;
	};
	const remember = (pending: typeof proxyPending, request: BlockedRequest) => {
		const id = key(request);
		if (!pending.has(id)) pending.set(id, []);
		pending.get(id)!.push({ request, at: Date.now() });
	};
	const recent = (pending: typeof proxyPending, request: BlockedRequest) => {
		const items = pending.get(key(request));
		while (items?.length) {
			const item = items.shift()!;
			if (Date.now() - item.at <= EVIDENCE_WINDOW_MS) return item.request;
		}
	};
	const record = (request: BlockedRequest, expectProxy = true) => {
		if (closing) return;
		if (!expectProxy) { blocked.push(request); return; }
		const existing = recent(proxyPending, request);
		if (existing) Object.assign(existing, request);
		else remember(browserPending, request);
	};
	const proxyRecord = (request: BlockedRequest) => {
		if (closing) return;
		// Every denied wire attempt owns an entry; browser metadata can never erase it.
		if (redirects.has(request.url)) request.resourceType = redirects.get(request.url)!;
		const browser = recent(browserPending, request);
		if (browser) Object.assign(request, browser);
		blocked.push(request);
		if (!browser) remember(proxyPending, request);
	};
	const redirect = (responseUrl: string, status: number, location: string | undefined, resourceType: string) => {
		if (closing || ![301, 302, 303, 307, 308].includes(status) || !location) return;
		let target: URL;
		try { target = new URL(location, responseUrl); }
		catch { return; } // An invalid Location cannot produce an outbound request.
		target.hash = "";
		redirects.set(target.href, resourceType);
		for (const item of blocked) if (item.url === target.href && item.resourceType === "other") item.resourceType = resourceType;
	};
	const server = createServer((request, response) => {
		proxyRecord({ url: request.url!, method: request.method!, resourceType: "other" });
		response.destroy();
	});
	server.on("connect", (request, socket) => {
		// Chromium tunnels both WS and TLS. Browser events usually supply the full URL.
		proxyRecord({ url: `connect://${request.url}`, method: "CONNECT", resourceType: "other" });
		socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
	});
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	const websocket = new URL(origin);
	websocket.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
	const proxy = {
		server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		bypass: `<-loopback>,${origin.protocol}//${authority(origin.href)},${websocket.protocol}//${authority(websocket.href)}`,
	};
	return {
		record,
		redirect,
		fail: (error: unknown) => { if (!closing) errors.push(error instanceof Error ? error.message : String(error)); },
		errors,
		proxy,
		args: [
			`--proxy-server=${proxy.server}`,
			// Subtract Chromium's implicit loopback exemption before adding the exact origin.
			`--proxy-bypass-list=${proxy.bypass.replaceAll(",", ";")}`,
			OFFLINE_WEBRTC_ARG,
		],
		close: () => closing ??= new Promise<void>((resolve, reject) => {
			for (const socket of sockets) socket.destroy();
			server.close(error => error ? reject(error) : resolve());
		}),
	};
}

export type AuditNetworkGuard = Awaited<ReturnType<typeof blockAuditNetwork>>;
