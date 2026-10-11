import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { BlockedRequest } from "./report.ts";

/** Deny traffic that Playwright routing misses, including redirects and workers. */
export async function blockAuditNetwork(auditOrigin: string, blocked: BlockedRequest[]) {
	const origin = new URL(auditOrigin);
	const redirects = new Map<string, string>();
	const record = (request: BlockedRequest) => {
		if (request.resourceType === "other" && redirects.has(request.url)) request.resourceType = redirects.get(request.url)!;
		const existing = blocked.find((item) => item.url === request.url && item.method === request.method
			&& (item.resourceType === request.resourceType || item.resourceType === "other" || request.resourceType === "other")
			|| item.method === "CONNECT" && new URL(item.url).host === new URL(request.url).host);
		if (existing) {
			if (existing.resourceType === "other" || request.resourceType !== "other") Object.assign(existing, request);
		}
		else blocked.push(request);
	};
	const server = createServer((request, response) => {
		record({ url: request.url!, method: request.method!, resourceType: "other" });
		response.destroy();
	});
	server.on("connect", (request, socket) => {
		// Chromium tunnels both WS and TLS. Browser events usually supply the full URL.
		if (!blocked.some((item) => new URL(item.url).host === request.url)) {
			record({ url: `https://${request.url}/`, method: "CONNECT", resourceType: "other" });
		}
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
	return {
		record,
		redirect: (responseUrl: string, status: number, location: string | undefined, resourceType: string) => {
			if (![301, 302, 303, 307, 308].includes(status) || !location) return;
			let target: URL;
			try { target = new URL(location, responseUrl); }
			catch { return; } // An invalid Location cannot produce an outbound request.
			target.hash = "";
			redirects.set(target.href, resourceType);
			for (const item of blocked) if (item.url === target.href && item.resourceType === "other") item.resourceType = resourceType;
		},
		args: [
			`--proxy-server=http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			// Subtract Chromium's implicit loopback exemption before adding the exact origin.
			`--proxy-bypass-list=<-loopback>;${origin.origin};${websocket.origin}`,
		],
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
}

export type AuditNetworkGuard = Awaited<ReturnType<typeof blockAuditNetwork>>;
