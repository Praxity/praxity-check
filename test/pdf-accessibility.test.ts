import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkPdfAccessibility, parseVeraPdf } from "../src/pdf-accessibility.ts";
import { javaEnvironment } from "../src/verapdf-runtime.ts";
import { componentHost } from "../src/components.ts";

function payload(failed = false) {
	return { report: { buildInformation: { releaseDetails: [{ id: "core", version: "1.30.2" }] },
		jobs: [{ validationResult: [{ profileName: "PDF/UA-1 validation profile", jobEndStatus: "normal", compliant: !failed,
			details: { passedRules: 105, failedRules: Number(failed), passedChecks: 10, failedChecks: Number(failed), ...(failed ? { ruleSummaries: [{ status: "failed", ruleStatus: "FAILED", specification: "ISO 14289-1:2014", clause: "7.1", testNumber: 11, description: "Synthetic structure requirement", failedChecks: 1, checks: [{ status: "failed", context: "root/document[0]/pages[2](42 0 obj PDPage)/content[0]", errorMessage: "Synthetic structure failure" }] }] } : {}) } }] }],
		batchSummary: { totalJobs: 1, failedParsingJobs: 0, failedEncryptedJobs: 0, outOfMemory: 0, veraExceptions: 0, validationSummary: { failedJobCount: 0, totalJobCount: 1, successfulJobCount: 1, compliantPdfaCount: Number(!failed), nonCompliantPdfaCount: Number(failed) } } } };
}

test("validation accepts explicit veraPDF wrappers without a version command", async t => {
	const root = await mkdtemp(join(tmpdir(), "verapdf-wrapper-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const executable = join(root, process.platform === "win32" ? "verapdf-wrapper.exe" : "verapdf-wrapper");
	await writeFile(join(root, "validation.json"), JSON.stringify(payload()));
	if (process.platform === "win32") {
		const source = join(root, "Wrapper.cs");
		await writeFile(source, `using System;
using System.IO;
class Wrapper {
 static int Main(string[] args) {
  if (Array.IndexOf(args, "--version") >= 0) { Console.Error.Write("unsupported option"); return 2; }
  Console.Write(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "validation.json")));
  return 0;
 }
}`);
		const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
		const compiled = spawnSync(compiler, ["/nologo", `/out:${executable}`, source], { encoding: "utf8" });
		assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);
	} else {
		await writeFile(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) process.exit(2);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload()))});\n`, { mode: 0o700 });
	}
	const host = componentHost({ env: { ...process.env, CHECK_COMPONENTS_DIR: join(root, "components"), PATH: root } });
	for (const [platform, arch] of [[process.platform, process.arch], ["win32", "arm64"], ["freebsd", "x64"]]) {
	 host.platform = platform!; host.arch = arch!;
	 for (const explicit of [true, false]) {
		host.env.VERAPDF = explicit ? undefined : executable;
		const result = await checkPdfAccessibility("unused.pdf", { profile: "ua1", ...(explicit ? { executable } : {}) }, host);
		assert.equal(result.machineStatus, "complete");
		assert.equal(result.validator.version, "1.30.2");
		assert.equal(result.validator.machineCompliant, true);
		assert.equal(result.components[0]?.source, "explicit");
		assert.equal(result.components[0]?.version, "1.30.2");
	 }
	}
});

test("machine results preserve failed object context without inventing pages", () => {
	assert.equal(parseVeraPdf(JSON.stringify(payload()), "ua1").machineCompliant, true);
	const data = payload(true);
	const parsed = parseVeraPdf(JSON.stringify(data), "ua1");
	assert.equal(parsed.machineCompliant, false);
	assert.equal(parsed.findings[0]?.rule, "pdfua:ISO 14289-1:2014:7.1:11");
	assert.equal(parsed.findings[0]?.location.page, 3);
	assert.equal((parsed.findings[0]!.evidence as { description: string }).description, "Synthetic structure requirement");
	data.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.checks[0]!.context = "root/objects[42](42 0 obj CosDocument)";
	assert.deepEqual(parseVeraPdf(JSON.stringify(data), "ua1").findings[0]?.location, {});
});

test("reviewed feedback uses the exact rule key and retains the validator evidence", () => {
	const data = payload(true), rule = data.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!;
	rule.clause = "7.3";
	rule.testNumber = 1;
	rule.description = "Synthetic figure requirement";
	rule.checks[0]!.errorMessage = "Original validator error";
	const known = parseVeraPdf(JSON.stringify(data), "ua1").findings[0]!;
	assert.equal(known.message, "A figure has no alternative description or replacement text.");
	assert.match(known.remedy, /Add alternative text to the figure in the source/);
	assert.doesNotMatch(known.remedy, /Synthetic figure requirement/);
	assert.equal((known.evidence as { description: string }).description, rule.description);
	assert.deepEqual((known.evidence as { check: unknown }).check, rule.checks[0]);
	for (const [specification, clause, testNumber] of [["ISO 14289-1:2014", "7.3", 2], ["ISO 14289-1:2014", "99", 1], ["ISO 14289-2:2024", "7.3", 1]] as const) {
		Object.assign(rule, { specification, clause, testNumber });
		const unknown = parseVeraPdf(JSON.stringify(data), "ua1").findings[0]!;
		assert.equal(unknown.message, "Original validator error");
		assert.match(unknown.remedy, /requirement in the evidence/);
		assert.doesNotMatch(unknown.remedy, /figure|decorative|Add text/);
	}
});

test("UA2 accepts its combined Tagged PDF profile but rejects cross-profile results", () => {
	const data = payload();
	for (const profileName of ["PDF/UA-2 validation profile", "PDF/UA-2 + Tagged PDF validation profile"]) {
		data.report.jobs[0]!.validationResult[0]!.profileName = profileName;
		assert.equal(parseVeraPdf(JSON.stringify(data), "ua2").machineCompliant, true);
		assert.throws(() => parseVeraPdf(JSON.stringify(data), "ua1"));
	}
	data.report.jobs[0]!.validationResult[0]!.profileName = "PDF/UA-2 unknown validation profile";
	assert.throws(() => parseVeraPdf(JSON.stringify(data), "ua2"));
});

test("unknown, abnormal, contradictory and missing-rule reports are rejected", () => {
	for (const raw of ["", "{}", "null", "{broken"]) assert.throws(() => parseVeraPdf(raw, "ua1"));
	assert.throws(() => parseVeraPdf(JSON.stringify(payload()), "ua2"));
	const arrayProfile = JSON.stringify(payload()).replace('"profileName":"PDF/UA-1 validation profile"', '"profileName":["PDF/UA-1 validation profile"]');
	assert.throws(() => parseVeraPdf(arrayProfile, "ua1"));
	const changes = [
		(d: ReturnType<typeof payload>) => { d.report.jobs = []; },
		(d: ReturnType<typeof payload>) => { d.report.batchSummary.failedParsingJobs = 1; },
		(d: ReturnType<typeof payload>) => { d.report.jobs[0]!.validationResult[0]!.compliant = true; },
		(d: ReturnType<typeof payload>) => { d.report.jobs[0]!.validationResult[0]!.jobEndStatus = "abnormal"; },
		(d: ReturnType<typeof payload>) => { d.report.jobs[0]!.validationResult[0]!.details.failedChecks = 2; },
		(d: ReturnType<typeof payload>) => { d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.failedChecks = 2; },
		(d: ReturnType<typeof payload>) => { d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.failedChecks = 0; },
		(d: ReturnType<typeof payload>) => { d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.checks.push({ ...d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.checks[0]! }); },
		(d: ReturnType<typeof payload>) => { d.report.jobs[0]!.validationResult[0]!.details.failedRules = 2; },
	];
	for (const mutate of changes) { const data = payload(true); mutate(data); assert.throws(() => parseVeraPdf(JSON.stringify(data), "ua1")); }
});

function cappedPayload() {
	const data = payload(true), details = data.report.jobs[0]!.validationResult[0]!.details;
	details.failedRules = 2;
	details.failedChecks = 5;
	details.ruleSummaries![0]!.failedChecks = 3;
	details.ruleSummaries!.push({ ...details.ruleSummaries![0]!, testNumber: 3, failedChecks: 2, checks: [] });
	return data;
}

test("capped evidence preserves retained findings and rule counts, including empty checks", () => {
	const data = cappedPayload(), parsed = parseVeraPdf(JSON.stringify(data), "ua1");
	assert.equal(parsed.machineCompliant, false);
	assert.equal(parsed.findings.length, 1);
	assert.deepEqual(parsed.coverage, { status: "partial", failedChecks: 5, retainedChecks: 1, omittedChecks: 4, rules: [
		{ rule: "pdfua:ISO 14289-1:2014:7.1:11", failedChecks: 3, retainedChecks: 1, omittedChecks: 2 },
		{ rule: "pdfua:ISO 14289-1:2014:7.1:3", failedChecks: 2, retainedChecks: 0, omittedChecks: 2 },
	] });
	assert.deepEqual(parsed.findings[0], parseVeraPdf(JSON.stringify(payload(true)), "ua1").findings[0]);
	assert.equal(parseVeraPdf(JSON.stringify(payload(true)), "ua1").coverage.status, "complete");
	assert.equal(parseVeraPdf(JSON.stringify(payload()), "ua1").coverage.status, "complete");
	data.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.checks = [];
	const empty = parseVeraPdf(JSON.stringify(data), "ua1");
	assert.deepEqual(empty.findings, []);
	assert.equal(empty.coverage.omittedChecks, 5);
});

test("partial evidence still rejects invalid retained checks and duplicate or missing rules", () => {
	for (const mutate of [
		(d: ReturnType<typeof cappedPayload>) => { d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.checks[0]!.status = "passed"; },
		(d: ReturnType<typeof cappedPayload>) => { d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.checks[0]!.context = ""; },
		(d: ReturnType<typeof cappedPayload>) => { d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![0]!.checks[0]!.errorMessage = ""; },
		(d: ReturnType<typeof cappedPayload>) => { d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries![1]!.testNumber = 11; },
		(d: ReturnType<typeof cappedPayload>) => { d.report.jobs[0]!.validationResult[0]!.details.ruleSummaries!.pop(); },
		(d: ReturnType<typeof cappedPayload>) => { d.report.jobs[0]!.validationResult[0]!.details.failedChecks++; },
	]) {
		const data = cappedPayload(); mutate(data);
		assert.throws(() => parseVeraPdf(JSON.stringify(data), "ua1"));
	}
});

test("CLI retains partial findings and structured coverage with unchecked diagnostics and exit 2", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdf-capped-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const executable = join(dir, process.platform === "win32" ? "verapdf.exe" : "verapdf"), input = join(dir, "synthetic.pdf"), output = join(dir, "report.json");
	const data = cappedPayload();
	if (process.platform === "win32") {
		// execFile cannot run shebang scripts or .cmd files on Windows. Compile a
		// fixture executable with the compiler included in Windows' .NET Framework.
		const fixture = join(dir, "Validator.cs");
		await writeFile(fixture, `using System;
using System.IO;
class Validator {
 static int Main() {
  string directory = AppDomain.CurrentDomain.BaseDirectory;
  Console.Write(File.ReadAllText(Path.Combine(directory, "validation.json")));
  return int.Parse(File.ReadAllText(Path.Combine(directory, "exit-code.txt")));
 }
}`);
		const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
		const compiled = spawnSync(compiler, ["/nologo", `/out:${executable}`, fixture], { encoding: "utf8" });
		assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stdout + compiled.stderr);
	}
	const validatorExit = async (exitCode: number) => {
		if (process.platform === "win32") {
			await writeFile(join(dir, "validation.json"), JSON.stringify(data));
			await writeFile(join(dir, "exit-code.txt"), String(exitCode));
		} else {
			await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(data))}); process.exitCode = ${exitCode};\n`, { mode: 0o700 });
		}
	};
	await validatorExit(1);
	const validation = await checkPdfAccessibility(input, { profile: "ua1", executable });
	assert.equal(validation.machineStatus, "incomplete");
	assert.equal(validation.validator.machineCompliant, false);
	assert.equal(validation.findings.length, 1);
	assert.equal(validation.evaluations[0]?.outcome, "untested");
	// PDF facts are deliberately unavailable; this check isolates validator output propagation.
	await writeFile(input, "%PDF-1.7\nsynthetic placeholder");
	const cli = spawnSync(process.execPath, [resolve("src/cli.ts"), "check", input, "--verapdf", executable, "--json", output], { encoding: "utf8", env: { ...process.env, PATH: dir } });
	assert.equal(cli.status, 2, cli.stderr);
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.equal(report.machineStatus, "incomplete");
	assert.equal(report.findings.length, 1);
	assert.equal(report.findings[0].location.page, 3);
	assert.deepEqual(report.pdfuaValidation.coverage, validation.validator.coverage);
	assert.match(cli.stdout, /Fix: The PDF has no structure tree/);
	assert.match(cli.stdout, /Not checked:/);
	assert.match(cli.stdout, /retained 1 of 5 failed checks; 4 checks have no retained evidence/);
	assert.match(cli.stdout, /Retained 0 of 2 failed checks; 2 checks have no retained evidence or locations/);
	await validatorExit(0);
	const contradictory = await checkPdfAccessibility(input, { profile: "ua1", executable });
	assert.equal(contradictory.machineStatus, "incomplete");
	assert.deepEqual(contradictory.findings, []);
	assert.equal(contradictory.validator.coverage, undefined);
});

test("missing validator is incomplete and retains subprocess evidence", async () => {
	const result = await checkPdfAccessibility("unused.pdf", { profile: "ua1", executable: "/nonexistent/praxity-verapdf" });
	assert.equal(result.machineStatus, "incomplete");
	assert.equal(result.evaluations[0]?.outcome, "untested");
	assert.equal(result.validator.machineCompliant, undefined);
	assert.match(result.evidence[0]!.error!, /ENOENT/);
});

test("Java environment removes injected options case-insensitively on Windows", () => {
	const inherited = { CLASSPATH_PREFIX: "bad", Java_Opts: "bad", java_tool_options: "bad", Jdk_Java_Options: "bad", _java_OPTIONS: "bad", PATH: "retained", CUSTOM: "retained" };
	assert.deepEqual(javaEnvironment(inherited, "win32"), { PATH: "retained", CUSTOM: "retained" });
	assert.equal(inherited.CLASSPATH_PREFIX, "bad");
	assert.equal(javaEnvironment({ JAVA_OPTS: "bad", Java_Opts: "retained" }, "darwin").Java_Opts, "retained");
});

test("Windows bundled Java runs the veraPDF main directly, preserves paths and excludes inherited JVM options", { skip: process.platform !== "win32" }, async t => {
	const root = await mkdtemp(join(tmpdir(), "pdf java "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "runtime ü & 100%"), executable = join(dir, "java.exe"), source = join(dir, "JavaFixture.cs");
	await mkdir(dir);
	await writeFile(join(dir, "validation.json"), JSON.stringify(payload()));
	await writeFile(source, `using System;
using System.IO;
using System.Collections;
class JavaFixture {
 static int Main(string[] args) {
  string directory = AppDomain.CurrentDomain.BaseDirectory;
  File.WriteAllLines(Path.Combine(directory, "args.txt"), args);
  string blocked = "";
  foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
   string key = ((string)entry.Key).ToUpperInvariant();
   if (key == "CLASSPATH_PREFIX" || key == "JAVA_OPTS" || key == "JAVA_TOOL_OPTIONS" || key == "JDK_JAVA_OPTIONS" || key == "_JAVA_OPTIONS") blocked += key + "\\n";
  }
  File.WriteAllText(Path.Combine(directory, "injected.txt"), blocked);
  Console.Write(File.ReadAllText(Path.Combine(directory, "validation.json")));
  return 0;
 }
}`);
	const compiled = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", `/out:${executable}`, source], { encoding: "utf8" });
	assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stdout + compiled.stderr);
	const snapshot = join(dir, "document ü & 100%.pdf"), classpath = join(dir, "verapdf", "bin", "*");
	const env: NodeJS.ProcessEnv = { ...javaEnvironment(process.env, "win32"), VERAPDF_JAVA: executable, VERAPDF_CLASSPATH: classpath,
		CLASSPATH_PREFIX: "poison", Java_Opts: "poison", java_tool_options: "poison", Jdk_Java_Options: "poison", _java_OPTIONS: "poison" };
	delete env.VERAPDF;
	const code = `import { checkPdfAccessibility } from ${JSON.stringify(new URL("../src/pdf-accessibility.ts", import.meta.url).href)}; process.stdout.write(JSON.stringify(await checkPdfAccessibility(${JSON.stringify(snapshot)}, {profile: "ua1"})));`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
	assert.equal(child.status, 0, child.error?.message ?? child.stderr);
	const result = JSON.parse(child.stdout);
	assert.equal(result.machineStatus, "complete");
	assert.equal(result.validator.machineCompliant, true);
	assert.equal(result.evidence[0].tool, executable);
	const expected = ["-Dfile.encoding=UTF8", "--add-exports=java.base/sun.security.pkcs=ALL-UNNAMED", "-classpath", classpath,
		"org.verapdf.apps.GreenfieldCliWrapper", "--flavour", "ua1", "--format", "json", "--maxfailuresdisplayed", "-1", snapshot];
	assert.deepEqual(result.evidence[0].args, expected);
	assert.deepEqual((await readFile(join(dir, "args.txt"), "utf8")).trim().split(/\r?\n/), expected);
	assert.equal(await readFile(join(dir, "injected.txt"), "utf8"), "");
	const explicitExecutable = join(dir, "external-verapdf.exe");
	await copyFile(executable, explicitExecutable);
	const validationArgs = ["--flavour", "ua1", "--format", "json", "--maxfailuresdisplayed", "-1", snapshot];
	for (const scenario of [
		{ selected: executable, explicit: undefined, tool: executable, args: expected },
		{ selected: explicitExecutable, explicit: undefined, tool: explicitExecutable, args: validationArgs },
		{ selected: executable, explicit: explicitExecutable, tool: explicitExecutable, args: validationArgs },
	]) {
		const options = { profile: "ua1", ...(scenario.explicit ? { executable: scenario.explicit } : {}) };
		const selectionCode = `import { checkPdfAccessibility } from ${JSON.stringify(new URL("../src/pdf-accessibility.ts", import.meta.url).href)}; process.stdout.write(JSON.stringify(await checkPdfAccessibility(${JSON.stringify(snapshot)}, ${JSON.stringify(options)})));`;
		const selected = spawnSync(process.execPath, ["--input-type=module", "-e", selectionCode], { env: { ...env, VERAPDF: scenario.selected }, encoding: "utf8" });
		assert.equal(selected.status, 0, selected.error?.message ?? selected.stderr);
		const validation = JSON.parse(selected.stdout);
		assert.equal(validation.machineStatus, "complete");
		assert.equal(validation.evidence[0].tool, scenario.tool);
		assert.deepEqual(validation.evidence[0].args, scenario.args);
		assert.deepEqual((await readFile(join(dir, "args.txt"), "utf8")).trim().split(/\r?\n/), scenario.args);
		assert.equal(await readFile(join(dir, "injected.txt"), "utf8"), "");
	}
});

test("real veraPDF distinguishes untagged PDF from tagged generated PDF", async (t) => {
	const executable = process.env.PRAXITY_TEST_VERAPDF, bad = process.env.PRAXITY_TEST_PDF_BAD, good = process.env.PRAXITY_TEST_PDF_GOOD;
	if (!executable || !bad || !good) { t.skip("Set PRAXITY_TEST_VERAPDF, PRAXITY_TEST_PDF_BAD and PRAXITY_TEST_PDF_GOOD to run real validator coverage"); return; }
	const failed = await checkPdfAccessibility(bad, { executable, profile: "ua1" });
	assert.equal(failed.machineStatus, "complete");
	assert.equal(failed.evidence[0]?.exitCode, 1);
	assert.equal(failed.evaluations[0]?.outcome, "failed");
	assert.ok(failed.findings.length > 0);
	const passed = await checkPdfAccessibility(good, { executable, profile: "ua1" });
	assert.equal(passed.machineStatus, "complete");
	assert.equal(passed.evaluations[0]?.outcome, "passed");
	assert.deepEqual(passed.findings, []);
	const ua2 = await checkPdfAccessibility(good, { executable, profile: "ua2" });
	assert.equal(ua2.machineStatus, "complete");
	assert.equal(ua2.evidence[0]?.exitCode, 1);
	assert.equal(ua2.evaluations[0]?.outcome, "failed");
	assert.ok(ua2.findings.length > 0);
});
