import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const runtime = resolve(process.argv[2] ?? (() => { throw new Error("Required: <relocated Poppler runtime>"); })());
const work = await mkdtemp(join(tmpdir(), "check-cmap-"));
await mkdir(join(work, "empty"));
// No ToUnicode or embedded font: this requires packaged Adobe CMaps and OS font substitution.
const content = "BT /F1 24 Tf 30 70 Td <65E5672C8A9E> Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
  "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [5 0 R] >>",
  "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 6 0 R /DW 1000 >>",
  "<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [-123 -257 1001 910] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const input = join(work, "japanese-cmap.pdf");
await writeFile(input, pdf);
const profile = join(work, "no-homebrew.sb");
await writeFile(profile, '(version 1)\n(allow default)\n(deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local/Cellar"))\n');
const env = { HOME: work, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", XDG_CACHE_HOME: join(work, ".cache"), POPPLER_DATADIR: join(runtime, "share/poppler"), FONTCONFIG_FILE: join(runtime, "etc/fonts/fonts.conf"), FONTCONFIG_PATH: join(runtime, "etc/fonts") };
const run = (tool, args, override = {}) => spawnSync("/usr/bin/sandbox-exec", ["-f", profile, join(runtime, "bin", tool), ...args], { env: { ...env, ...override }, encoding: "utf8" });
const missing = run("pdftotext", [input, "-"], { POPPLER_DATADIR: join(work, "empty") });
assert.notEqual(missing.stdout?.replace(/\s/g, ""), "日本語", "Fixture must depend on external CMaps");
const extracted = run("pdftotext", [input, "-"]);
assert.equal(extracted.status, 0, extracted.stderr);
assert.equal(extracted.stdout.replace(/\s/g, ""), "日本語", extracted.stderr);
assert.equal(extracted.stderr, "");
const substituted = run("pdffonts", ["-subst", input]);
assert.equal(substituted.status, 0, substituted.stderr);
assert.equal(substituted.stderr, "");
assert.match(substituted.stdout, /\/(?:System\/Library|Library)\/Fonts\//, "CID font substitution must resolve to an OS font");
const rendered = run("pdftoppm", ["-r", "36", "-singlefile", input, join(work, "japanese")]);
assert.equal(rendered.status, 0, rendered.stderr);
assert.equal(rendered.stderr, "");
const ppm = await readFile(join(work, "japanese.ppm"));
const header = ppm.toString("ascii", 0, 100).match(/^P6\s+\d+\s+\d+\s+255\s/);
assert.ok(header, "Expected rendered RGB PPM");
assert.ok(ppm.subarray(header[0].length).some(byte => byte < 128), "Rendered Japanese page must contain ink");
console.log(JSON.stringify({ success: true, text: extracted.stdout.trim(), homebrewDenied: true, missingDataFails: true, fontSubstitution: substituted.stdout.trim(), evidence: work }, null, 2));
