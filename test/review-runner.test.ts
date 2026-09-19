import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { classifyReview, parseReviewExecutionOption, runPreparedReview, validateReviewExecutionOptions, type ReviewExecutionOptions } from "../src/review-runner.ts";

const cli = resolve("src/cli.ts");
const input = { kind: "html" as const, sourceSha256: "a".repeat(64), items: [{ id: "candidate", text: '<button aria-expanded="false">Details</button>' }] };
const response = { model: "jev-1.13.0", answers: { classification: { choice: "disclosure", confidence: 0.2 } }, usage: { input_tokens: 12 } };

test("Jev classifies bounded evidence without suppressing unknown or low-confidence items and rejects malformed responses", async () => {
	const requests: unknown[] = [];
	const fetcher: typeof fetch = async (_url, options) => {
		requests.push(JSON.parse(String(options?.body)));
		return Response.json(response);
	};
	const result = await classifyReview(input, "synthetic-key", fetcher);
	assert.equal(result.records.length, 1);
	assert.equal(result.records[0]?.confidence, 0.2);
	assert.equal(result.records[0]?.choice, "disclosure");
	assert.deepEqual(result.records[0]?.response, response);
	assert.deepEqual(result.records[0]?.request, requests[0]);
	assert.equal(JSON.stringify(requests).includes("synthetic-key"), false);
	const pdf = await classifyReview({ ...input, kind: "pdf", items: [{ id: "1", text: "", truncated: true }] }, "key", async () => Response.json({ ...response, answers: { classification: { choice: "unknown", confidence: 0.9 } } }));
	assert.equal(pdf.records[0]?.choice, "unknown");
	assert.equal(pdf.records[0]?.route, "deterministic-referral");
	assert.equal(pdf.records[0]?.confidence, undefined);
	const gated = await classifyReview({ ...input, items: [{ id: "empty", text: " " }, { id: "html-cut", text: "<p>… [truncated]" }, { id: "pdf-cut", text: "Retained words", truncated: true }] }, "key", async () => { throw new Error("Gated evidence must not call Jev"); });
	assert.equal(gated.records.length, 3);
	assert.ok(gated.records.every(record => record.choice === "unknown" && record.confidence === undefined));
	const retained: object[] = [];
	let calls = 0;
	await assert.rejects(classifyReview({ ...input, items: [...input.items, { id: "failed", text: "Later component" }] }, "key", async () => ++calls === 1 ? Response.json(response) : new Response("service failed", { status: 503 }), async record => { retained.push(record); }), /HTTP 503/);
	assert.equal(retained.length, 2);
	assert.match(JSON.stringify(retained[0]), /"confidence":0.2/);
	assert.match(JSON.stringify(retained[1]), /"rawResponse":"service failed"/);
	for (const invalid of [null, { ...response, model: "other-model" }, { ...response, answers: {} }, ...[-1, 2, null, "0.9"].map(confidence => ({ ...response, answers: { classification: { choice: "disclosure", confidence } } })), { ...response, answers: { classification: { choice: "passed", confidence: 1 } } }]) {
		await assert.rejects(classifyReview(input, "key", async () => Response.json(invalid)), /Invalid Jev/);
	}
	await assert.rejects(classifyReview(input, "key", async () => new Response("unavailable", { status: 503 })), /HTTP 503/);
});

test("review options reject unsupported values and ignored model selection", () => {
	const options: ReviewExecutionOptions = {};
	assert.equal(parseReviewExecutionOption(options, "--unrelated", "x"), false);
	for (const [flag, value] of [["--classifier", "maybe"], ["--reviewer", "jev"], ["--model", "--flag"], ["--model", "bad model"], ["--reviewer", ""]]) assert.throws(() => parseReviewExecutionOption(options, flag!, value));
	assert.equal(parseReviewExecutionOption(options, "--model", "preferred-model"), true);
	assert.throws(() => validateReviewExecutionOptions(options, true), /requires --reviewer codex/);
	assert.throws(() => validateReviewExecutionOptions({ reviewer: "codex" }, false), /require --output/);
});

test("failed classifier retains completed requests and raw service errors without saving a review", async t => {
	const directory = await mkdtemp(join(tmpdir(), "check-classifier-failure-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "manifest.json"), JSON.stringify({ evidenceSha256: input.sourceSha256 }));
	await writeFile(join(directory, "review-prompt.md"), "Review original evidence.");
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? Response.json(response) : new Response("service failed", { status: 503 }));
	await assert.rejects(runPreparedReview(directory, { classifier: "jev" }, { ...input, items: [...input.items, { id: "failed", text: "Later component" }] }, async () => { throw new Error("Manual reviewer must not run"); }), /HTTP 503/);
	const attempts = (await readFile(join(directory, "classifier-attempts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.equal(attempts.length, 2);
	assert.equal(attempts[0].confidence, 0.2);
	assert.equal(attempts[1].rawResponse, "service failed");
	for (const name of ["review.json", "classifier.json"]) await assert.rejects(stat(join(directory, name)), { code: "ENOENT" });
});

function pdf() {
	const text = "BT /F1 16 Tf 20 100 Td (Read the instructions) Tj ET";
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
	let bytes = "%PDF-1.4\n";
	const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(bytes); bytes += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
	const xref = Buffer.byteLength(bytes);
	return bytes + `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("CLI runs an authenticated reviewer command for HTML and PDF, validates bindings, preserves failed raw output and attaches PDF images", async t => {
	const dir = await mkdtemp(join(tmpdir(), "check-review-runner-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const bin = join(dir, "bin"), source = join(dir, "source"), document = join(dir, "document.pdf");
	await mkdir(bin); await mkdir(source);
	await writeFile(join(source, "index.html"), '<!doctype html><html lang="en"><title>Review fixture</title><h1>Details</h1><details><summary>Details</summary><p>More information</p></details></html>');
	await writeFile(document, pdf());
	const executable = join(bin, "codex");
	await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
 const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
 const schema = JSON.parse(fs.readFileSync('review.schema.json', 'utf8'));
 const html = manifest.schemaVersion.startsWith('html');
 const model = args[args.indexOf('-m') + 1];
 const evidence = html ? JSON.parse(fs.readFileSync('evidence.json', 'utf8')) : null;
 const review = html ? { schemaVersion: 'html-review-2', contentSha256: manifest.contentSha256, evidenceSha256: manifest.evidenceSha256, tier: 'inference', checks: ['accessibility'], pagesReviewed: evidence.pages.filter(page => page.audited).map(page => page.file), candidatesReviewed: evidence.candidates.map(candidate => candidate.id), reviewer: { model }, findings: [] } : { schemaVersion: 'pdf-review-4', documentSha256: manifest.documentSha256, bundleSha256: schema.properties.bundleSha256.const, tier: 'inference', focus: manifest.focus, checks: manifest.checks, pagesReviewed: manifest.selectedPages, reviewer: { model }, findings: [] };
 if (process.env.MOCK_BAD_REVIEW) review[html ? 'evidenceSha256' : 'bundleSha256'] = '0'.repeat(64);
 if (process.env.MOCK_LEGACY_REVIEW) { review.schemaVersion = 'pdf-review-3'; delete review.bundleSha256; }
 if (process.env.MOCK_WRONG_MODEL) review.reviewer.model = 'GPT-5';
 fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(review));
 console.log(JSON.stringify({ args, prompt, jevKey: process.env.JEV_API_KEY ?? null }));
});
`);
	await chmod(executable, 0o700);
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, JEV_API_KEY: "do-not-forward-to-reviewer" };
	const run = (target: string, bundle: string, extra: string[] = [], environment = env) => spawnSync(process.execPath, [cli, "prepare-review", target, "--tier", "inference", "--output", bundle, "--reviewer", "codex", ...extra], { encoding: "utf8", env: environment });
	const legacy = spawnSync(process.execPath, [cli, "prepare-review", document, "--tier", "visual", "--reviewer", "codex"], { encoding: "utf8", env });
	assert.equal(legacy.status, 2);
	assert.match(legacy.stderr, /--tier inference --focus visual/);
	for (const [kind, target] of [["html", source], ["pdf", document]]) {
		const bundle = join(dir, kind!);
		const result = run(target!, bundle, ["--model", "preferred-model"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(await readFile(join(bundle, "review.json"), "utf8")).reviewer.model, "preferred-model");
		const log = JSON.parse(await readFile(join(bundle, "reviewer.log"), "utf8"));
		assert.equal(log.args.includes("read-only"), true);
		assert.equal(log.args.includes("--ephemeral"), true);
		assert.equal(log.args.some((arg: string) => arg.startsWith("model_reasoning_effort=")), false);
		assert.equal(log.jevKey, null);
		assert.match(log.prompt, /untrusted source material/);
		assert.match(log.prompt, /set reviewer.model to exactly "preferred-model"/);
		if (kind === "pdf") assert.ok(log.args.includes(join(bundle, "page-1.png")), "rendered page is explicitly attached");
		assert.equal((await stat(join(bundle, "review.json"))).mode & 0o777, 0o600);
		const failed = join(dir, `${kind}-failed`);
		const invalid = run(target!, failed, [], { ...env, MOCK_BAD_REVIEW: "1" });
		assert.equal(invalid.status, 2, invalid.stderr);
		await assert.rejects(stat(join(failed, "review.json")), { code: "ENOENT" });
		assert.ok((await stat(join(failed, "review-response.txt"))).size > 0);
		const failedLog = JSON.parse(await readFile(join(failed, "reviewer.log"), "utf8"));
		assert.ok(failedLog.args.includes('model_reasoning_effort="max"'));
		const wrongModel = join(dir, `${kind}-wrong-model`);
		const misattributed = run(target!, wrongModel, ["--model", "preferred-model"], { ...env, MOCK_WRONG_MODEL: "1" });
		assert.equal(misattributed.status, 2, misattributed.stderr);
		assert.match(misattributed.stderr, /attribution does not match selected model preferred-model/);
		await assert.rejects(stat(join(wrongModel, "review.json")), { code: "ENOENT" });
		assert.equal(JSON.parse(await readFile(join(wrongModel, "review-response.txt"), "utf8")).reviewer.model, "GPT-5");
		if (kind === "pdf") {
			const downgraded = join(dir, "pdf-downgraded");
			const oldSchema = run(target!, downgraded, [], { ...env, MOCK_LEGACY_REVIEW: "1" });
			assert.equal(oldSchema.status, 2, oldSchema.stderr);
			assert.match(oldSchema.stderr, /requires pdf-review-4/);
			await assert.rejects(stat(join(downgraded, "review.json")), { code: "ENOENT" });
		}
	}
});
