import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { withAuditContext } from "../src/html-audit.ts";

async function listener(t: TestContext, handler: RequestListener) {
	const server = createServer(handler);
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

for (const allowNetwork of [false, true]) {
	for (const kind of ["fetch", "document"] as const) {
		test(`${kind} redirects respect network permission ${allowNetwork}`, async (t) => {
			const hits: string[] = [];
			const outside = await listener(t, (request, response) => {
				hits.push(request.url!);
				response.setHeader("Access-Control-Allow-Origin", "*");
				response.end("outside");
			});
			const target = `${outside.origin}/target?course=private`;
			const local = await listener(t, (request, response) => {
				if (request.url === "/redirect") response.writeHead(302, { location: "/hop" });
				else if (request.url === "/hop") response.writeHead(307, { location: target });
				else if (request.url === "/local-redirect") response.writeHead(302, { location: "/local-target" });
				response.end(request.url === "/local-target" ? "local" : "<title>Local</title>");
			});
			await withAuditContext({ auditOrigin: local.origin, allowNetwork }, async (context, blocked) => {
				const page = await context.newPage();
				await page.goto(local.origin);
				assert.equal(await page.evaluate(async () => (await fetch("/local-redirect")).text()), "local");
				if (kind === "fetch") {
					const result = await page.evaluate(async () => {
						try { return await (await fetch("/redirect")).text(); } catch { return "blocked"; }
					});
					assert.equal(result, allowNetwork ? "outside" : "blocked");
				} else if (allowNetwork) {
					await page.goto(`${local.origin}/redirect`);
					assert.equal(page.url(), target);
				} else {
					await assert.rejects(page.goto(`${local.origin}/redirect`));
				}
				assert.deepEqual(hits, allowNetwork ? ["/target?course=private"] : []);
				assert.deepEqual(blocked, allowNetwork ? [] : [{ url: target, method: "GET", resourceType: kind }]);
			});
		});
	}
	for (const transport of ["ws", "wss"] as const) {
		test(`dedicated worker ${transport} respects network permission ${allowNetwork}`, async (t) => {
			let connections = 0;
			const outside = await listener(t, (_, response) => response.end());
			outside.server.on("connection", () => connections++);
			outside.server.on("upgrade", (_, socket) => socket.destroy());
			const local = await listener(t, (_, response) => response.end("<title>Local</title>"));
			const url = outside.origin.replace("http:", `${transport}:`) + "/worker?course=private";
			await withAuditContext({ auditOrigin: local.origin, allowNetwork }, async (context, blocked) => {
				const page = await context.newPage();
				await page.goto(local.origin);
				await page.evaluate(async (url) => {
					const worker = new Worker(URL.createObjectURL(new Blob([
						`const socket = new WebSocket(${JSON.stringify(url)}); socket.onclose = () => postMessage('closed');`,
					], { type: "text/javascript" })));
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("worker socket did not close")), 5000);
						worker.onmessage = () => { clearTimeout(timer); worker.terminate(); resolve(); };
					});
				}, url);
				assert.equal(connections > 0, allowNetwork);
				if (allowNetwork) assert.deepEqual(blocked, []);
				else assert.deepEqual(blocked, [{ url, method: "WEBSOCKET", resourceType: "websocket" }]);
			});
		});
	}
}

test("dedicated workers may still open WebSockets to the audit origin", async (t) => {
	let handshakes = 0;
	const local = await listener(t, (_, response) => response.end("<title>Local</title>"));
	local.server.on("upgrade", (_, socket) => { handshakes++; socket.destroy(); });
	await withAuditContext({ auditOrigin: local.origin, allowNetwork: false }, async (context, blocked) => {
		const page = await context.newPage();
		await page.goto(local.origin);
		await page.evaluate(async () => {
			const worker = new Worker(URL.createObjectURL(new Blob([
				`const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/local'); socket.onclose = () => postMessage('closed');`,
			], { type: "text/javascript" })));
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("local worker socket did not close")), 5000);
				worker.onmessage = () => { clearTimeout(timer); worker.terminate(); resolve(); };
			});
		});
		assert.equal(handshakes, 1);
		assert.deepEqual(blocked, []);
	});
});
