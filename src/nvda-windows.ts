// Windows adapters for the experimental NVDA journey. See src/nvda-journey.ts.
//
// The browser runs as an ordinary headed process with a throwaway profile. The
// DevTools reads URL, title, the focused node's accessibility properties and
// live-region text, takes screenshots, and performs marked setup navigation.

import { guidepupCachePath, nvdaExecutable } from "./guidepup-assets.ts";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer, type Server as NetworkServer } from "node:net";
import { chromium, type Browser } from "playwright";
import { isAuditServerUrl } from "./serve.ts";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { audioDuckingSetting, evaluateJourney, narrationIntervals, renderJourneyMarkdown, runJourney, settingDifferences, verifyAddressDestination, withJourneySignals, type BrowserEvent, type BrowserObservation, type Corroboration, type FocusedNode, type Journey, type JourneyBrowser, type JourneyEnvironment, type JourneyOutcome, type JourneyRun, type NvdaDriver, type OrientationSnapshot } from "./nvda-journey.ts";

const run = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
	finally { clearTimeout(timer); }
}

export interface ForegroundReading {
	pid: number; title: string; held: string[];
	hwnd: string; className: string; owned: boolean;
	/** True only for the shell/desktop HWND or no foreground window on the Default input desktop. */
	shell: boolean;
	interactive: boolean;
}

export interface ForegroundAdapter {
	read(timeoutMs?: number): Promise<ForegroundReading>;
	/** Checks the remembered target HWND, foreground and held keys before activation or synthetic input. */
	acquire(browserPid: number, unlock: boolean, expectedHwnd?: string, timeoutMs?: number): Promise<ForegroundReading>;
}

/** Key-state reads cannot identify who pressed a key. Retry a short hold, never release it. */
export function foregroundGuardDecision(reading: ForegroundReading, browserPid: number | undefined, settling: boolean): { outcome: "ready" | "acquire" | "retry" | "stop"; detail: string } {
	if (!reading.interactive) return { outcome: "stop", detail: "the interactive input desktop is unavailable or a secure desktop is active" };
	if (!browserPid || (reading.pid !== browserPid && !reading.shell)) return { outcome: "stop", detail: `foreground window belongs to process ${reading.pid} (${JSON.stringify(reading.title)}), not the journey browser ${browserPid}` };
	if (reading.pid === browserPid && (reading.className !== "Chrome_WidgetWin_1" || reading.owned)) return { outcome: "stop", detail: `foreground window is a browser dialog or unexpected window (${JSON.stringify(reading.title)})` };
	if (reading.held.length) return { outcome: settling ? "retry" : "stop", detail: `keys still held down: ${reading.held.join(", ")}; the probe cannot identify their source` };
	if (reading.pid !== browserPid) return { outcome: "acquire", detail: reading.title };
	return { outcome: "ready", detail: reading.title };
}

/**
 * NVDA logs its exit before its process ends, so a check made right after Guidepup's stop
 * can still see nvda.exe. Wait a bounded time for the processes to go before failing.
 */
export async function waitForNvdaExit(
	list: () => Promise<string[]> = runningNvdaProcesses,
	{ timeoutMs = 5_000, pollMs = 200, now = Date.now, sleep = delay }: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<void> {
	const deadline = now() + timeoutMs;
	let remaining = await list();
	while (remaining.length && now() < deadline) {
		await sleep(pollMs);
		remaining = await list();
	}
	if (remaining.length) throw new Error(`NVDA did not stop: ${remaining.join(", ")}`);
}

/** Cleanup failures arrive as an AggregateError; keep each inner error so the evidence says what failed. */
export function describeJourneyError(error: unknown): string {
	const lines = [error instanceof Error ? error.stack ?? error.message : String(error)];
	if (error instanceof AggregateError) {
		for (const [index, inner] of error.errors.entries()) {
			lines.push(`  [${index + 1}] ${(inner instanceof Error ? inner.stack ?? inner.message : String(inner)).replace(/\n/g, "\n      ")}`);
		}
	}
	return lines.join("\n");
}

export async function runningNvdaProcesses(): Promise<string[]> {
	const { stdout } = await run("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
	return stdout.split(/\r?\n/)
		.map((line) => line.split('","')[0]?.replace(/^"/, "") ?? "")
		.filter((name) => /^nvda.*\.exe$/i.test(name));
}

export async function fileVersion(path: string): Promise<string> {
	// -Command does not populate $args, so the path travels in the environment rather than the script text.
	const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:PRAXITY_FILE_VERSION_PATH).VersionInfo.ProductVersion"],
		{ encoding: "utf8", windowsHide: true, env: { ...process.env, PRAXITY_FILE_VERSION_PATH: path } });
	return stdout.trim();
}

export async function windowsVersion(): Promise<string> {
	const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
		// Windows 11 still reports ProductName "Windows 10"; build 22000 is the first Windows 11 build.
		"$v = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; $n = $v.ProductName; if ([int]$v.CurrentBuild -ge 22000) { $n = $n -replace '^Windows 10', 'Windows 11' }; \"$n $($v.DisplayVersion) build $($v.CurrentBuild).$($v.UBR)\""], { encoding: "utf8", windowsHide: true });
	return stdout.trim();
}

const PROBE_SCRIPT = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic; using System.ComponentModel;
public sealed class PraxityReading {
  public uint pid; public string title; public string hwnd; public string className;
  public bool owned; public bool shell; public bool interactive; public string[] held;
}
public static class PraxityProbe {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] private static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string className, string title);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder text, uint count, out uint needed);
  [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MouseInput mouse; [FieldOffset(0)] public KeyboardInput keyboard; }
  [StructLayout(LayoutKind.Sequential)] private struct Input { public uint type; public InputUnion data; }
  [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);

  private static bool DefaultInputDesktop() {
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) return false;
    try { var name = new StringBuilder(512); uint needed; return GetUserObjectInformation(desktop, 2, name, 1024, out needed) && name.ToString() == "Default"; }
    finally { CloseDesktop(desktop); }
  }

  private static bool ShellWindow(IntPtr hwnd) {
    IntPtr shell = GetShellWindow();
    if (hwnd == IntPtr.Zero || hwnd == shell || hwnd == GetDesktopWindow()) return true;
    // The taskbar can retain foreground after the last application is minimized.
    // Match its HWND and the real shell's PID, never just an Explorer window or title.
    IntPtr taskbar = FindWindow("Shell_TrayWnd", null);
    if (shell == IntPtr.Zero || taskbar == IntPtr.Zero || hwnd != taskbar || GetWindow(hwnd, 4) != IntPtr.Zero) return false;
    uint shellPid, taskbarPid;
    GetWindowThreadProcessId(shell, out shellPid);
    GetWindowThreadProcessId(taskbar, out taskbarPid);
    return shellPid != 0 && taskbarPid == shellPid;
  }

  public static PraxityReading Read() {
    IntPtr hwnd = GetForegroundWindow(); uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    var title = new StringBuilder(512); GetWindowText(hwnd, title, 512);
    var name = new StringBuilder(256); GetClassName(hwnd, name, 256);
    var held = new List<string>();
    var keys = new Dictionary<string, int> { {"Shift", 0x10}, {"Control", 0x11}, {"Alt", 0x12}, {"Windows", 0x5B}, {"RightWindows", 0x5C}, {"Insert", 0x2D} };
    foreach (var key in keys) if ((GetAsyncKeyState(key.Value) & 0x8000) != 0) held.Add(key.Key);
    held.Sort();
    bool interactive = DefaultInputDesktop();
    return new PraxityReading { pid = pid, title = title.ToString(), hwnd = hwnd.ToString(), className = name.ToString(),
      owned = GetWindow(hwnd, 4) != IntPtr.Zero, interactive = interactive,
      shell = interactive && ShellWindow(hwnd), held = held.ToArray() };
  }

  private static IntPtr BrowserWindow(uint browserPid) {
    var windows = new List<IntPtr>();
    if (!EnumWindows(delegate(IntPtr hwnd, IntPtr parameter) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid == browserPid && IsWindowVisible(hwnd) && GetWindow(hwnd, 4) == IntPtr.Zero) {
        var name = new StringBuilder(256); GetClassName(hwnd, name, 256);
        if (name.ToString() == "Chrome_WidgetWin_1") windows.Add(hwnd);
      }
      return true;
    }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "could not enumerate browser windows");
    if (windows.Count != 1) throw new InvalidOperationException("expected exactly one journey browser window, found " + windows.Count);
    return windows[0];
  }

  private static bool SafeToActivate(PraxityReading reading, IntPtr target, uint browserPid) {
    uint pid; GetWindowThreadProcessId(target, out pid);
    var name = new StringBuilder(256); GetClassName(target, name, 256);
    if (!IsWindow(target) || pid != browserPid || name.ToString() != "Chrome_WidgetWin_1" || GetWindow(target, 4) != IntPtr.Zero)
      throw new InvalidOperationException("the journey browser target window changed before activation");
    if (reading.pid == browserPid && reading.hwnd != target.ToString())
      throw new InvalidOperationException("foreground HWND does not match the journey browser target window");
    return reading.interactive && reading.held.Length == 0 &&
      (reading.shell || (reading.pid == browserPid && reading.hwnd == target.ToString() && reading.className == "Chrome_WidgetWin_1" && !reading.owned));
  }

  public static PraxityReading Acquire(uint browserPid, bool unlock, string expectedHwnd) {
    IntPtr target = BrowserWindow(browserPid);
    if (expectedHwnd != "new" && target.ToString() != expectedHwnd)
      throw new InvalidOperationException("the journey browser foreground window changed before acquisition");
    var reading = Read();
    if (!SafeToActivate(reading, target, browserPid) || reading.hwnd == target.ToString()) return reading;
    // Windows may reject the request despite returning success. Always verify the HWND and PID.
    SetForegroundWindow(target);
    reading = Read();
    bool safe = SafeToActivate(reading, target, browserPid);
    if (!unlock || !safe || reading.hwnd == target.ToString()) return reading;
    // A bare Alt press unlocks SetForegroundWindow. It is permitted only over the shell,
    // with no held modifiers, and never over another application or a secure desktop.
    reading = Read();
    if (!reading.shell || !SafeToActivate(reading, target, browserPid)) return reading;
    var down = new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { key = 0x12 } } };
    var up = new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { key = 0x12, flags = 2 } } };
    uint sent = SendInput(2, new Input[] { down, up }, Marshal.SizeOf(typeof(Input)));
    if (sent != 2) {
      // If only our Alt-down was inserted, release only that synthetic key before failing.
      if (sent == 1) SendInput(1, new Input[] { up }, Marshal.SizeOf(typeof(Input)));
      throw new InvalidOperationException("foreground Alt input was blocked or incomplete, inserted " + sent + " of 2 events");
    }
    reading = Read();
    if (SafeToActivate(reading, target, browserPid)) SetForegroundWindow(target);
    reading = Read();
    SafeToActivate(reading, target, browserPid);
    return reading;
  }
}
"@
$original = [PraxityProbe]::GetForegroundWindow()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    if ($line -eq "restore") {
      if ([PraxityProbe]::IsWindow($original)) { [void][PraxityProbe]::SetForegroundWindow($original) }
      $response = @{ restored = -not [PraxityProbe]::IsWindow($original) -or [PraxityProbe]::GetForegroundWindow() -eq $original }
    } elseif ($line -match '^acquire ([0-9]+) (plain|alt) (-?[0-9]+|new)$') {
      $response = [PraxityProbe]::Acquire([uint32]$Matches[1], $Matches[2] -eq 'alt', $Matches[3])
    } elseif ($line -eq 'probe') {
      $response = [PraxityProbe]::Read()
    } else { throw "unknown foreground probe command" }
  } catch {
    $response = @{ error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}`;

/** Reads and conditionally acquires the journey browser through one persistent Win32 helper. */
export class ForegroundProbe implements ForegroundAdapter {
	#child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROBE_SCRIPT], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	#lines = createInterface({ input: this.#child.stdout! })[Symbol.asyncIterator]();
	#failure?: Error;
	#stderr = "";

	constructor() {
		this.#child.on("error", (error) => { this.#failure = error; });
		this.#child.stdin!.on("error", (error) => { this.#failure = error; });
		this.#child.stderr!.on("data", (chunk) => { this.#stderr = (this.#stderr + String(chunk)).slice(-4096); });
	}

	async #request(command: string, timeoutMs = 5_000): Promise<any> {
		if (this.#failure) throw this.#failure;
		this.#child.stdin!.write(`${command}\n`);
		try {
			const next = await within(this.#lines.next(), timeoutMs, `foreground probe did not answer within ${timeoutMs} ms`);
			if (this.#failure) throw this.#failure;
			if (next.done) throw new Error("foreground probe exited without answering");
			const response = JSON.parse(next.value);
			if (response.error) throw new Error(response.error);
			return response;
		} catch (error) {
			this.close();
			this.#failure = new Error(`${error instanceof Error ? error.message : String(error)}${this.#stderr ? `: ${this.#stderr.trim()}` : ""}`);
			throw this.#failure;
		}
	}

	async #reading(command: string, timeoutMs?: number): Promise<ForegroundReading> {
		const reading = await this.#request(command, timeoutMs);
		// ConvertTo-Json writes a one-item array as a bare string and an empty one as null.
		return { ...reading, held: [reading.held ?? []].flat() };
	}

	read(timeoutMs?: number): Promise<ForegroundReading> { return this.#reading("probe", timeoutMs); }

	acquire(browserPid: number, unlock: boolean, expectedHwnd?: string, timeoutMs?: number): Promise<ForegroundReading> {
		if (!Number.isSafeInteger(browserPid) || browserPid <= 0) return Promise.reject(new Error("invalid journey browser process ID"));
		if (expectedHwnd !== undefined && !/^-?[0-9]+$/.test(expectedHwnd)) return Promise.reject(new Error("invalid journey browser window handle"));
		return this.#reading(`acquire ${browserPid} ${unlock ? "alt" : "plain"} ${expectedHwnd ?? "new"}`, timeoutMs);
	}

	async restore(): Promise<void> {
		if (!(await this.#request("restore")).restored) throw new Error("could not restore the original foreground window");
	}

	close(): void {
		this.#child.stdin!.end();
		this.#child.kill();
	}
}

class Cdp {
	#socket: WebSocket;
	#nextId = 1;
	#pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	onEvent?: (message: { method: string; params: any; sessionId?: string }) => void;

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: any; sessionId?: string };
			if (message.method) this.onEvent?.({ method: message.method, params: message.params, sessionId: message.sessionId });
			const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id!);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
		socket.addEventListener("close", () => {
			for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("DevTools connection closed")); }
			this.#pending.clear();
		});
	}

	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		await within(new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
		}), 10_000, `DevTools connection timed out: ${url}`);
		return new Cdp(socket);
	}

	get open(): boolean {
		return this.#socket.readyState === WebSocket.OPEN;
	}

	send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
			}, 10_000);
			this.#pending.set(id, { resolve, reject, timer });
			try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
			catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
		});
	}

	close(): void {
		this.#socket.close();
	}
}

const STATE_PROPERTIES = new Set(["checked", "expanded", "pressed", "selected", "disabled", "required", "invalid", "busy", "modal"]);
const LIVE_REGION_TEXT = `[...document.querySelectorAll('[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]')]
	.map((element) => element.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean)`;

// Exported for headless synthetic checks. It only reads course state and emits telemetry.
export function installJourneyObserver(): void {
	const state = globalThis as unknown as { __praxityJourneyObserverInstalled?: boolean };
	if (state.__praxityJourneyObserverInstalled) return;
	state.__praxityJourneyObserverInstalled = true;
	const emit = (event: Record<string, unknown>) => {
		const binding = (globalThis as unknown as Record<string, (payload: string) => void>).__praxityJourneyEvent;
		binding?.(JSON.stringify({ ...event, epochMs: Date.now() }));
	};
	const clean = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim();
	const mediaIds = new WeakMap<HTMLMediaElement, string>();
	let mediaCount = 0;
	for (const event of ["play", "playing", "pause", "ended", "error", "loadedmetadata", "durationchange"] as const) {
		document.addEventListener(event, (message) => {
			const media = message.target;
			if (!(media instanceof HTMLMediaElement)) return;
			if (!mediaIds.has(media)) mediaIds.set(media, `${performance.timeOrigin}-${++mediaCount}`);
			emit({ kind: "media", event, mediaId: mediaIds.get(media), src: media.currentSrc || media.src,
				currentTime: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : null,
				paused: media.paused, muted: media.muted, volume: media.volume,
				playbackRate: media.playbackRate, error: media.error ? `${media.error.code}: ${media.error.message}` : null });
		}, true);
	}
	for (const event of ["hashchange", "popstate"] as const) window.addEventListener(event, () => emit({ kind: "navigation", event, url: location.href }));
	window.addEventListener("pagehide", () => emit({ kind: "navigation", event: "document-hidden", url: location.href }));
	const liveSelector = '[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]';
	const previousLive = new Map<Element, string>();
	let previousSlide: string | undefined;
	const scan = () => {
		// The exported deck runtime sets hidden and inert on [data-deck-slide] articles.
		// In this export data-deck-page belongs to navigation links. Prefer slide
		// containers and exclude links/buttons from the alternate page selector.
		const candidates = Array.from(document.querySelectorAll('[data-deck-slide],[data-deck-page]:not(a):not(button),article[aria-hidden],article[inert],article[aria-current]'));
		// A transcript dialog may make the whole workspace inert. It does not
		// change which slide is current; only the slide's own runtime flags do.
		const visible = candidates.filter((element) => !element.matches('[hidden],[inert],[aria-hidden="true"]'));
		const current = visible.find((element) => element.matches('[data-deck-slide]')) ?? visible.find((element) => element.matches('[aria-current="true"],[aria-current="page"]')) ?? visible[0];
		const labels = current?.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
		const slide = current ? { id: current.id || current.getAttribute("data-deck-slide") || current.getAttribute("data-deck-page") || "",
			name: clean(current.getAttribute("aria-label") || labels || current.querySelector("h1,h2,h3,h4,h5,h6")?.textContent || "") } : null;
		const signature = JSON.stringify(slide);
		if (signature !== previousSlide) { previousSlide = signature; emit({ kind: "slide", event: "slide-change", slide }); }
		const regions = new Set(Array.from(document.querySelectorAll(liveSelector)));
		for (const [element, previous] of previousLive) {
			if (!regions.has(element)) {
				if (previous) emit({ kind: "live", event: "live-text", id: element.id, className: element.getAttribute("class") ?? "", ariaLive: element.getAttribute("aria-live"), role: element.getAttribute("role"), text: "", cleared: true });
				previousLive.delete(element);
			}
		}
		for (const element of regions) {
			const text = clean(element.textContent);
			if (previousLive.get(element) !== text) {
				previousLive.set(element, text);
				emit({ kind: "live", event: "live-text", id: element.id, className: element.getAttribute("class") ?? "", ariaLive: element.getAttribute("aria-live"), role: element.getAttribute("role"), text, cleared: !text });
			}
		}
	};
	new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
		attributeFilter: ["hidden", "inert", "aria-hidden", "aria-current", "aria-live", "aria-label", "aria-labelledby", "role", "data-deck-slide", "data-deck-page"] });
	document.addEventListener("DOMContentLoaded", scan);
	window.addEventListener("pageshow", (event) => { if (event.persisted) { previousSlide = undefined; scan(); } });
	if (document.readyState !== "loading") scan();
}

export function orientationFromAxNodes(nodes: any[]): OrientationSnapshot {
	const exposed = nodes.filter((node) => !node.ignored);
	const landmarks = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);
	return {
		landmarks: exposed.filter((node) => landmarks.has(node.role?.value)).map((node) => ({ role: String(node.role.value), name: String(node.name?.value ?? "") })),
		headings: exposed.filter((node) => node.role?.value === "heading").map((node) => ({ name: String(node.name?.value ?? ""), level: node.properties?.find((property: any) => property.name === "level")?.value?.value ?? null })),
		focusableCount: exposed.filter((node) => node.properties?.some((property: any) => property.name === "focusable" && property.value?.value === true)).length,
	};
}

export interface ChromiumOptions {
	executable: string;
	screenshots: string;
	/** Process adapter. The default launches the configured executable with these browser switches. */
	launch?: (executable: string, args: string[]) => ChildProcess;
	probe?: Pick<ForegroundAdapter, "read"> & Partial<Pick<ForegroundAdapter, "acquire">>;
	/** Clock seam for foreground timing so tests can advance the acquisition and settling windows. */
	clock?: { now: () => number; sleep: (ms: number) => Promise<void> };
	/** Optional same-origin LMS child used for course corroboration. The guard always reads the top document. */
	courseFrameSelector?: string;
	/** Extra switches, for example a host resolver rule that blocks remote hosts. */
	args?: string[];
	allowNetwork?: boolean;
}

/** A headed Chromium-family browser (Chrome, Chrome for Testing or Edge) with a throwaway profile. */
export class ChromiumJourneyBrowser implements JourneyBrowser {
	#options: ChromiumOptions;
	#clock: NonNullable<ChromiumOptions["clock"]>;
	#child: ChildProcess | undefined;
	#profile: string | undefined;
	#port = 0;
	#targetId: string | undefined;
	#pageSessionId: string | undefined;
	#browserCdp: Cdp | undefined;
	#playwrightBrowser?: Browser;
	#observed = new Map<string, BrowserEvent[]>();
	#observerInstalled = false;
	#documentResponses = new Map<string, { status: number; url: string }>();
	#launchError?: Error;
	#networkDeny?: NetworkServer;
	#foregroundHwnd?: string;

	constructor(options: ChromiumOptions) {
		this.#options = options;
		this.#clock = options.clock ?? { now: Date.now, sleep: delay };
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	async windowGeometry(): Promise<{ windowId: number; bounds: { width: number; height: number; windowState: string } }> {
		if (!this.#browserCdp || !this.#targetId) throw new Error("browser is not open");
		return this.#browserCdp.send("Browser.getWindowForTarget", { targetId: this.#targetId });
	}

	async open(url: string): Promise<void> {
		try {
			await this.#open(url);
		} catch (error) {
			// A failed launch must not leave the deny proxy, browser or profile behind; they keep the process alive.
			try { await this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "journey browser failed to open and its cleanup failed"); }
			throw error;
		}
	}

	async #open(url: string): Promise<void> {
		await stat(this.#options.executable);
		const networkArgs: string[] = [];
		if (!this.#options.allowNetwork) {
			// Browser-wide proxy policy reaches sockets in Blob/shared workers and
			// new tabs before they can run, unlike page-level debugger interception.
			const deny = this.#networkDeny = createServer((socket) => socket.destroy());
			await new Promise<void>((resolve, reject) => { deny.once("error", reject); deny.listen(0, "127.0.0.1", resolve); });
			const address = deny.address();
			if (!address || typeof address === "string") throw new Error("network deny proxy did not bind");
			const allowed = new URL(url);
			networkArgs.push(`--proxy-server=http://127.0.0.1:${address.port}`, `--proxy-bypass-list=<-loopback>;${allowed.protocol}//${allowed.hostname}:${allowed.port || (allowed.protocol === "https:" ? "443" : "80")}`, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
		}
		this.#profile = await mkdtemp(join(tmpdir(), "praxity-nvda-browser-"));
		await writeFile(join(this.#profile, "First Run"), "");
		const launch = this.#options.launch ?? ((executable: string, args: string[]) => spawn(executable, args, { stdio: "ignore", windowsHide: false }));
		this.#child = launch(this.#options.executable, [
			`--user-data-dir=${this.#profile}`,
			"--remote-debugging-port=0",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-sync",
			// Cast discovery listens on the local network, so each new chrome.exe path raises a
			// Windows Firewall prompt that takes the foreground mid-journey. Playwright turns it off too.
			"--disable-features=MediaRouter,DialMediaRouteProvider",
			"--disable-background-networking",
			...(this.#options.args?.some((arg) => arg.startsWith("--window-size=")) ? [] : ["--start-maximized"]),
			...(this.#options.args ?? []),
			...networkArgs,
			"about:blank",
		]);
		this.#child.on("error", (error) => { this.#launchError = error; });
		for (let attempt = 0; attempt < 100 && !this.#port; attempt++) {
			await delay(200);
			if (this.#launchError) throw this.#launchError;
			const active = await readFile(join(this.#profile, "DevToolsActivePort"), "utf8").catch(() => "");
			this.#port = Number(active.split(/\r?\n/)[0]) || 0;
		}
		if (!this.#port) throw new Error("browser did not open a DevTools port");
		// A start URL on the command line was dropped in testing, so the browser opens
		// about:blank and the start page opens in a new foreground tab, like following a
		// course link. Navigating the blank tab instead leaves keyboard focus in the
		// address bar. Everything after this is keyboard input through NVDA.
		let blankId: string | undefined;
		for (let attempt = 0; attempt < 50 && !blankId; attempt++) {
			const targets = await this.#targets().catch(() => []);
			blankId = targets.find((target) => target.type === "page")?.id;
			if (!blankId) await delay(200);
		}
		if (!blankId) throw new Error("browser opened no tab");
		// Chromium begins a createTarget URL navigation before attaching DevTools.
		// A committed empty document lets us install before the sole course navigation.
		// It also avoids the address-bar focus of an uncommitted about:blank tab.
		const version = await (await fetch(`http://127.0.0.1:${this.#port}/json/version`)).json() as { webSocketDebuggerUrl: string };
		const browserCdp = this.#browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);
		browserCdp.onEvent = (message) => {
			if (message.method === "Network.responseReceived" && message.sessionId === this.#pageSessionId && message.params.type === "Document") {
				this.#documentResponses.set(message.params.loaderId, { status: message.params.response.status, url: message.params.response.url });
			}
			if (message.method === "Page.frameNavigated" && message.sessionId === this.#pageSessionId && !message.params.frame.parentId) {
				// An unload binding can disappear with its execution context. CDP's
				// top-frame commit also closes media intervals from the old document.
				const events = this.#observed.get(this.#targetId!) ?? [];
				events.push({ epochMs: Date.now(), kind: "navigation", event: "document-change", url: message.params.frame.url });
				this.#observed.set(this.#targetId!, events);
			}
			if (message.method === "Runtime.bindingCalled" && message.sessionId === this.#pageSessionId && message.params.name === "__praxityJourneyEvent") {
				const events = this.#observed.get(this.#targetId!) ?? [];
				events.push(JSON.parse(message.params.payload) as BrowserEvent);
				this.#observed.set(this.#targetId!, events);
			}
		};
		// Context-wide routes cover popup initial requests too. Block service
		// workers before any course code executes, because they can bypass routes.
		this.#playwrightBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${this.#port}`);
		const context = await this.#playwrightBrowser.newContext({ serviceWorkers: this.#options.allowNetwork ? "allow" : "block" });
		if (!this.#options.allowNetwork) {
			// Chromium's UDP policy switch does not suppress STUN consistently.
			// These trusted-content journeys have no RTC use in offline mode.
			await context.addInitScript(() => {
				for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
					Object.defineProperty(globalThis, name, { configurable: false, writable: false, value: class {
						constructor() { throw new Error("WebRTC is blocked by Praxity Check; use --allow-network"); }
					} });
				}
			});
			await context.route("**/*", async (route) => {
				if (isAuditServerUrl(route.request().url(), new URL(url).origin)) await route.continue();
				else await route.abort("blockedbyclient");
			});
			// All sockets are disabled by default, including same-origin sockets.
			await context.routeWebSocket("**/*", (socket) => socket.close());
		}
		const page = await context.newPage();
		await page.goto("data:text/html,<!doctype html><meta charset=utf-8>");
		const pageCdp = await context.newCDPSession(page);
		const { targetInfo } = await pageCdp.send("Target.getTargetInfo");
		this.#targetId = targetInfo.targetId;
		await pageCdp.detach();
		const attached = await browserCdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: this.#targetId, flatten: true });
		this.#pageSessionId = attached.sessionId;
		await this.send("Page.enable");
		await this.send("Runtime.enable");
		await this.send("Network.enable");
		if (!this.#options.allowNetwork) {
			// Playwright's WebSocket routes cover pages and popups. Chromium's
			// blocked URL list also reaches dedicated-worker socket handshakes.
			await this.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
		}
		await this.send("Runtime.addBinding", { name: "__praxityJourneyEvent" });
		await this.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installJourneyObserver.toString()})();` });
		this.#observerInstalled = true;
		// Remove the initial window before pinning the course window's HWND. NVDA
		// needs the course window in foreground when its first document loads.
		const closed = await browserCdp.send<{ success: boolean }>("Target.closeTarget", { targetId: blankId });
		if (!closed.success) throw new Error("the original blank browser tab did not close");
		let blankClosed = false;
		for (let attempt = 0; attempt < 20; attempt++) {
			if (!(await this.#targets()).some((target) => target.id === blankId)) { blankClosed = true; break; }
			await delay(50);
		}
		if (!blankClosed) throw new Error("the original blank browser tab did not finish closing within 1000 ms");
		if (this.#options.probe) this.#foregroundHwnd = (await this.#acquireForeground()).hwnd;
		// Course index documents deliberately redirect to their canonical page.
		// Initial setup retains the origin check; the runner checks the named start.
		await this.#navigate(url);
	}

	/** Setup-only navigation. Learner journey actions continue to use the configured input driver. */
	async navigateSetup(url: string, expectedDestination = url): Promise<void> {
		if (new URL(expectedDestination).origin !== new URL(url).origin) throw new Error("setup destination must keep the requested origin");
		await this.#navigate(url, expectedDestination);
	}

	async #navigate(url: string, expectedDestination?: string): Promise<void> {
		const expected = verifyAddressDestination(url, url);
		if (!expected.ok) throw new Error(expected.detail);
		const navigation = await this.send<{ errorText?: string; loaderId?: string; isDownload?: boolean }>("Page.navigate", { url });
		if (navigation.errorText || navigation.isDownload) throw new Error(`browser did not load ${url}: ${navigation.errorText ?? "navigation became a download"}`);
		for (let attempt = 0; attempt < 50; attempt++) {
			const { frameTree } = await this.send<{ frameTree: { frame: { url: string; loaderId: string; unreachableUrl?: string } } }>("Page.getFrameTree");
			const frame = frameTree.frame;
			if (frame.unreachableUrl || frame.url.startsWith("chrome-error:")) throw new Error(`browser error document while loading ${url}: ${frame.unreachableUrl ?? frame.url}`);
			const response = this.#documentResponses.get(frame.loaderId) ?? this.#documentResponses.get(navigation.loaderId ?? frame.loaderId);
			if (response && response.status >= 400) throw new Error(`browser did not load ${url}: HTTP ${response.status} at ${response.url}`);
			// A client redirect commits a new loader. A Document response for that
			// canonical URL proves it loaded, rather than accepting the old page.
			const redirected = frame.url !== url && this.#documentResponses.has(frame.loaderId);
			if ((!navigation.loaderId || frame.loaderId === navigation.loaderId || redirected) && await this.evaluate<string>("document.readyState") === "complete") {
				const actual = await this.evaluate<string>("location.href");
				const result = verifyAddressDestination(actual, expectedDestination ?? new URL(new URL(actual).pathname + new URL(actual).search, url).href);
				if (result.ok) return;
				// The requested shell may finish before its script redirects. Only
				// wait on that known shell; an unexpected destination fails at once.
				if (!expectedDestination || expectedDestination === url || !verifyAddressDestination(actual, url).ok) throw new Error(result.detail);
			}
			await delay(200);
		}
		throw new Error(`browser did not finish loading ${url}`);
	}

	async #targets(): Promise<Array<{ id: string; type: string; url: string; webSocketDebuggerUrl?: string }>> {
		return await (await fetch(`http://127.0.0.1:${this.#port}/json/list`)).json() as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl?: string }>;
	}

	/**
	 * Whether keyboard focus is in the page rather than the browser's own interface.
	 * Playwright enables focus emulation on every page it attaches to, which makes
	 * document.hasFocus() always true. Switch it off on this session right before reading.
	 */
	async #pageHasFocus(): Promise<boolean> {
		await this.send("Emulation.setFocusEmulationEnabled", { enabled: false });
		return this.evaluate<boolean>("document.hasFocus()");
	}

	protected async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const cdp = this.#browserCdp;
		const sessionId = this.#pageSessionId;
		if (!cdp?.open || !sessionId) throw new Error("the journey tab is gone");
		this.#pageSessionId = sessionId;
		return cdp.send<T>(method, params, sessionId);
	}

	protected async evaluate<T>(expression: string): Promise<T> {
		const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "evaluation failed");
		return result.value as T;
	}

	async #acquireForeground(): Promise<ForegroundReading> {
		const probe = this.#options.probe;
		if (!probe) throw new Error("no foreground probe configured");
		// Adapter answer timeouts use real timers so a hung adapter stays bounded even when the clock seam is stopped.
		let foreground = await within(probe.read(), 5_000, "foreground probe did not answer within 5 seconds");
		const started = this.#clock.now();
		const deadline = started + 1_500;
		let attempts = 0;
		let unlocked = false;
		let decision = foregroundGuardDecision(foreground, this.pid, true);
		while (decision.outcome === "retry" || decision.outcome === "acquire") {
			if (this.#clock.now() >= deadline) throw new Error("could not acquire the journey browser foreground within 1500 ms");
			if (decision.outcome === "acquire") {
				if (!probe.acquire) throw new Error("foreground probe cannot acquire the journey browser");
				// Try ordinary activation first. At most one Alt pair is allowed per guard.
				const unlock: boolean = attempts > 0 && !unlocked;
				const remaining = Math.max(1, deadline - this.#clock.now());
				foreground = await within(probe.acquire(this.pid!, unlock, this.#foregroundHwnd, remaining), remaining, "journey browser foreground acquisition timed out");
				attempts++;
				unlocked ||= unlock;
				decision = foregroundGuardDecision(foreground, this.pid, this.#clock.now() - started < 300);
				if (decision.outcome !== "retry" && decision.outcome !== "acquire") break;
			}
			await this.#clock.sleep(50);
			if (this.#clock.now() >= deadline) throw new Error("could not acquire the journey browser foreground within 1500 ms");
			const remaining = Math.max(1, deadline - this.#clock.now());
			foreground = await within(probe.read(remaining), remaining, "journey browser foreground acquisition timed out");
			decision = foregroundGuardDecision(foreground, this.pid, this.#clock.now() - started < 300);
		}
		if (decision.outcome === "stop") throw new Error(decision.detail);
		if (this.#foregroundHwnd && foreground.hwnd !== this.#foregroundHwnd) throw new Error("the journey browser foreground window changed");
		return foreground;
	}

	async guard(origin: string, options: { pageFocus?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
		try {
			let foreground = await this.#acquireForeground();
			const hwnd = foreground.hwnd;
			const href = await this.evaluate<string>("location.href");
			if (new URL(href).origin !== new URL(origin).origin) return { ok: false, detail: `browser left the audited package: ${href}` };
			if (await this.evaluate<string>("document.visibilityState") !== "visible") return { ok: false, detail: "the journey tab is not the visible tab" };
			if ((options.pageFocus ?? true) && !await this.#pageHasFocus()) {
				return { ok: false, detail: "keyboard focus is in the browser's own interface (such as the address bar), not the page" };
			}
			// Page reads take time. Refuse a window change before returning permission to send keys.
			foreground = await within(this.#options.probe!.read(), 5_000, "foreground probe did not answer within 5 seconds");
			const decision = foregroundGuardDecision(foreground, this.pid, false);
			if (decision.outcome !== "ready") return { ok: false, detail: decision.outcome === "acquire" ? "foreground left the journey browser during page checks" : decision.detail };
			if (foreground.hwnd !== hwnd) return { ok: false, detail: "the journey browser foreground window changed" };
			this.#foregroundHwnd = hwnd;
			return { ok: true, detail: foreground.title };
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	#courseExpression(expression: string): string {
		const selector = this.#options.courseFrameSelector;
		return selector ? `(() => { const document = window.document.querySelector(${JSON.stringify(selector)})?.contentDocument ?? window.document; return (${expression}); })()` : expression;
	}

	async #focused(): Promise<FocusedNode | null> {
		const { result } = await this.send("Runtime.evaluate", { expression: this.#courseExpression("document.activeElement") });
		if (!result.objectId) return null;
		const tag = await this.evaluate<string>(this.#courseExpression("document.activeElement?.tagName.toLowerCase() ?? ''"));
		const { nodes } = await this.send<{ nodes: any[] }>("Accessibility.getPartialAXTree", { objectId: result.objectId, fetchRelatives: false });
		const node = nodes.find((candidate) => !candidate.ignored) ?? nodes[0];
		if (!node) return null;
		return {
			tag,
			role: String(node.role?.value ?? ""),
			name: String(node.name?.value ?? ""),
			description: String(node.description?.value ?? ""),
			states: (node.properties ?? [])
				.filter((property: any) => STATE_PROPERTIES.has(property.name))
				.map((property: any) => `${property.name}=${property.value?.value}`),
		};
	}

	async observe(): Promise<BrowserObservation> {
		if (!this.#observerInstalled) throw new Error("journey observer was not installed");
		// Round trip flushes pending binding messages before taking the archive snapshot.
		await this.evaluate("Date.now()");
		const events = [...(this.#observed.get(this.#targetId ?? "") ?? [])];
		const slideEvent = events.findLast((event) => event.kind === "slide");
		return { events, activeSlide: slideEvent?.kind === "slide" ? slideEvent.slide : null };
	}

	async corroborate(options: { since?: number; snapshot?: boolean } = {}): Promise<Corroboration> {
		const [url, topLevelUrl, title, liveRegions, focused, pageFocused] = await Promise.all([
			this.evaluate<string>(this.#courseExpression("document.location.href")),
			this.evaluate<string>("location.href"),
			this.evaluate<string>(this.#courseExpression("document.title")),
			this.evaluate<string[]>(this.#courseExpression(LIVE_REGION_TEXT)),
			this.#focused(),
			this.#pageHasFocus(),
		]);
		let orientation: OrientationSnapshot | undefined;
		if (options.snapshot) {
			const { nodes } = await this.send<{ nodes: any[] }>("Accessibility.getFullAXTree");
			orientation = orientationFromAxNodes(nodes);
		}
		const observation = await this.observe();
		const end = Date.now(), since = options.since ?? 0;
		return { url, topLevelUrl, title, focused, liveRegions, pageFocused, fragment: new URL(url).hash, activeSlide: observation.activeSlide,
			observerEvents: observation.events.filter((event) => event.epochMs >= since && event.epochMs <= end),
			mediaIntervals: narrationIntervals(observation.events, since, end), ...(orientation ? { orientation } : {}) };
	}

	async screenshot(name: string): Promise<string | undefined> {
		const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		const path = join(this.#options.screenshots, `${name}.png`);
		await writeFile(path, Buffer.from(data, "base64"));
		return path;
	}

	async close(): Promise<void> {
		const child = this.#child;
		// A signal-terminated child keeps exitCode null. Both fields describe its lifetime.
		const running = () => child?.exitCode === null && child?.signalCode === null;
		// Closing via DevTools below remains the fallback if Playwright disconnects.
		let disconnectError: unknown;
		try { await this.#playwrightBrowser?.close(); } catch (error) { disconnectError = error; }
		try {
			if (this.#port) {
				const version = await (await fetch(`http://127.0.0.1:${this.#port}/json/version`)).json() as { webSocketDebuggerUrl: string };
				const browser = await Cdp.connect(version.webSocketDebuggerUrl);
				await browser.send("Browser.close").catch(() => {});
				browser.close();
			}
		} catch {
			// fall through to kill
		}
		this.#browserCdp?.close();
		if (child && running()) {
			await Promise.race([once(child, "exit"), delay(5_000)]);
			if (running()) child.kill();
		}
		if (child && running()) await Promise.race([once(child, "exit"), delay(5_000)]);
		// close() runs again after a failed open(), so each resource is released once.
		const deny = this.#networkDeny;
		this.#networkDeny = undefined;
		if (deny) await new Promise<void>((resolve, reject) => deny.close((error) => error ? reject(error) : resolve()));
		if (running()) throw new Error("journey browser did not exit", { cause: disconnectError });
		if (this.#profile) await rm(this.#profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	}
}

/** Run the pinned portable NVDA through Guidepup, with no installed NVDA configuration changes. */
export async function runNvdaJourney(target: string, journey: Journey, output: string, allowNetwork: boolean): Promise<{ exitCode: 0 | 1 | 2; jsonPath: string; markdownPath: string }> {
	if (process.platform !== "win32") throw new Error("NVDA journeys require Windows");
	return withJourneySignals(async (signal) => {
		const cache = guidepupCachePath();
		const { executable, guidepupVersion } = await nvdaExecutable(cache);
		// Guidepup uses one relay and session config directory per asset. Serialize
		// across processes before it can quit NVDA or delete another run's config.
		const lock = join(cache, "praxity-nvda-journey.lock");
		await mkdir(lock).catch((cause: unknown) => { throw new Error(`Another NVDA journey owns ${lock}. Remove a stale lock only after checking that NVDA and the runner have stopped.`, { cause }); });
		let probe: ForegroundProbe | undefined;
		let result: { exitCode: 0 | 1 | 2; jsonPath: string; markdownPath: string };
		let evidence: JourneyOutcome & { version: 1; journey: Journey; environment: JourneyEnvironment; run: JourneyRun };
		let rawLogForEvidence: string | null = null;
		try {
			signal.throwIfAborted();
			const running = await runningNvdaProcesses();
			if (running.length) throw new Error(`Quit the running NVDA session first: ${running.join(", ")}. Guidepup must not take over an existing session.`);
			await mkdir(output);
			await mkdir(join(output, "screenshots"));
			const runtime = join(output, "nvda-temp");
			await mkdir(runtime);
			const logPath = join(runtime, "nvda.log");
			const settings = {
				general: { loggingLevel: "IO", saveConfigurationOnExit: false },
				virtualBuffers: { autoSayAllOnPageLoad: true, passThroughAudioIndication: true, autoPassThroughOnFocusChange: true, autoPassThroughOnCaretMove: false, useScreenLayout: true },
				keyboard: { keyboardLayout: "desktop", speakTypedCharacters: 1 },
				presentation: { reportDynamicContentChanges: true },
				speech: { synth: "oneCore", symbolLevel: 100, oneCore: { rate: 50, rateBoost: false } },
				speechViewer: { showSpeechViewerAtStartup: false },
				vision: { NVDAHighlighter: { enabled: false } },
			};
			const { nvda } = await import("@guidepup/guidepup");
			let rawLog: string | null = null;
			const readLog = async () => {
				try { return await readFile(logPath, "utf8"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
			};
			const driver: NvdaDriver = {
				version: await fileVersion(executable),
				start: async (options) => {
					// NVDA selects its default log from the child's TEMP. Redirect only
					// during launch and restore our environment even when launch fails.
					const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
					try { process.env.TEMP = runtime; process.env.TMP = runtime; await nvda.start(options); }
					finally {
						for (const key of ["TEMP", "TMP"] as const) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
					}
				},
				stop: async () => {
					try { rawLog = await readLog(); }
					finally { await nvda.stop(); }
					await waitForNvdaExit();
				},
				press: (key, options) => nvda.press(key, options),
				type: (text, options) => nvda.type(text, options),
				getSettings: () => nvda.getSettings(),
			};
			probe = new ForegroundProbe();
			await probe.read();
			const browserExecutable = process.env.PRAXITY_NVDA_BROWSER ?? chromium.executablePath();
			const browser = new ChromiumJourneyBrowser({ executable: browserExecutable, screenshots: join(output, "screenshots"), probe, allowNetwork });
			const environment: JourneyEnvironment = {
				windows: await windowsVersion(), nvda: driver.version, browser: await fileVersion(browserExecutable), guidepup: guidepupVersion,
				node: process.version, session: process.env.SESSIONNAME ?? "unknown", synthesizer: "oneCore",
				journeySha256: createHash("sha256").update(JSON.stringify(journey)).digest("hex"), settingsNotDefault: [],
			};
			let run: JourneyRun;
			const startedAt = Date.now();
			try {
				run = await runJourney({ journey: { ...journey, start: target }, origin: new URL(target).origin, nvda: driver, browser, nvdaSettings: settings, readNvdaLog: readLog, signal,
					onProgress: (message) => console.error(`NVDA: ${message}`) });
			} catch (error) {
				const message = describeJourneyError(error);
				await writeFile(join(output, "error.txt"), message);
				const retained = error instanceof AggregateError && "run" in error ? error.run as JourneyRun : undefined;
				run = { ...(retained ?? { startedAt, endedAt: Date.now(), records: [], effectiveSettings: null }), stopped: message };
			}
			const effective = run.effectiveSettings ?? settings;
			environment.settingsNotDefault = settingDifferences(effective);
			environment.audioDucking = audioDuckingSetting(effective);
			await writeFile(join(output, "settings.json"), JSON.stringify(effective, null, 2));
			rawLogForEvidence = rawLog;
			const { results, exitCode } = evaluateJourney(journey, run, rawLog, signal.aborted);
			const jsonPath = join(output, "journey.json"), markdownPath = join(output, "transcript.md");
			evidence = { version: 1, journey, environment, run, results, exitCode };
			await writeFile(jsonPath, JSON.stringify(evidence, null, 2));
			await writeFile(markdownPath, renderJourneyMarkdown(journey, run, results, environment));
			result = { exitCode, jsonPath, markdownPath };
		} finally {
			try { await probe?.restore(); }
			finally { probe?.close(); await rm(lock, { recursive: true }); }
		}
		if (signal.aborted && evidence.exitCode !== 2) {
			// An interruption during restore arrived after the evidence was written; re-evaluate so
			// journey.json and the returned exit code agree.
			evidence = { ...evidence, ...evaluateJourney(journey, evidence.run, rawLogForEvidence, true) };
			await writeFile(result.jsonPath, JSON.stringify(evidence, null, 2));
		}
		return { ...result, exitCode: evidence.exitCode };
	});
}
