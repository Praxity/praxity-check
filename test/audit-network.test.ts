import assert from "node:assert/strict";
import { createServer, request as httpRequest, type RequestListener } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { auditHtml, withAuditContext } from "../src/html-audit.ts";
import { blockAuditNetwork } from "../src/audit-network.ts";
import type { BlockedRequest } from "../src/report.ts";

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

for (const [url, destination] of [["ws://127.0.0.1/worker", "127.0.0.1:80"], ["wss://127.0.0.1/worker", "127.0.0.1:443"]]) {
	for (const timing of ["before", "after"]) {
		test(`${url} retains full evidence when the browser event arrives ${timing} CONNECT`, async (t) => {
			const blocked: BlockedRequest[] = [];
			const guard = await blockAuditNetwork("http://127.0.0.1:4321", blocked);
			t.after(() => guard.close());
			const evidence = { url: url!, method: "WEBSOCKET", resourceType: "websocket" };
			if (timing === "before") guard.record(evidence);
			const proxy = new URL(guard.args[0]!.slice("--proxy-server=".length));
			await new Promise<void>((resolve, reject) => {
				const request = httpRequest({ hostname: proxy.hostname, port: proxy.port, method: "CONNECT", path: destination });
				request.once("connect", (response, socket) => {
					socket.destroy();
					if (response.statusCode === 403) resolve();
					else reject(new Error(`CONNECT returned ${response.statusCode}`));
				});
				request.setTimeout(5000, () => request.destroy(new Error("CONNECT did not finish")));
				request.once("error", reject);
				request.end();
			});
			if (timing === "after") {
				assert.deepEqual(blocked, [{ url: `connect://${destination}`, method: "CONNECT", resourceType: "other" }]);
				guard.record(evidence);
			}
			assert.deepEqual(blocked, [evidence]);
		});
	}
}

for (const transport of ["fetch", "redirect", "worker"] as const) {
	test(`repeated blocked ${transport} requests retain each initial page's triage evidence`, async (t) => {
		let connections = 0;
		const outside = await listener(t, (_, response) => response.end());
		outside.server.on("connection", () => connections++);
		const target = `${outside.origin}/content`;
		const socketUrl = target.replace("http:", "ws:");
		const script = transport === "worker"
			? `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`new WebSocket('${socketUrl}')`)}], { type: 'text/javascript' })))`
			: `fetch('${transport === "redirect" ? "/redirect" : target}').catch(() => {})`;
		const local = await listener(t, (request, response) => {
			if (request.url === "/redirect") response.writeHead(302, { location: target });
			response.end(`<html lang="en"><title>Shell</title><body><main><h1>Shell</h1><script>${script}</script></main></body></html>`);
		});
		const result = await auditHtml({
			pages: ["a.html", "b.html"].map(file => ({ file, url: `${local.origin}/${file}` })),
			scenarios: [], auditOrigin: local.origin, allowNetwork: false,
		});
		assert.equal(connections, 0);
		const evidence = transport === "worker"
			? { url: socketUrl, method: "WEBSOCKET", resourceType: "websocket" }
			: { url: target, method: "GET", resourceType: "fetch" };
		assert.deepEqual(result.blockedRequests, [evidence, evidence]);
		for (const page of result.pages) {
			assert.equal(page.audited, false);
			assert.match(page.triage.reason!, /Check blocked 1 request\./);
		}
	});
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

test("different resource types retain separate evidence for the same blocked URL", async (t) => {
	let hits = 0;
	const outside = await listener(t, (_, response) => { hits++; response.end(); });
	const target = `${outside.origin}/target`;
	const local = await listener(t, (_, response) => response.end("<title>Local</title>"));
	await withAuditContext({ auditOrigin: local.origin, allowNetwork: false }, async (context, blocked) => {
		const page = await context.newPage();
		await page.goto(local.origin);
		await page.evaluate(async (url) => {
			await Promise.all([
				fetch(url).catch(() => {}),
				new Promise<void>(resolve => { const image = new Image(); image.onerror = () => resolve(); image.src = url; }),
			]);
		}, target);
		assert.equal(hits, 0);
		assert.deepEqual(blocked.sort((a, b) => a.resourceType.localeCompare(b.resourceType)), [
			{ url: target, method: "GET", resourceType: "fetch" },
			{ url: target, method: "GET", resourceType: "image" },
		]);
	});
});

test("a POST redirect drops the body and blocks the GET destination, excluding its fragment", async (t) => {
	let hits = 0;
	const outside = await listener(t, (_, response) => { hits++; response.end(); });
	const target = `${outside.origin}/target?course=private`;
	const local = await listener(t, (request, response) => {
		if (request.url === "/redirect") response.writeHead(303, { location: `${target}#bookmark` });
		response.end("<title>Local</title>");
	});
	await withAuditContext({ auditOrigin: local.origin, allowNetwork: false }, async (context, blocked) => {
		const page = await context.newPage();
		await page.goto(local.origin);
		await page.evaluate(async () => { await fetch("/redirect", { method: "POST", body: "private" }).catch(() => {}); });
		assert.equal(hits, 0);
		assert.deepEqual(blocked, [{ url: target, method: "GET", resourceType: "fetch" }]);
	});
});

test("manual and malformed redirects do not create blocked-request evidence", async (t) => {
	let hits = 0;
	const outside = await listener(t, (_, response) => { hits++; response.end(); });
	const local = await listener(t, (request, response) => {
		if (request.url === "/manual") response.writeHead(302, { location: `${outside.origin}/target` });
		if (request.url === "/malformed") response.writeHead(302, { location: "http://[" });
		response.end("<title>Local</title>");
	});
	await withAuditContext({ auditOrigin: local.origin, allowNetwork: false }, async (context, blocked) => {
		const page = await context.newPage();
		await page.goto(local.origin);
		await page.evaluate(async () => {
			await fetch("/manual", { redirect: "manual" });
			await fetch("/malformed").catch(() => {});
		});
		assert.equal(hits, 0);
		assert.deepEqual(blocked, []);
	});
});

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
		assert.equal(handshakes, 1, JSON.stringify(blocked));
		assert.deepEqual(blocked, []);
	});
});
