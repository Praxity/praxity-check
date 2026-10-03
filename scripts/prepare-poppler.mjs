import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { prepareHomebrewRuntime } from "./prepare-homebrew-libraries.mjs";
export { prepareHomebrewRuntime };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options: Object.fromEntries(["output", "prefix", "supplemental-notices", "source-install"].map(name => [name, { type: "string" }])) });
	if (!values.output) throw new Error("Required: --output <new directory>; optional --prefix <Homebrew prefix> --supplemental-notices <package notice directories>");
	const sourceInstall = values["source-install"] && resolve(values["source-install"]);
	if (sourceInstall) {
		for (const directory of ["cMap", "cidToUnicode", "nameToUnicode", "unicodeMap"]) await readdir(join(sourceInstall, "share/poppler", directory));
		await readFile(join(sourceInstall, "etc/fonts/fonts.conf"));
	}
	await prepareHomebrewRuntime({ output: values.output, prefix: values.prefix, executables: true, supplementalNotices: values["supplemental-notices"], sourceRoots: values["source-install"] ? [values["source-install"]] : [], roots: values["source-install"] ? ["pdfinfo", "pdffonts", "pdfimages", "pdftotext", "pdftoppm", "pdftohtml"].map(tool => join(values["source-install"], "bin", tool)) : undefined });
	if (sourceInstall) {
		await cp(join(sourceInstall, "share/poppler"), join(values.output, "share/poppler"), { recursive: true });
		await cp(join(sourceInstall, "etc/fonts"), join(values.output, "etc/fonts"), { recursive: true });
		const notice = join(values.output, "NOTICE.md");
		await writeFile(notice, (await readFile(notice, "utf8")) + `\n## Poppler data and system fonts\n\nThis source-build artifact includes Poppler encoding data in share/poppler and fontconfig configuration in etc/fonts/fonts.conf. Set POPPLER_DATADIR to the bundled share/poppler and FONTCONFIG_FILE to the bundled etc/fonts/fonts.conf; the Check launcher sets these paths. Font substitution uses macOS /System/Library/Fonts and /Library/Fonts; no Apple font files are copied. Font caches use the XDG cache directory. The Poppler source archive, environment override patch, build recipe, source hashes, data archive and data licenses are retained under notices/source-${basename(sourceInstall)}/source/poppler/. These retained Poppler sources do not fulfill the separate source obligations of every bundled dependency.\n`);
	}
	console.log(resolve(values.output));
}
