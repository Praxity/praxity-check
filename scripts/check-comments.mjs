#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const USAGE = `Usage: node scripts/check-comments.mjs [--update | --list [path-prefix] | --same-code <git-ref>]
  (no flag)            fail if a file has more comments than comment-baseline.json allows, or fewer (stale baseline)
  --update             lower the baseline to current counts; never raises an entry; creates the file if missing
  --list [prefix]      print every counted comment as file:line followed by its text
  --same-code <ref>    fail if a changed code file differs from <ref> in anything but counted comments and whitespace`;

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const baselinePath = path.join(root, "comment-baseline.json");
const ts = loadCompilerApi();

function loadCompilerApi() {
	const req = createRequire(path.join(root, "package.json"));
	for (const name of ["typescript-api", "typescript"]) {
		try {
			const mod = req(name);
			if (typeof mod.createSourceFile === "function") return mod;
		} catch {}
	}
	console.error('check-comments needs the TypeScript compiler API. TypeScript 7 has none: add the devDependency "typescript-api": "npm:typescript@6.0.3".');
	process.exit(1);
}

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|astro|css|py|sh)$/;
const ALWAYS_SKIPPED = /(^|\/)(node_modules|dist|vendor)\/|\.min\.(js|css)$|\.d\.(m|c)?ts$/;
const PRAGMA = new RegExp(
	[
		String.raw`^\/\/\/\s*<reference`,
		String.raw`^\/[/*]\s*(@ts-|biome-ignore|eslint|prettier-ignore|istanbul |c8 |v8 ignore|@vitest-environment|@jest-environment|@vite-ignore|webpack|@jsx|@refresh|stylelint-|#\s*source(Mapping)?URL=)`,
		String.raw`^\/\*\s*[#@]__(PURE|NO_SIDE_EFFECTS)__`,
		String.raw`^\/\*!`,
		String.raw`@license|@preserve|SPDX-License-Identifier`,
		String.raw`^#!`,
		String.raw`^#\s*(type:|noqa|pragma|pyright:|-\*-|shellcheck )`,
		String.raw`^<!--\s*(prettier-ignore|biome-ignore)`,
	].join("|"),
);

const isTagOnlyDoc = (text) =>
	text.startsWith("/**") &&
	text
		.slice(3, -2)
		.split("\n")
		.map((l) => l.replace(/^\s*\*?\s?/, "").trim())
		.filter(Boolean)
		.every((l) => l.startsWith("@"));

const isPragma = (text) => PRAGMA.test(text) || isTagOnlyDoc(text);

function jsRanges(text, file) {
	const kind = /\.[mc]?jsx?$/.test(file) ? ts.ScriptKind.JSX : file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	const seen = new Map();
	const add = (ranges) => ranges?.forEach((r) => seen.set(r.pos, [r.pos, r.end]));
	const visit = (node) => {
		add(ts.getLeadingCommentRanges(text, node.pos));
		add(ts.getTrailingCommentRanges(text, node.end));
		for (const child of node.getChildren(sf)) visit(child);
	};
	visit(sf);
	return [...seen.values()];
}

function hashRanges(text, python) {
	const out = [];
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === "\\") i++;
			else if (text.startsWith(quote, i)) {
				i += quote.length - 1;
				quote = null;
			} else if (c === "\n" && quote.length === 1) quote = null;
		} else if (python && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
			quote = text.slice(i, i + 3);
			i += 2;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "#" && (i === 0 || /\s/.test(text[i - 1])) && !(!python && text[i - 1] === "$")) {
			const end = text.indexOf("\n", i);
			out.push([i, end === -1 ? text.length : end]);
			i = end === -1 ? text.length : end;
		}
	}
	return out;
}

const regexRanges = (text, re, offset = 0) => [...text.matchAll(re)].map((m) => [m.index + offset, m.index + offset + m[0].length]);
const shift = (ranges, offset) => ranges.map(([a, b]) => [a + offset, b + offset]);

function astroRanges(text, file) {
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const bodyStart = fm ? fm[0].length : 0;
	const out = fm ? shift(jsRanges(fm[1], `${file}.ts`), text.indexOf(fm[1])) : [];
	const body = text.slice(bodyStart);
	out.push(...regexRanges(body, /<!--[\s\S]*?-->/g, bodyStart));
	out.push(...regexRanges(body, /\{\s*\/\*[\s\S]*?\*\/\s*\}/g, bodyStart));
	for (const m of body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
		out.push(...shift(jsRanges(m[1], `${file}.ts`), bodyStart + m.index + m[0].indexOf(m[1])));
	}
	for (const m of body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
		out.push(...regexRanges(m[1], /\/\*[\s\S]*?\*\//g, bodyStart + m.index + m[0].indexOf(m[1])));
	}
	return out;
}

function commentRanges(text, file) {
	if (file.endsWith(".py")) return hashRanges(text, true);
	if (file.endsWith(".sh")) return hashRanges(text, false);
	if (file.endsWith(".css")) return regexRanges(text, /\/\*[\s\S]*?\*\//g);
	if (file.endsWith(".astro")) return astroRanges(text, file);
	return jsRanges(text, file);
}

const countedRanges = (text, file) =>
	commentRanges(text, file)
		.filter(([a, b]) => !isPragma(text.slice(a, b)))
		.sort((x, y) => x[0] - y[0]);

function readBaseline() {
	if (!existsSync(baselinePath)) return null;
	const b = JSON.parse(readFileSync(baselinePath, "utf8"));
	return { ignore: b.ignore ?? [], files: b.files ?? {} };
}

const isIgnored = (file, ignore) => ignore.some((glob) => path.matchesGlob(file, glob));

function codeFiles(ignore) {
	return execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 })
		.split("\n")
		.filter((f) => CODE.test(f) && !ALWAYS_SKIPPED.test(f) && !isIgnored(f, ignore) && existsSync(path.join(root, f)));
}

function counts(ignore) {
	const result = {};
	for (const file of codeFiles(ignore)) {
		const text = readFileSync(path.join(root, file), "utf8");
		if (!/\/\/|\/\*|#|<!--/.test(text)) continue;
		const n = countedRanges(text, file).length;
		if (n) result[file] = n;
	}
	return result;
}

function writeBaseline(ignore, files) {
	const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(baselinePath, `${JSON.stringify({ ignore, files: sorted }, null, "\t")}\n`);
}

const CLOSERS = new Set([")", "]", "}", ">"]);

function jsTokens(text, file) {
	const kind = /\.[mc]?jsx?$/.test(file) ? ts.ScriptKind.JSX : file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	const tokens = [];
	const visit = (node) => {
		if (node.kind === ts.SyntaxKind.JsxExpression && !node.expression) return;
		if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
		const children = node.getChildren(sf);
		if (children.length) children.forEach(visit);
		else if (node.kind === ts.SyntaxKind.JsxText) tokens.push(node.getText(sf).replace(/\s+/g, " ").trim());
		else if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(node.getText(sf));
	};
	visit(sf);
	const code = tokens.filter((t, i) => t && !(t === "," && CLOSERS.has(tokens[i + 1])));
	const pragmas = commentRanges(text, file).filter(([a, b]) => isPragma(text.slice(a, b))).map(([a, b]) => text.slice(a, b));
	return JSON.stringify([code, pragmas]);
}

const normalizedCode = (text, file) => {
	if (/\.[mc]?[jt]sx?$/.test(file)) return jsTokens(text, file);
	let out = "";
	let at = 0;
	for (const [a, b] of countedRanges(text, file)) {
		out += text.slice(at, a);
		at = b;
	}
	return (out + text.slice(at))
		.replace(/\s+/g, "")
		.replace(/\{\}/g, "")
		.replace(/,(?=[)\]}>])/g, "");
};

function sameCode(ref, ignore) {
	const changed = execFileSync("git", ["-C", root, "diff", "--name-only", "--diff-filter=M", ref, "--"], { encoding: "utf8" })
		.split("\n")
		.filter((f) => CODE.test(f) && !ALWAYS_SKIPPED.test(f) && !isIgnored(f, ignore));
	const differing = changed.filter((file) => {
		const before = execFileSync("git", ["-C", root, "show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 1 << 28 });
		const after = readFileSync(path.join(root, file), "utf8");
		return normalizedCode(before, file) !== normalizedCode(after, file);
	});
	for (const file of differing) console.error(`code changed beyond comments: ${file}`);
	console.log(`${changed.length} changed code files compared with ${ref}; ${differing.length} differ in code`);
	return differing.length === 0;
}

function list(prefix = "") {
	const { ignore } = readBaseline() ?? { ignore: [] };
	for (const file of codeFiles(ignore).filter((f) => f.startsWith(prefix))) {
		const text = readFileSync(path.join(root, file), "utf8");
		for (const [a, b] of countedRanges(text, file)) {
			const line = text.slice(0, a).split("\n").length;
			console.log(`${file}:${line}\n${text.slice(a, b)}\n`);
		}
	}
}

function check(update) {
	const baseline = readBaseline();
	const current = counts(baseline?.ignore ?? []);
	if (!baseline) {
		writeBaseline([], current);
		console.log(`created comment-baseline.json: ${Object.values(current).reduce((s, n) => s + n, 0)} comments in ${Object.keys(current).length} files`);
		return true;
	}
	const files = new Set([...Object.keys(current), ...Object.keys(baseline.files)]);
	const over = [];
	const stale = [];
	const lowered = {};
	for (const file of files) {
		const now = current[file] ?? 0;
		const allowed = baseline.files[file] ?? 0;
		if (now > allowed) over.push(`${file}: ${now} comments, baseline allows ${allowed}`);
		if (now < allowed) stale.push(`${file}: ${now} comments, baseline still says ${allowed}`);
		const kept = Math.min(now, allowed);
		if (kept) lowered[file] = kept;
	}
	const total = Object.values(current).reduce((s, n) => s + n, 0);
	if (update) {
		writeBaseline(baseline.ignore, lowered);
		console.log(`comment-baseline.json lowered; ${total} comments remain`);
		for (const line of over) console.error(`not raised: ${line}`);
		return over.length === 0;
	}
	for (const line of over) console.error(`new comment: ${line}`);
	for (const line of stale) console.error(`stale baseline: ${line}`);
	if (over.length) console.error("Comments are banned. Delete the new comment; record a design decision in docs/adr/ instead.");
	if (stale.length) console.error("Run `node scripts/check-comments.mjs --update` and commit comment-baseline.json.");
	if (!over.length && !stale.length) console.log(`comment ratchet holds: ${total} comments in ${Object.keys(current).length} files`);
	return over.length === 0 && stale.length === 0;
}

const [flag, arg] = process.argv.slice(2);
let ok;
if (!flag) ok = check(false);
else if (flag === "--update") ok = check(true);
else if (flag === "--list") {
	list(arg);
	ok = true;
} else if (flag === "--same-code" && arg) ok = sameCode(arg, readBaseline()?.ignore ?? []);
else {
	console.error(USAGE);
	ok = false;
}
process.exitCode = ok ? 0 : 1;
