import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer, request as httpRequest, type RequestListener } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { auditHtml, withAuditContext } from "../src/html-audit.ts";
import { blockAuditNetwork } from "../src/audit-network.ts";
import type { BlockedRequest } from "../src/report.ts";

async function listener(t: TestContext, handler: RequestListener) {
	const server = createServer(handler);
	const sockets = new Set<Socket>();
	server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});
	return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

for (const allowNetwork of [false, true]) {
	test(`TURN username cannot leave an offline page, network permission ${allowNetwork}`, async t => {
		const udp = createSocket("udp4");
		const packets: Buffer[] = [];
		udp.on("message", (message, remote) => {
			packets.push(message);
			if (message.readUInt16BE(0) !== 3 || message.includes(Buffer.from("secret-"))) return;
			const attribute = (type: number, value: Buffer) => {
				const header = Buffer.alloc(4);
				header.writeUInt16BE(type); header.writeUInt16BE(value.length, 2);
				return Buffer.concat([header, value, Buffer.alloc((4 - value.length % 4) % 4)]);
			};
			const attributes = Buffer.concat([
				attribute(9, Buffer.from([0, 0, 4, 1, ...Buffer.from("Unauthorized")])),
				attribute(0x14, Buffer.from("r")), attribute(0x15, Buffer.from("n0nce")),
			]);
			const header = Buffer.alloc(20);
			header.writeUInt16BE(0x113); header.writeUInt16BE(attributes.length, 2);
			message.copy(header, 4, 4, 20);
			udp.send(Buffer.concat([header, attributes]), remote.port, remote.address);
		});
		await new Promise<void>(resolve => udp.bind(0, "127.0.0.1", resolve));
		t.after(() => new Promise<void>(resolve => udp.close(resolve)));
		const port = udp.address().port;
		const local = await listener(t, (_, response) => response.end(`<html lang="en"><title>webrtc</title><main><h1>WebRTC</h1><script>
			const pc = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${port}'},{urls:'turn:127.0.0.1:${port}?transport=udp',username:'secret-webrtc-course-answer-key',credential:'x'}]});
			pc.createDataChannel('x');pc.createOffer().then(offer=>pc.setLocalDescription(offer));
		</script></main></html>`));
		const result = await auditHtml({ pages: [{ file: "a.html", url: `${local.origin}/a.html` }], scenarios: [], auditOrigin: local.origin, allowNetwork });
		if (allowNetwork) {
			assert.ok(packets.some(packet => packet.includes(Buffer.from("secret-webrtc-course-answer-key"))));
			assert.deepEqual(result.blockedRequests, []);
		} else {
			assert.equal(packets.length, 0);
			assert.deepEqual(result.blockedRequests, [{ url: `${local.origin}/a.html`, method: "RTCPEERCONNECTION", resourceType: "webrtc" }]);
			assert.equal(result.pages[0]!.audited, false);
		}
	});
}

for (const closeImmediately of [false, true]) {
	test(`a same-origin popup preserves its opener's audit, immediately closed ${closeImmediately}`, async t => {
		const hits: string[] = [];
		const local = await listener(t, (request, response) => {
			hits.push(request.url!);
			response.end(`<html lang="en"><title>Popup</title><main><h1>Popup</h1>${request.url === "/a.html" ? `<script>const popup=window.open('/glossary.html');${closeImmediately ? "popup.close();" : ""}</script>` : ""}</main></html>`);
		});
		const result = await auditHtml({ pages: [{ file: "a.html", url: `${local.origin}/a.html` }], scenarios: [], auditOrigin: local.origin, allowNetwork: false });
		assert.equal(result.pages[0]!.audited, true);
		assert.deepEqual(result.blockedRequests, []);
		if (!closeImmediately) assert.ok(hits.includes("/glossary.html"));
	});
}

test("closed worker sockets cannot erase a later shared worker's blocked fetch", async t => {
	let outsideConnections = 0;
	const outside = await listener(t, (_, response) => response.end());
	outside.server.on("connection", () => outsideConnections++);
	const endpoint = outside.origin.slice("http://".length);
	const scripts: Record<string, string> = {
		"/a.html": `new Worker(URL.createObjectURL(new Blob(["for(let i=0;i<20;i++){const s=new WebSocket('wss://${endpoint}/arm'+i);s.close()}"],{type:'text/javascript'})))`,
		"/b.html": `new SharedWorker(URL.createObjectURL(new Blob(["fetch('https://${endpoint}/lesson.json').catch(()=>{})"],{type:'text/javascript'})))`,
	};
	const local = await listener(t, (request, response) => response.end(`<html lang="en"><title>Shell</title><main><h1>Shell</h1><script>${scripts[request.url!] ?? ""}</script>${request.url === "/b.html" ? '<img src="x.png">' : ""}</main></html>`));
	for (const files of [["b.html"], ["a.html", "b.html"]]) {
		const result = await auditHtml({ pages: files.map(file => ({ file, url: `${local.origin}/${file}` })), scenarios: [], auditOrigin: local.origin, allowNetwork: false });
		const page = result.pages.find(page => page.page.file === "b.html")!;
		assert.equal(page.audited, false);
		assert.match(page.triage.reason!, /Check blocked 1 request\./);
		assert.ok(result.blockedRequests.some(request => request.url === `connect://${endpoint}` && request.method === "CONNECT"));
	}
	assert.equal(outsideConnections, 0);
});

test("both WebRTC constructor names deny attempts from a child frame", async t => {
	const local = await listener(t, (request, response) => response.end(request.url === "/" ? '<title>RTC</title><iframe src="/frame"></iframe>' : '<title>RTC frame</title>'));
	await withAuditContext({ auditOrigin: local.origin, allowNetwork: false }, async (context, blocked) => {
		const page = await context.newPage();
		await page.goto(local.origin);
		const frame = page.frames().find(frame => frame.url() === `${local.origin}/frame`)!;
		const messages = await frame.evaluate(() => {
			Reflect.set(globalThis, "__praxityBlockedRtc", async () => {});
			Reflect.set(globalThis, "RTCPeerConnection", class {});
			return ["RTCPeerConnection", "webkitRTCPeerConnection"].map(name => {
				try { new (globalThis as any)[name](); return "allowed"; }
				catch (error) { return (error as Error).message; }
			});
		});
		for (const message of messages) assert.match(message, /WebRTC is blocked by Praxity Check/);
		assert.deepEqual(blocked, Array.from({ length: 2 }, () => ({ url: `${local.origin}/frame`, method: "RTCPEERCONNECTION", resourceType: "webrtc" })));
	});
});

test("a live target's protocol failure preserves an unchecked page instead of crashing", async t => {
	const launch = chromium.launch.bind(chromium);
	const originalLaunch = chromium.launch;
	t.after(() => { chromium.launch = originalLaunch; });
	chromium.launch = async options => {
		const browser = await launch(options);
		const newContext = browser.newContext.bind(browser);
		browser.newContext = async options => {
			const context = await newContext(options);
			context.newCDPSession = async () => { throw new Error("probe protocol unavailable"); };
			return context;
		};
		return browser;
	};
	const local = await listener(t, (_, response) => response.end('<title>Live</title><main><h1>Live</h1></main>'));
	const result = await auditHtml({ pages: [{ file: "a.html", url: `${local.origin}/a.html` }], scenarios: [], auditOrigin: local.origin, allowNetwork: false });
	assert.equal(result.pages[0]!.audited, false);
	assert.match(result.pages[0]!.triage.reason!, /network observation failed: probe protocol unavailable/);
	assert.ok(result.pages[0]!.untested!.some(item => item.check === "page-audit"));
});

async function connect(guard: Awaited<ReturnType<typeof blockAuditNetwork>>, endpoint: string) {
	const proxy = new URL(guard.args[0]!.slice("--proxy-server=".length));
	await new Promise<void>((resolve, reject) => {
		const request = httpRequest({ hostname: proxy.hostname, port: proxy.port, method: "CONNECT", path: endpoint });
		request.once("connect", (response, socket) => {
			socket.destroy();
			if (response.statusCode === 403) resolve();
			else reject(new Error(`CONNECT returned ${response.statusCode}`));
		});
		request.once("error", reject); request.end();
	});
}

test("reset prevents old page and state observers from changing a new proxy entry", async t => {
	const blocked: BlockedRequest[] = [];
	const guard = await blockAuditNetwork("http://127.0.0.1:4321", blocked);
	t.after(() => guard.close());
	const previousPage = guard.scope();
	previousPage.record({ url: "wss://127.0.0.1:9876/closed", method: "WEBSOCKET", resourceType: "websocket" });
	guard.reset();
	await connect(guard, "127.0.0.1:9876");
	previousPage.record({ url: "wss://127.0.0.1:9876/late", method: "WEBSOCKET", resourceType: "websocket" });
	assert.deepEqual(blocked, [{ url: "connect://127.0.0.1:9876", method: "CONNECT", resourceType: "other" }]);
	const currentState = guard.scope();
	currentState.record({ url: "https://127.0.0.1:9876/lesson", method: "GET", resourceType: "fetch" });
	guard.reset();
	await connect(guard, "127.0.0.1:9876");
	currentState.record({ url: "https://127.0.0.1:9876/late", method: "GET", resourceType: "fetch" });
	assert.deepEqual(blocked, [
		{ url: "https://127.0.0.1:9876/lesson", method: "GET", resourceType: "fetch" },
		{ url: "connect://127.0.0.1:9876", method: "CONNECT", resourceType: "other" },
	]);
});

test("every proxy attempt counts even when a browser-only socket never reaches the wire", async t => {
	const blocked: BlockedRequest[] = [];
	const guard = await blockAuditNetwork("http://127.0.0.1:4321", blocked);
	t.after(() => guard.close());
	for (let i = 0; i < 20; i++) guard.record({ url: `wss://127.0.0.1:9876/closed${i}`, method: "WEBSOCKET", resourceType: "websocket" });
	await connect(guard, "127.0.0.1:9876");
	await connect(guard, "127.0.0.1:9876");
	assert.equal(blocked.length, 2);
});

test("the deny proxy survives an origin-form request line", async t => {
	const blocked: BlockedRequest[] = [];
	const guard = await blockAuditNetwork("http://127.0.0.1:4321", blocked);
	t.after(() => guard.close());
	const proxy = new URL(guard.args[0]!.slice("--proxy-server=".length));
	await assert.rejects(new Promise<void>((resolve, reject) => {
		const request = httpRequest({ hostname: proxy.hostname, port: proxy.port, path: "/" });
		request.once("response", () => resolve()); request.once("error", reject); request.end();
	}), { code: "ECONNRESET" });
	assert.deepEqual(blocked, [{ url: "/", method: "GET", resourceType: "other" }]);
});
