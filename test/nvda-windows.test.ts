import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { serve } from "../src/serve.ts";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { chromium } from "playwright";

import { ChromiumJourneyBrowser, describeJourneyError, waitForNvdaExit, foregroundGuardDecision, type ChromiumOptions, type ForegroundReading } from "../src/nvda-windows.ts";

// Ubuntu 24.04 blocks Chrome's user-namespace sandbox for unprivileged users, as on CI runners.
// Playwright passes --no-sandbox by default for the same reason. The Windows driver keeps the sandbox.
const HEADLESS = ["--headless=new", "--disable-background-networking", ...(process.platform === "linux" ? ["--no-sandbox"] : [])];

const reading = (held: string[] = [], pid = 42): ForegroundReading => ({ pid, title: "Course", held,
	hwnd: String(pid), className: "Chrome_WidgetWin_1", owned: false, shell: false, interactive: true });
const shell = (held: string[] = []): ForegroundReading => ({ ...reading(held, 7), title: "Program Manager", className: "Progman", shell: true });

test("a missing browser executable rejects through the adapter interface", async () => {
	const browser = new ChromiumJourneyBrowser({ executable: join(tmpdir(), "praxity-missing-browser.exe"), screenshots: tmpdir() });
	try { await assert.rejects(browser.open("http://127.0.0.1:1234/index.html"), /ENOENT/); }
	finally { await browser.close(); }
});

test("the journey browser starts without network listeners that raise firewall prompts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "praxity-nvda-args-"));
	let launchedArgs: string[] = [];
	// A real file passes open()'s existence check; spawning a missing program then fails at once, so no browser starts.
	await writeFile(join(dir, "browser.exe"), "");
	const browser = new ChromiumJourneyBrowser({
		executable: join(dir, "browser.exe"), screenshots: dir,
		launch: (_executable, args) => { launchedArgs = args; return spawn(join(dir, "missing.exe"), args, { stdio: "ignore" }); },
	});
	try {
		await assert.rejects(browser.open("http://127.0.0.1:9/index.html"));
		assert.ok(launchedArgs.includes("--disable-features=MediaRouter,DialMediaRouteProvider"), "Cast discovery off");
		assert.ok(launchedArgs.includes("--disable-background-networking"));
		assert.equal(launchedArgs.filter((arg) => arg.startsWith("--disable-features=")).length, 1, "Chrome keeps only the last --disable-features");
	} finally {
		await browser.close().catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});

test("a browser that fails to open releases its proxy server and profile", async () => {
	const dir = await mkdtemp(join(tmpdir(), "praxity-nvda-failed-open-"));
	await writeFile(join(dir, "browser.exe"), "");
	let profile: string | undefined;
	const servers = () => process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length;
	const before = servers();
	const browser = new ChromiumJourneyBrowser({
		executable: join(dir, "browser.exe"), screenshots: dir,
		launch: (_executable, args) => {
			profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
			return spawn(join(dir, "missing.exe"), args, { stdio: "ignore" });
		},
	});
	try {
		await assert.rejects(browser.open("http://127.0.0.1:9/index.html"));
		assert.equal(servers(), before, "the network deny proxy is closed, so the process can exit");
		assert.ok(profile);
		await assert.rejects(stat(profile), { code: "ENOENT" });
		await assert.doesNotReject(browser.close(), "the runner's own close() after a failed open is harmless");
	} finally {
		// Without the fix the leaked proxy keeps the test process alive; close it so the test fails instead of hanging.
		await browser.close().catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});

test("closing a browser terminated by signal removes its throwaway profile", async () => {
	const dir = await mkdtemp(join(tmpdir(), "praxity-nvda-exit-"));
	await writeFile(join(dir, "index.html"), "<!doctype html><title>Owned browser</title><main>Ready</main>");
	const server = await serve(dir);
	let launched: ChildProcess | undefined;
	let profile: string | undefined;
	const browser = new ChromiumJourneyBrowser({
		executable: chromium.executablePath(), screenshots: dir, args: HEADLESS,
		launch: (executable, args) => {
			profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
			return launched = spawn(executable, args, { stdio: "ignore", windowsHide: true });
		},
	});
	try {
		await browser.open(`${server.origin}/index.html`);
		assert.ok(launched?.pid);
		assert.equal(launched.pid, browser.pid, "terminate only the process owned by this browser");
		assert.ok(profile);
		assert.ok((await stat(profile)).isDirectory());
		const exited = once(launched, "exit");
		// Chrome handles SIGTERM on Linux and exits normally; SIGKILL cannot be caught on any platform.
		assert.equal(launched.kill("SIGKILL"), true);
		await exited;
		assert.equal(launched.signalCode, "SIGKILL");
		await assert.doesNotReject(browser.close());
		await assert.rejects(stat(profile), { code: "ENOENT" });
	} finally {
		if (launched && launched.exitCode === null && launched.signalCode === null) launched.kill();
		// A failed assertion above skips close(); without it the deny proxy keeps the test file running.
		await browser.close().catch(() => {});
		await server.close();
		if (profile) {
			assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
			await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
		}
		assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
		await rm(dir, { recursive: true, force: true });
	}
});

test("initial course navigation requires verified browser foreground before the request", async () => {
	for (const interruption of [false, true]) {
		const events: string[] = [];
		const server = createServer((request, response) => {
			if (request.url === "/index.html") events.push("course request");
			response.end("<!doctype html><title>Owned course</title><main>Ready</main>");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const dir = await mkdtemp(join(tmpdir(), "praxity-nvda-before-navigation-"));
		let foreground = interruption ? { ...reading([], 7), title: "Windows Security" } : shell();
		const browser: ChromiumJourneyBrowser = new ChromiumJourneyBrowser({
			executable: chromium.executablePath(), screenshots: dir, args: HEADLESS,
			probe: {
				read: async () => foreground,
				acquire: async (pid) => {
					assert.equal(pid, browser.pid);
					events.push("foreground acquired");
					return foreground = { ...reading([], pid), hwnd: "84" };
				},
			},
		});
		try {
			const opening = browser.open(`http://127.0.0.1:${address.port}/index.html`);
			if (interruption) {
				await assert.rejects(opening, /Windows Security/);
				assert.deepEqual(events, [], "an interruption prevents all course navigation and activation");
			} else {
				await opening;
				assert.deepEqual(events, ["foreground acquired", "course request"]);
				assert.equal((await browser.corroborate()).title, "Owned course");
			}
		} finally {
			try { await browser.close(); }
			finally {
				await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
				assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
				await rm(dir, { recursive: true, force: true });
			}
		}
	}
});

test("network isolation covers workers, service workers, popup navigation and sockets", async () => {
	const requests: string[] = [];
	let stunPackets = 0;
	const udp = createSocket("udp4");
	udp.on("message", () => { stunPackets++; });
	await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
	const udpPort = udp.address().port;
	const outside = createServer((req, res) => { requests.push(req.url!); res.end("outside"); });
	outside.on("upgrade", (req, socket) => { requests.push(req.url!); socket.destroy(); });
	await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
	const address = outside.address();
	assert.ok(address && typeof address !== "string");
	const remote = `http://127.0.0.1:${address.port}`;
	const dir = await mkdtemp(join(tmpdir(), "praxity-nvda-network-"));
	await writeFile(join(dir, "sw.js"), `self.addEventListener('install', event => event.waitUntil(fetch('${remote}/service-worker')));`);
	await writeFile(join(dir, "index.html"), `<!doctype html><title>Starting</title><p role=status></p><script>
const worker = new Worker(URL.createObjectURL(new Blob(["const socket = new WebSocket('${remote.replace("http:", "ws:")}/worker-socket'); const socketDone = new Promise(resolve => { socket.onerror = socket.onclose = () => resolve('blocked'); socket.onopen = () => resolve('allowed'); }); Promise.all([fetch('${remote}/worker').then(() => 'allowed').catch(() => 'blocked'), socketDone]).then(results => postMessage(results.join(' ')));"], {type:'text/javascript'})));
const workerDone = new Promise(resolve => worker.onmessage = event => resolve(event.data));
const swDone = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.getRegistrations()).then(registrations => registrations.length === 0 ? 'blocked' : 'allowed').catch(() => 'blocked');
window.open('${remote}/popup');
const ws = new WebSocket('${remote.replace("http:", "ws:")}/socket');
const wsDone = new Promise(resolve => { ws.onerror = ws.onclose = () => resolve('blocked'); ws.onopen = () => resolve('allowed'); });
const rtcDone = (async () => { try { const peer = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]}); peer.createDataChannel('probe'); await peer.setLocalDescription(await peer.createOffer()); return 'allowed'; } catch { return 'blocked'; } })();
Promise.all([workerDone, swDone, wsDone, rtcDone]).then(results => { document.querySelector('[role=status]').textContent = results.join(' '); document.title = 'Done'; worker.terminate(); });
</script>`);
	const server = await serve(dir);
	const browser = new ChromiumJourneyBrowser({ executable: chromium.executablePath(), screenshots: dir, args: [...HEADLESS, "--disable-popup-blocking"] });
	try {
		await browser.open(`${server.origin}/index.html`);
		let observed = await browser.corroborate();
		const deadline = Date.now() + 8_000;
		while (observed.title !== "Done" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			observed = await browser.corroborate();
		}
		assert.equal(observed.title, "Done", "all network probes must finish");
		assert.deepEqual(observed.liveRegions, ["blocked blocked blocked blocked blocked"]);
		assert.deepEqual(requests, [], "course requests must never reach the other origin");
		assert.equal(stunPackets, 0, "WebRTC must not send STUN packets");
	} finally {
		await browser.close(); await server.close();
		await new Promise<void>((resolve, reject) => outside.close((error) => error ? reject(error) : resolve()));
		await new Promise<void>((resolve) => udp.close(resolve));
		await rm(dir, { recursive: true, force: true });
	}
});

test("foreground policy retries a held key only during the settling window", () => {
	assert.deepEqual(foregroundGuardDecision(reading(), 42, true), { outcome: "ready", detail: "Course" });
	assert.equal(foregroundGuardDecision(reading(["Control"]), 42, true).outcome, "retry");
	const persistent = foregroundGuardDecision(reading(["Control"]), 42, false);
	assert.equal(persistent.outcome, "stop");
	assert.match(persistent.detail, /Control.*cannot identify their source/);
});

test("foreground policy rejects a changed process even while modifiers settle", () => {
	assert.equal(foregroundGuardDecision(reading(["Control"], 7), 42, true).outcome, "stop");
	assert.equal(foregroundGuardDecision(reading([], 7), 42, false).outcome, "stop");
	assert.equal(foregroundGuardDecision(reading(), undefined, true).outcome, "stop");
});

test("foreground acquisition is restricted to the verified shell on the interactive desktop", () => {
	assert.equal(foregroundGuardDecision(shell(), 42, true).outcome, "acquire");
	assert.equal(foregroundGuardDecision({ ...shell(), pid: 0, hwnd: "0" }, 42, true).outcome, "acquire");
	assert.equal(foregroundGuardDecision(shell(["Alt"]), 42, true).outcome, "retry");
	assert.equal(foregroundGuardDecision(shell(["Alt"]), 42, false).outcome, "stop");
	assert.equal(foregroundGuardDecision({ ...shell(), interactive: false }, 42, true).outcome, "stop");
	assert.equal(foregroundGuardDecision({ ...shell(), shell: false }, 42, true).outcome, "stop", "a shell title alone does not authorize acquisition");
});

test("foreground policy rejects dialogs in the browser process", () => {
	assert.equal(foregroundGuardDecision({ ...reading(), className: "#32770", title: "Credentials" }, 42, true).outcome, "stop");
	assert.equal(foregroundGuardDecision({ ...reading(), owned: true }, 42, true).outcome, "stop");
});

// Switching focus emulation off makes hasFocus() truthful; it moves no focus and sends no keys.
const injected = (commands: string[]) => commands.filter((command) => command !== "Emulation.setFocusEmulationEnabled");

class FakeClock {
	#time = 10_000;
	sleeps: number[] = [];
	now = () => this.#time;
	advance(ms: number): void { this.#time += ms; }
	sleep = async (ms: number): Promise<void> => { this.sleeps.push(ms); this.advance(ms); };
}

class SyntheticBrowser extends ChromiumJourneyBrowser {
	url = "http://127.0.0.1:1234/index.html";
	visible = true;
	focused = true;
	// Playwright leaves focus emulation on for pages it attaches to; then hasFocus() is always true.
	focusEmulation = true;
	navigation: { errorText?: string; loaderId?: string; isDownload?: boolean } = { loaderId: "loaded" };
	frame: { url: string; loaderId: string; unreachableUrl?: string } = { url: this.url, loaderId: "loaded" };
	commands: string[] = [];

	constructor(probe?: ChromiumOptions["probe"], clock?: ChromiumOptions["clock"]) {
		super({ executable: "unused", screenshots: "unused", probe, clock });
	}

	override get pid(): number { return 42; }

	protected override async evaluate<T>(expression: string): Promise<T> {
		const value = expression === "location.href" ? this.url : expression === "document.visibilityState" ? (this.visible ? "visible" : "hidden")
			: expression === "document.hasFocus()" ? this.focusEmulation || this.focused : expression === "document.readyState" ? "complete" : undefined;
		if (value === undefined) throw new Error(`unexpected expression ${expression}`);
		return value as T;
	}

	protected override async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		this.commands.push(method);
		if (method === "Emulation.setFocusEmulationEnabled") { this.focusEmulation = params.enabled === true; return {} as T; }
		if (method === "Page.navigate") return this.navigation as T;
		if (method === "Page.getFrameTree") return { frameTree: { frame: this.frame } } as T;
		throw new Error(`unexpected command ${method}`);
	}
}

test("guard permits a transient modifier after a fresh sample clears it", async () => {
	const clock = new FakeClock();
	const started = clock.now();
	let count = 0;
	const browser = new SyntheticBrowser({ read: async () => reading(count++ === 0 ? ["Control"] : []) }, clock);
	assert.deepEqual(await browser.guard("http://127.0.0.1:1234"), { ok: true, detail: "Course" });
	assert.equal(count, 3, "foreground is checked again after page checks");
	assert.equal(clock.now() - started, 50);
	assert.deepEqual(clock.sleeps, [50]);
});

test("guard acquires the browser from the shell and verifies it before allowing keys", async () => {
	let current = shell();
	const activations: boolean[] = [];
	const browser = new SyntheticBrowser({ read: async () => current, acquire: async (pid, unlock) => {
		assert.equal(pid, 42);
		activations.push(unlock);
		return current = reading();
	} });
	assert.deepEqual(await browser.guard("http://127.0.0.1:1234"), { ok: true, detail: "Course" });
	assert.deepEqual(activations, [false]);
	assert.deepEqual(injected(browser.commands), [], "activation never injects page focus or journey keys");
});

test("guard acquires from a verified taskbar but rejects shell title or class lookalikes", async () => {
	const taskbar: ForegroundReading = { ...shell(), title: "", hwnd: "196900", className: "Shell_TrayWnd" };
	let foreground = taskbar;
	const activations: string[] = [];
	const browser = new SyntheticBrowser({
		read: async () => foreground,
		acquire: async () => { activations.push(foreground.hwnd); return foreground = reading(); },
	});
	assert.equal((await browser.guard("http://127.0.0.1:1234")).ok, true);
	assert.deepEqual(activations, ["196900"]);
	for (const title of ["", "Program Manager"]) {
		foreground = { ...taskbar, shell: false, title };
		const result = await browser.guard("http://127.0.0.1:1234");
		assert.equal(result.ok, false);
		assert.match(result.detail, /process 7/);
	}
	assert.deepEqual(activations, ["196900"], "lookalike windows remain untouched");
});

test("guard retries ordinary activation then permits only one Alt unlock attempt", async () => {
	const clock = new FakeClock();
	const started = clock.now();
	let current = shell();
	const activations: boolean[] = [];
	const attemptTimes: number[] = [];
	const browser = new SyntheticBrowser({ read: async () => current, acquire: async (_pid, unlock) => {
		activations.push(unlock);
		attemptTimes.push(clock.now() - started);
		if (activations.length === 3) current = reading();
		return current;
	} }, clock);
	assert.deepEqual(await browser.guard("http://127.0.0.1:1234"), { ok: true, detail: "Course" });
	assert.deepEqual(activations, [false, true, false]);
	assert.deepEqual(attemptTimes, [0, 50, 100]);
	assert.deepEqual(clock.sleeps, [50, 50]);
});

test("guard bounds unsuccessful foreground acquisition", async () => {
	const clock = new FakeClock();
	const started = clock.now();
	const activations: boolean[] = [];
	const attemptTimes: number[] = [];
	const acquisitionBudgets: (number | undefined)[] = [];
	const readBudgets: (number | undefined)[] = [];
	const browser = new SyntheticBrowser({
		read: async (timeoutMs) => { readBudgets.push(timeoutMs); return shell(); },
		acquire: async (_pid, unlock, _hwnd, timeoutMs) => {
			activations.push(unlock);
			attemptTimes.push(clock.now() - started);
			acquisitionBudgets.push(timeoutMs);
			return shell();
		},
	}, clock);
	const result = await browser.guard("http://127.0.0.1:1234");
	assert.deepEqual(result, { ok: false, detail: "could not acquire the journey browser foreground within 1500 ms" });
	assert.equal(clock.now() - started, 1500);
	assert.deepEqual(clock.sleeps, Array(30).fill(50));
	assert.equal(activations.length, 30);
	assert.equal(activations.filter(Boolean).length, 1);
	assert.deepEqual(attemptTimes, Array.from({ length: 30 }, (_, i) => i * 50));
	assert.deepEqual(acquisitionBudgets, Array.from({ length: 30 }, (_, i) => 1500 - i * 50));
	assert.deepEqual(readBudgets, [undefined, ...Array.from({ length: 29 }, (_, i) => 1450 - i * 50)]);
});

test("guard bounds an acquisition adapter that never answers", async () => {
	// A real timer proves the default adapter answer limit still fires while acquisition cannot make progress.
	let attempts = 0;
	const browser = new SyntheticBrowser({ read: async () => shell(), acquire: async () => { attempts++; return new Promise(() => {}); } });
	const result = await browser.guard("http://127.0.0.1:1234");
	assert.deepEqual(result, { ok: false, detail: "journey browser foreground acquisition timed out" });
	assert.equal(attempts, 1);
});

test("guard bounds stalled acquisition and polling adapters with the remaining budget even when the clock is stopped", async () => {
	for (const stalled of ["acquire", "read"] as const) {
		const clock = new FakeClock();
		const started = clock.now();
		const acquisitionBudgets: (number | undefined)[] = [];
		const readBudgets: (number | undefined)[] = [];
		const browser = new SyntheticBrowser({
			read: async (timeoutMs) => {
				readBudgets.push(timeoutMs);
				if (stalled === "read" && readBudgets.length === 2) return new Promise(() => {});
				return shell();
			},
			acquire: async (_pid, _unlock, _hwnd, timeoutMs) => {
				acquisitionBudgets.push(timeoutMs);
				if (acquisitionBudgets.length === 2) return new Promise(() => {});
				clock.advance(1449);
				return shell();
			},
		}, clock);
		assert.deepEqual(await browser.guard("http://127.0.0.1:1234"), { ok: false, detail: "journey browser foreground acquisition timed out" });
		assert.equal(clock.now() - started, 1499);
		assert.deepEqual(clock.sleeps, [50]);
		assert.deepEqual(readBudgets, [undefined, 1]);
		assert.deepEqual(acquisitionBudgets, stalled === "acquire" ? [1500, 1] : [1500]);
	}
});

test("guard retries a modifier returned by acquisition before 300 ms and stops at 300 ms", async () => {
	for (const elapsed of [299, 300]) {
		const clock = new FakeClock();
		let samples = 0;
		let attempts = 0;
		const browser = new SyntheticBrowser({
			read: async () => samples++ === 0 ? shell() : reading(),
			acquire: async () => { attempts++; clock.advance(elapsed); return reading(["Control"]); },
		}, clock);
		assert.deepEqual(await browser.guard("http://127.0.0.1:1234"), elapsed === 299
			? { ok: true, detail: "Course" }
			: { ok: false, detail: "keys still held down: Control; the probe cannot identify their source" });
		assert.equal(attempts, 1);
		assert.equal(samples, elapsed === 299 ? 3 : 1);
		assert.deepEqual(clock.sleeps, elapsed === 299 ? [50] : []);
	}
});

test("guard never attempts acquisition over a foreign application or security dialog", async () => {
	for (const title of ["Editor", "Windows Security", "User Account Control", "Credentials"]) {
		let activated = false;
		const browser = new SyntheticBrowser({ read: async () => ({ ...reading([], 7), title }), acquire: async () => { activated = true; return reading(); } });
		const result = await browser.guard("http://127.0.0.1:1234");
		assert.equal(result.ok, false);
		assert.match(result.detail, /process 7/);
		assert.equal(activated, false);
	}
});

test("guard stops when a security dialog appears between activation retries", async () => {
	const clock = new FakeClock();
	let samples = 0;
	const activations: boolean[] = [];
	const browser = new SyntheticBrowser({
		read: async () => samples++ === 0 ? shell() : { ...reading([], 7), title: "Windows Security" },
		acquire: async (_pid, unlock) => { activations.push(unlock); return shell(); },
	}, clock);
	assert.deepEqual(await browser.guard("http://127.0.0.1:1234"), { ok: false, detail: 'foreground window belongs to process 7 ("Windows Security"), not the journey browser 42' });
	assert.equal(samples, 2);
	assert.deepEqual(activations, [false]);
	assert.deepEqual(clock.sleeps, [50]);
});

test("guard stops when the acquisition helper reports an interruption before activation", async () => {
	let activations = 0;
	const browser = new SyntheticBrowser({ read: async () => shell(), acquire: async () => { activations++; return { ...reading([], 7), title: "Credentials" }; } });
	assert.match((await browser.guard("http://127.0.0.1:1234")).detail, /Credentials/);
	assert.equal(activations, 1);
});

test("guard waits for shell modifiers to clear before attempting acquisition", async () => {
	const clock = new FakeClock();
	const started = clock.now();
	let samples = 0;
	const attemptTimes: number[] = [];
	const browser = new SyntheticBrowser({ read: async () => {
		samples++;
		return attemptTimes.length ? reading() : shell(samples === 1 ? ["Control"] : []);
	}, acquire: async () => { attemptTimes.push(clock.now() - started); return reading(); } }, clock);
	assert.deepEqual(await browser.guard("http://127.0.0.1:1234"), { ok: true, detail: "Course" });
	assert.equal(samples, 3);
	assert.deepEqual(attemptTimes, [50]);
	assert.deepEqual(clock.sleeps, [50]);
});

test("guard leaves persistent shell modifiers untouched", async () => {
	const clock = new FakeClock();
	const started = clock.now();
	const sampleTimes: number[] = [];
	let attempts = 0;
	const browser = new SyntheticBrowser({
		read: async () => { sampleTimes.push(clock.now() - started); return shell(["Control", "Alt"]); },
		acquire: async () => { attempts++; return reading(); },
	}, clock);
	assert.deepEqual(await browser.guard("http://127.0.0.1:1234"), { ok: false, detail: "keys still held down: Control, Alt; the probe cannot identify their source" });
	assert.equal(clock.now() - started, 300);
	assert.deepEqual(sampleTimes, [0, 50, 100, 150, 200, 250, 300]);
	assert.deepEqual(clock.sleeps, [50, 50, 50, 50, 50, 50]);
	assert.equal(attempts, 0);
});

test("guard verifies the same browser HWND across page checks and subsequent guards", async () => {
	let current = reading();
	const browser = new SyntheticBrowser({ read: async () => current });
	assert.equal((await browser.guard("http://127.0.0.1:1234")).ok, true);
	current = { ...reading(), hwnd: "4242" };
	assert.match((await browser.guard("http://127.0.0.1:1234")).detail, /foreground window changed/);
	let samples = 0;
	const interrupted = new SyntheticBrowser({ read: async () => samples++ === 0 ? reading() : reading([], 7) });
	assert.match((await interrupted.guard("http://127.0.0.1:1234")).detail, /process 7/);
});

test("guard refuses a replacement browser HWND before acquisition activates it", async () => {
	let target = reading();
	let foreground = target;
	const activations: string[] = [];
	const unlocks: string[] = [];
	const browser = new SyntheticBrowser({
		read: async () => foreground,
		acquire: async (_pid, unlock, expectedHwnd) => {
			if (typeof expectedHwnd === "string" && target.hwnd !== expectedHwnd) throw new Error("the journey browser foreground window changed before acquisition");
			if (unlock) unlocks.push(target.hwnd);
			activations.push(target.hwnd);
			return foreground = target;
		},
	});
	assert.equal((await browser.guard("http://127.0.0.1:1234")).ok, true);
	target = { ...reading(), hwnd: "84" };
	foreground = shell();
	const result = await browser.guard("http://127.0.0.1:1234");
	assert.equal(result.ok, false);
	assert.match(result.detail, /foreground window changed before acquisition/);
	assert.deepEqual(activations, [], "the replacement window must remain inactive");
	assert.deepEqual(unlocks, [], "the replacement window must not receive an Alt unlock");
	assert.equal(foreground.title, "Program Manager");
});

test("foreground acquisition preserves the address-bar guard", async () => {
	let current = shell();
	const browser = new SyntheticBrowser({ read: async () => current, acquire: async () => current = reading() });
	browser.focused = false;
	assert.match((await browser.guard("http://127.0.0.1:1234")).detail, /browser's own interface/);
	assert.equal((await browser.guard("http://127.0.0.1:1234", { pageFocus: false })).ok, true);
	assert.deepEqual(injected(browser.commands), []);
});

test("guard stops on a persistent modifier without sending a release", async () => {
	const clock = new FakeClock();
	const started = clock.now();
	let count = 0;
	const browser = new SyntheticBrowser({ read: async () => { count++; return reading(["Control"]); } }, clock);
	const result = await browser.guard("http://127.0.0.1:1234");
	assert.deepEqual(result, { ok: false, detail: "keys still held down: Control; the probe cannot identify their source" });
	assert.equal(count, 7);
	assert.equal(clock.now() - started, 300);
	assert.deepEqual(clock.sleeps, [50, 50, 50, 50, 50, 50]);
});

test("guard checks the foreground again when a held modifier clears", async () => {
	const clock = new FakeClock();
	let count = 0;
	const browser = new SyntheticBrowser({ read: async () => count++ === 0 ? reading(["Control"]) : reading([], 7) }, clock);
	const result = await browser.guard("http://127.0.0.1:1234");
	assert.deepEqual(result, { ok: false, detail: 'foreground window belongs to process 7 ("Course"), not the journey browser 42' });
	assert.equal(count, 2);
	assert.deepEqual(clock.sleeps, [50]);
});

test("guard retains origin, visibility and page-focus checks", async () => {
	const browser = new SyntheticBrowser({ read: async () => reading() });
	browser.url = "http://127.0.0.1:1234.evil/index.html";
	assert.equal((await browser.guard("http://127.0.0.1:1234")).ok, false);
	browser.url = "http://127.0.0.1:1234/index.html";
	browser.visible = false;
	assert.match((await browser.guard("http://127.0.0.1:1234")).detail, /visible tab/);
	browser.visible = true;
	browser.focused = false;
	assert.match((await browser.guard("http://127.0.0.1:1234")).detail, /browser's own interface/);
	assert.equal((await browser.guard("http://127.0.0.1:1234", { pageFocus: false })).ok, true);
});

test("setup navigation verifies the top-level destination without injecting focus", async () => {
	const browser = new SyntheticBrowser();
	await browser.navigateSetup("http://127.0.0.1:1234/index.html");
	assert.deepEqual(browser.commands, ["Page.navigate", "Page.getFrameTree"]);
	browser.url = "http://127.0.0.1:1234/wrong.html";
	await assert.rejects(browser.navigateSetup("http://127.0.0.1:1234/index.html"), /destination mismatch/);
});

test("setup navigation rejects CDP errors, downloads and browser error documents", async () => {
	const browser = new SyntheticBrowser();
	browser.navigation = { errorText: "net::ERR_CONNECTION_REFUSED" };
	await assert.rejects(browser.navigateSetup(browser.url), /ERR_CONNECTION_REFUSED/);
	browser.navigation = { isDownload: true };
	await assert.rejects(browser.navigateSetup(browser.url), /download/);
	browser.navigation = { loaderId: "loaded" };
	browser.frame = { url: "chrome-error://chromewebdata/", loaderId: "loaded", unreachableUrl: browser.url };
	await assert.rejects(browser.navigateSetup(browser.url), /browser error document/);
});

test("headless setup accepts a declared canonical redirect, keeps iframe focus evidence and rejects HTTP errors", { skip: !process.env.PRAXITY_NVDA_TEST_BROWSER }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "praxity-setup-navigation-"));
	await writeFile(join(dir, "index.html"), "<!doctype html><title>Start</title><main><h1>Start</h1></main>");
	await writeFile(join(dir, "canonical.html"), "<!doctype html><title>Canonical</title><main><h1>Canonical</h1></main>");
	await writeFile(join(dir, "redirect.html"), "<!doctype html><script>setTimeout(() => location.replace('canonical.html'), 100)</script>");
	await writeFile(join(dir, "redirect404.html"), "<!doctype html><script>setTimeout(() => location.replace('missing.html'), 100)</script>");
	await writeFile(join(dir, "lms.html"), "<!doctype html><title>LMS</title><iframe id=course src=canonical.html></iframe>");
	const server = await serve(dir);
	const browser = new ChromiumJourneyBrowser({ executable: process.env.PRAXITY_NVDA_TEST_BROWSER!, screenshots: dir, courseFrameSelector: "iframe#course", args: [...HEADLESS, "--mute-audio"] });
	try {
		await browser.open(`${server.origin}/index.html`);
		await browser.navigateSetup(`${server.origin}/redirect.html`, `${server.origin}/canonical.html`);
		assert.equal((await browser.corroborate()).url, `${server.origin}/canonical.html`);
		await browser.navigateSetup(`${server.origin}/lms.html`);
		const iframe = await browser.corroborate();
		assert.equal(iframe.topLevelUrl, `${server.origin}/lms.html`);
		assert.equal(iframe.url, `${server.origin}/canonical.html`);
		assert.equal(iframe.title, "Canonical");
		assert.equal(iframe.pageFocused, true);
		await assert.rejects(browser.navigateSetup(`${server.origin}/redirect404.html`, `${server.origin}/missing.html`), /HTTP 404/);
	} finally {
		await browser.close(); await server.close();
		assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
		await rm(dir, { recursive: true, force: true });
	}
});

test("NVDA exit allows a short lag after Guidepup's stop, then fails with the remaining processes", async () => {
	let clock = 0, lists = 0;
	const timing = { timeoutMs: 1000, pollMs: 200, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
	// NVDA logs its exit before nvda.exe ends; two late samples still pass.
	await waitForNvdaExit(async () => (++lists <= 2 ? ["nvda.exe"] : []), timing);
	assert.equal(lists, 3);
	clock = 0;
	await assert.rejects(waitForNvdaExit(async () => ["nvda.exe", "nvda_slave.exe"], timing), /NVDA did not stop: nvda\.exe, nvda_slave\.exe/);
	assert.equal(clock, 1000, "gives up at the deadline, not before");
});

test("journey error evidence keeps every cleanup failure inside an AggregateError", () => {
	const text = describeJourneyError(new AggregateError([new Error("NVDA did not stop: nvda.exe"), new Error("journey browser did not exit")], "NVDA journey cleanup failed"));
	assert.match(text, /NVDA journey cleanup failed/);
	assert.match(text, /\[1\] Error: NVDA did not stop: nvda\.exe/);
	assert.match(text, /\[2\] Error: journey browser did not exit/);
	assert.equal(describeJourneyError("plain"), "plain");
});
