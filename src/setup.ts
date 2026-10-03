import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { extractComponentArchive } from "./archives.ts";
import { checkInventory, componentDirectory, componentHost, componentManifest, componentsDirectory, javaEnvironment, resolveComponent, veraPdfJavaArgs, runtimePins, writeInventory, type Archive, type Component, type ComponentHost, type ComponentId } from "./components.ts";
export type SetupHost = ComponentHost & {
    fetchFile: (url: string) => Promise<Response>;
    confirm: (component: Component) => Promise<boolean>;
    print: (message: string) => void;
    installBrowser: (directory: string, archives: Map<string, Buffer>) => Promise<void>;
    manifest: (host: ComponentHost) => Promise<Component[]>;
};
export type SetupOptions = {
    yes?: boolean;
    from?: string;
    list?: boolean;
    selectors?: string[];
};
export async function downloadVerified(input: Pick<Archive, "url" | "sha256">, path: string, { fs, fetchFile }: Pick<SetupHost, "fs" | "fetchFile">, options: { offline?: boolean } = {}) {
    let bytes: Buffer;
    try {
        bytes = await fs.readFile(path);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
        if (options.offline)
            throw error;
        const response = await fetchFile(input.url);
        if (!response.ok)
            throw new Error(`Download failed (${response.status}): ${input.url}`);
        bytes = Buffer.from(await response.arrayBuffer());
        // Save only verified bytes. Consumers use this buffer, since the saved path can change.
        if (createHash("sha256").update(bytes).digest("hex") !== input.sha256)
            throw new Error(`SHA-256 mismatch: ${input.url}`);
        await fs.writeFile(path, bytes, { flag: "wx" });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== input.sha256)
        throw new Error(`SHA-256 mismatch: ${path}`);
    return bytes;
}
export function setupHost(overrides: Partial<SetupHost> = {}): SetupHost {
    const host: SetupHost = { ...componentHost(), fetchFile: fetch, confirm: async () => false, print: console.log, manifest: componentManifest,
        installBrowser: async (directory: string, archives: Map<string, Buffer>) => installPlaywright(host, directory, archives), ...overrides };
    return host;
}
async function installPlaywright(host: ComponentHost, directory: string, archives: Map<string, Buffer>) {
    // The official installer consumes verified archives over loopback, including offline use.
    // Its custom download host and cache folder are supported settings; no Playwright patch.
    const server = createServer((request, response) => {
        const name = basename(new URL(request.url!, "http://localhost").pathname), bytes = archives.get(name);
        if (!bytes) {
            response.writeHead(404);
            response.end("Unlisted archive");
            return;
        }
        response.writeHead(200, { "Content-Length": bytes.length, "Content-Type": "application/zip" });
        response.end(bytes);
    });
    await new Promise<void>((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", ok); });
    try {
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Browser archive server did not start");
        const require = createRequire(import.meta.url), cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
        // Only OS paths, temporary folders and locale settings cross this process boundary.
        // Inherited mirrors, proxies and Node hooks could otherwise bypass verified archives.
        const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "LANG", "LC_ALL", "LC_CTYPE"]);
        const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(host.env).filter(([key]) => allowed.has(host.platform === "win32" ? key.toUpperCase() : key)));
        const loopback = `http://127.0.0.1:${address.port}`;
        // Playwright reads each direct variable before its npm_config and npm_package_config aliases.
        for (const name of ["PLAYWRIGHT_DOWNLOAD_HOST", "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST", "PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST", "PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST"]) {
            for (const key of [name, `npm_config_${name.toLowerCase()}`, `npm_package_config_${name.toLowerCase()}`])
                env[key] = loopback;
        }
        env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost,::1,[::1]";
        const result = await host.run(process.execPath, [cli, "install", "chromium-headless-shell"], { ...env, PLAYWRIGHT_BROWSERS_PATH: directory, PLAYWRIGHT_SKIP_BROWSER_GC: "1" });
        if (result.code !== 0)
            throw new Error(`Playwright install failed: ${result.stderr || result.stdout}`);
    }
    finally {
        await new Promise<void>((ok, no) => server.close(error => error ? no(error) : ok()));
    }
}
export function setupDescription(component: Component) {
    return `${component.id} ${component.version}: ${component.purpose}\nDownload: ${component.archives.reduce((size, archive) => size + archive.size, 0)} bytes\nLicence: ${component.license}\n${component.archives.map(archive => `${archive.url}\nSHA-256: ${archive.sha256}`).join("\n")}`;
}
function selectedComponents(manifest: Component[], selectors: string[]) {
    for (const selector of selectors)
        if (!["pdf", "html", ...manifest.map(component => component.id)].includes(selector))
            throw new Error(`Unknown setup component or check: ${selector}`);
    const selected = new Set<ComponentId>();
    for (const component of manifest)
        if (!selectors.length || selectors.includes(component.id) || component.checks.some(check => selectors.includes(check)))
            selected.add(component.id);
    // veraPDF's headless installer needs Java. System or explicit Java is reused below.
    if (selected.has("verapdf"))
        selected.add("java");
    return manifest.filter(component => selected.has(component.id)).sort((a, b) => Number(b.id === "java") - Number(a.id === "java"));
}
const xmlEscape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
async function installVeraPdf(host: SetupHost, work: string, payload: string, component: Component) {
    const java = await resolveComponent(host, "java", undefined, { javaPurpose: "installer" });
    if (!java.usable)
        throw new Error(java.reason);
    const config = join(work, "auto-install.xml");
    await host.fs.writeFile(config, `<?xml version="1.0" encoding="UTF-8"?>
<AutomatedInstallation langpack="eng">
<com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
<com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>${xmlEscape(join(payload, "payload"))}</installpath></com.izforge.izpack.panels.target.TargetPanel>
<com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
<pack index="0" name="veraPDF GUI" selected="false"/>
<pack index="1" name="veraPDF CLI" selected="true"/>
<pack index="2" name="veraPDF Documentation" selected="false"/>
<pack index="3" name="veraPDF Sample Plugins" selected="false"/>
</com.izforge.izpack.panels.packs.PacksPanel>
<com.izforge.izpack.panels.install.InstallPanel id="install"/>
<com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>\n`);
    const installer = join(work, runtimePins.veraPDF.directory, `verapdf-izpack-installer-${component.version}.jar`);
    const env = javaEnvironment(host.env, host.platform as NodeJS.Platform);
    const result = await host.run(java.path!, ["-Djava.awt.headless=true", "-jar", installer, config], env);
    if (result.code !== 0 || !result.stdout.includes("Automated installation done"))
        throw new Error(`veraPDF headless install failed: ${result.stderr || result.stdout}`);
    const version = await host.run(java.path!, veraPdfJavaArgs(join(payload, "payload", "bin", "*"), ["--version"]), env);
    if (version.code !== 0 || version.stdout.trim().split(/\r?\n/)[0] !== `veraPDF ${component.version}`)
        throw new Error("veraPDF installed version does not match the pin");
}
export async function setup(options: SetupOptions, host: SetupHost) {
    const manifest = await host.manifest(host), selected = selectedComponents(manifest, options.selectors ?? []);
    if (options.list) {
        selected.forEach(component => host.print(setupDescription(component)));
        return { installed: [], refused: [], reused: [], exitCode: 0 };
    }
    if (selected.some(component => component.id === "java")) {
        const java = await resolveComponent(host, "java", undefined, { javaPurpose: "installer" });
        if (java.source === "explicit" && !java.usable)
            throw new Error(java.reason);
    }
    const result: {
        installed: ComponentId[];
        refused: ComponentId[];
        reused: ComponentId[];
    } = { installed: [], refused: [], reused: [] };
    for (const component of selected) {
        host.print(setupDescription(component));
        const destination = componentDirectory(host, component);
        if (await checkInventory(destination, component, host) === "intact") {
            const installed = await resolveComponent(host, component.id, undefined, component.id === "java" ? { javaPurpose: "installer" } : {});
            if (!installed.usable)
                throw new Error(installed.reason);
            host.print(`${component.id}: already installed`);
            result.reused.push(component.id);
            continue;
        }
        if (component.id === "java") {
            const java = await resolveComponent(host, "java", undefined, { javaPurpose: "installer" });
            if (java.usable) {
                host.print(`java: using ${java.source} ${java.version ?? "unknown version"} at ${java.path}`);
                result.reused.push(component.id);
                continue;
            }
        }
        if (!options.yes && !await host.confirm(component)) {
            host.print(`${component.id}: declined; dependent checks will report not run`);
            result.refused.push(component.id);
            continue;
        }
        if (component.id === "verapdf" && !(await resolveComponent(host, "java", undefined, { javaPurpose: "installer" })).usable) {
            host.print("verapdf: Java is unavailable; run check setup pdf");
            result.refused.push(component.id);
            continue;
        }
        await host.fs.mkdir(componentsDirectory(host), { recursive: true });
        const staging = await host.fs.mkdtemp(join(componentsDirectory(host), ".install-"));
        const payload = join(staging, "component"), work = join(staging, "work");
        await host.fs.mkdir(payload);
        await host.fs.mkdir(work);
        try {
            const archives = new Map<string, Buffer>();
            for (const archive of component.archives) {
                const name = basename(new URL(archive.url).pathname), path = options.from ? join(resolve(options.from), name) : join(work, name);
                const bytes = await downloadVerified(archive, path, host, { offline: !!options.from });
                const verified = { name, bytes };
                if (component.id === "browser") {
                    await extractComponentArchive(verified, join(work, "validate"), host.fs, true);
                    archives.set(name, bytes);
                }
                else
                    await extractComponentArchive(verified, component.id === "java" ? payload : work, host.fs);
            }
            if (component.id === "browser")
                await host.installBrowser(payload, archives);
            if (component.id === "verapdf")
                await installVeraPdf(host, work, payload, component);
            if (component.id === "java") {
                const version = await host.run(join(payload, component.entryPoint), ["--version"], javaEnvironment(host.env, host.platform as NodeJS.Platform));
                if (version.code !== 0 || !(version.stdout + version.stderr).includes(`Temurin-${component.version}`))
                    throw new Error("Java installed version does not match the pin");
            }
            await writeInventory(payload, component, host);
            await host.fs.mkdir(dirname(destination), { recursive: true });
            // Never replace an existing version silently. Preserve damaged installations for inspection.
            try {
                await host.fs.lstat(destination);
                throw new Error(`${component.id} version folder already exists but is not intact; move it aside and run check setup ${component.id}`);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
            await host.fs.rename(payload, destination);
            result.installed.push(component.id);
            host.print(`${component.id}: installed in ${destination}`);
        }
        finally {
            await host.fs.rm(staging, { recursive: true, force: true });
        }
    }
    // Verify the runtime selections after publishing. Explicit overrides can still win.
    const resolutions = await Promise.all(selected.map(component => resolveComponent(host, component.id)));
    const unusable = resolutions.filter(component => !component.usable);
    unusable.forEach(component => host.print(component.reason!));
    return { ...result, exitCode: unusable.length ? 1 : 0 };
}
export async function setupCli(args: string[], host: SetupHost): Promise<number> {
    const options: SetupOptions = { selectors: [] };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (arg === "--yes")
            options.yes = true;
        else if (arg === "--list")
            options.list = true;
        else if (arg === "--from" && args[index + 1] && !args[index + 1]!.startsWith("-"))
            options.from = args[++index];
        else if (arg.startsWith("-"))
            throw new Error(`Unknown or incomplete setup option: ${arg}`);
        else
            options.selectors!.push(arg);
    }
    return (await setup(options, host)).exitCode;
}
