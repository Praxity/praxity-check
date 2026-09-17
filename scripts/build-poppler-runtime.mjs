import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// Build inputs stay outside the repository; dependencies are relocated by prepare-poppler.
const { values } = parseArgs({ options: Object.fromEntries(["work", "cmake", "prefix"].map(name => [name, { type: "string" }])) });
if (!values.work) throw new Error("Required: --work <external build directory>; optional --cmake <executable> --prefix <Homebrew prefix>");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Requires macOS arm64");
const work = resolve(values.work);
const prefix = resolve(values.prefix ?? "/opt/homebrew");
const cmake = values.cmake ?? "cmake";
const version = "26.03.0";
const url = `https://poppler.freedesktop.org/poppler-${version}.tar.xz`;
const sha256 = "8b3c5e2a9f2ab4c3ec5029f28af1b433c6b71f0d1e7b3997aa561cf1c0ca4ebe";
const archive = join(work, `poppler-${version}.tar.xz`);
const source = join(work, `poppler-${version}`);
const build = join(work, "poppler-build");
const output = join(work, "poppler-install");
const run = (tool, args) => execFileSync(tool, args, { stdio: "inherit" });
await mkdir(work, { recursive: true });
try { await readFile(archive); } catch (error) {
  if (error.code !== "ENOENT") throw error;
  run("/usr/bin/curl", ["-fL", url, "-o", archive]);
}
if (createHash("sha256").update(await readFile(archive)).digest("hex") !== sha256) throw new Error("Poppler source hash mismatch");
run("/usr/bin/tar", ["-xf", archive, "-C", work]);
const file = join(source, "poppler/GlobalParams.cc");
const original = await readFile(file, "utf8");
const marker = "    // scan the encoding in reverse";
if (!original.includes(marker)) throw new Error("Poppler patch context changed");
await writeFile(file, original.replace("#include <cstring>", "#include <cstring>\n#include <cstdlib>").replace(marker,
  '    if (popplerDataDir.empty()) {\n        if (const char *dataDir = std::getenv("POPPLER_DATADIR")) {\n            popplerDataDir = dataDir;\n        }\n    }\n' + marker));
const flags = ["-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_INSTALL_PREFIX=${output}`, `-DCMAKE_PREFIX_PATH=${prefix}`, "-DPOPPLER_DATADIR=/nonexistent/praxity-poppler-data",
  ...["ENABLE_CPP", "ENABLE_GLIB", "ENABLE_QT5", "ENABLE_QT6", "ENABLE_BOOST", "ENABLE_NSS3", "ENABLE_GPGME", "ENABLE_LIBCURL", "BUILD_GTK_TESTS", "BUILD_QT5_TESTS", "BUILD_QT6_TESTS", "BUILD_CPP_TESTS", "BUILD_MANUAL_TESTS"].map(name => `-D${name}=OFF`)];
run(cmake, ["-S", source, "-B", build, ...flags]);
const tools = ["pdfinfo", "pdffonts", "pdfimages", "pdftotext", "pdftoppm", "pdftohtml"];
run(cmake, ["--build", build, "--target", ...tools, "--parallel", "8"]);
for (const directory of ["bin", "lib", "share", "etc/fonts", "notices/poppler"]) await mkdir(join(output, directory), { recursive: true });
for (const tool of tools) await copyFile(join(build, "utils", tool), join(output, "bin", tool));
// The build's install name points to this real library; preserve its versioned filename.
for (const entry of await readdir(build, { withFileTypes: true })) if (entry.isFile() && /^libpoppler.*\.dylib$/.test(entry.name)) await copyFile(join(build, entry.name), join(output, "lib", entry.name));
const library = join(output, "lib/libpoppler.158.0.0.dylib");
for (const tool of tools) run("/usr/bin/install_name_tool", ["-change", "@rpath/libpoppler.158.dylib", library, join(output, "bin", tool)]);
run("/usr/bin/install_name_tool", ["-id", library, library]);
const dataUrl = "https://poppler.freedesktop.org/poppler-data-0.4.12.tar.gz";
const dataSha256 = "c835b640a40ce357e1b83666aabd95edffa24ddddd49b8daff63adb851cdab74";
const dataArchive = join(work, "poppler-data-0.4.12.tar.gz");
try { await readFile(dataArchive); } catch (error) {
  if (error.code !== "ENOENT") throw error;
  run("/usr/bin/curl", ["-fL", dataUrl, "-o", dataArchive]);
}
if (createHash("sha256").update(await readFile(dataArchive)).digest("hex") !== dataSha256) throw new Error("Poppler data hash mismatch");
run("/usr/bin/tar", ["-xf", dataArchive, "-C", work]);
for (const dir of ["cMap", "cidToUnicode", "nameToUnicode", "unicodeMap"]) await cp(join(work, "poppler-data-0.4.12", dir), join(output, "share/poppler", dir), { recursive: true });
await writeFile(join(output, "etc/fonts/fonts.conf"), '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n  <dir>/System/Library/Fonts</dir>\n  <dir>/Library/Fonts</dir>\n  <cachedir prefix="xdg">fontconfig</cachedir>\n</fontconfig>\n');
const notices = join(output, "notices/poppler");
for (const name of ["COPYING", "AUTHORS"]) await copyFile(join(source, name), join(notices, name));
await copyFile(archive, join(notices, `poppler-${version}.tar.xz`));
await copyFile(new URL(import.meta.url), join(notices, "build-poppler-runtime.mjs"));
await copyFile(dataArchive, join(notices, "poppler-data-0.4.12.tar.gz"));
for (const entry of await readdir(join(work, "poppler-data-0.4.12"))) if (/^(COPYING|LICENSE)/.test(entry)) await copyFile(join(work, "poppler-data-0.4.12", entry), join(notices, `data-${entry}`));
await writeFile(join(notices, "GlobalParams.cc.original"), original);
await copyFile(file, join(notices, "GlobalParams.cc.modified"));
const diff = spawnSync("/usr/bin/diff", ["-u", "--label", "a/poppler/GlobalParams.cc", "--label", "b/poppler/GlobalParams.cc", join(notices, "GlobalParams.cc.original"), file], { encoding: "utf8" });
if (diff.status !== 1) throw new Error(`Expected source patch: ${diff.stderr}`);
await writeFile(join(notices, "poppler-data-env.patch"), diff.stdout);
await writeFile(join(notices, "provenance.json"), JSON.stringify({ version, url, sha256, flags, tools, modification: "GlobalParams uses POPPLER_DATADIR environment when no explicit data directory was supplied. GPL-2.0-or-later, same terms as GlobalParams.cc.", dataUrl, dataSha256 }, null, 2) + "\n");
console.log(output);
