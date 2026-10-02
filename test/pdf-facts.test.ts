import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { extractPdfFacts, type PdfToolEvidence, type PopplerExecution } from "../src/pdf-facts.ts";

const rules = ["pdf.open", "page.facts", "font.facts", "image.facts", "text.facts"];
const fontTable = "name type encoding emb sub uni object ID\n---- ---- ---- --- --- --- ----\nHelvetica Type 1 WinAnsi no no no 4 0\n";
const imageTable = "page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------------------\n";
const textTable = "level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t0\t0\t0\t0\t20\t30\t40\t12\t100\tFixture\n";
const pageInfo = ["Page 1 size: 612 x 792 pts", "Page 1 rot: 0", ...["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"].map(name => `Page 1 ${name}: 0 0 612 792`)].join("\n");

// The test adapter scripts only the execution seam; the module still reads the snapshot and runs its parsers.
function scriptedPoppler(overrides: Record<string, Partial<PdfToolEvidence>> = {}): PopplerExecution {
	return async (tool, args) => {
		const key = tool === "pdfinfo" && args[0] === "-box" ? "pdfinfo -box" : tool;
		const outputs: Record<string, string> = { pdfinfo: "Pages: 1\nEncrypted: no\n", "pdfinfo -box": pageInfo, pdffonts: fontTable, pdfimages: imageTable, pdftotext: textTable };
		assert.ok(Object.hasOwn(outputs, key), `Unexpected tool ${tool}`);
		return { tool, args, exitCode: 0, stdout: args[0] === "-v" ? "" : outputs[key]!, stderr: args[0] === "-v" ? `${tool} version fixture\n` : "", ...overrides[key] };
	};
}

async function snapshot(t: TestContext, content?: string) {
	const dir = await mkdtemp(join(tmpdir(), "pdf-facts-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "input.pdf");
	await writeFile(path, content ?? await readFile(resolve("test/fixtures/pdf-facts.pdf")), { mode: 0o400 });
	await chmod(path, 0o400);
	return path;
}

test("production extraction reads a real PDF fixture and leaves the caller's snapshot unchanged", async (t) => {
	for (const tool of ["pdfinfo", "pdffonts", "pdfimages", "pdftotext"]) {
		try { execFileSync(tool, ["-v"], { stdio: "ignore" }); } catch { t.skip(`${tool} unavailable`); return; }
	}
	const path = await snapshot(t), before = await readFile(path), mode = (await stat(path)).mode;
	const extraction = await extractPdfFacts(path);
	assert.equal(extraction.machineStatus, "complete");
	assert.deepEqual(extraction.document, { sha256: "e1f5125f3debeb3acb2facce107d4cc8afc6078feb7fc86f2db30394e3e51bfe", bytes: 1071 });
	assert.deepEqual(extraction.evaluations.map(({ rule, outcome }) => [rule, outcome]), rules.map(rule => [rule, "passed"]));
	assert.equal(extraction.facts.metadata.Pages, "2");
	assert.equal(extraction.facts.pages.length, 2);
	assert.equal(extraction.facts.pages[0]?.rotation, 90);
	assert.deepEqual(extraction.facts.pages[0]?.boxes.CropBox, [10, 10, 602, 782]);
	assert.deepEqual(extraction.facts.fonts.map(font => [font.name, font.embedded]), [["Helvetica", false]]);
	assert.deepEqual(extraction.facts.images.map(image => [image.page, image.width, image.height, image.xPpi, image.yPpi]), [[1, 1, 1, 1, 1]]);
	assert.deepEqual(extraction.facts.words.map(word => word.text), ["PDF", "facts", "fixture"]);
	assert.equal(extraction.evidence.length, 9);
	assert.deepEqual(extraction.evidence.slice(0, 4).map(({ tool, args }) => [tool, args]), ["pdfinfo", "pdffonts", "pdfimages", "pdftotext"].map(tool => [tool, ["-v"]]));
	assert.ok(extraction.evidence.slice(4).every(item => item.args.includes(path)));
	assert.equal((await stat(path)).mode, mode);
	assert.deepEqual(await readFile(path), before);
});

test("the execution seam retains extraction order, evidence and coordinate conventions", async (t) => {
	const path = await snapshot(t);
	const extraction = await extractPdfFacts(path, scriptedPoppler());
	assert.equal(extraction.machineStatus, "complete");
	assert.deepEqual(extraction.evaluations, rules.map(rule => ({ rule, outcome: "passed", reason: "Extraction completed; this is not a quality or conformance verdict." })));
	assert.deepEqual(extraction.evidence.slice(4).map(({ tool, args }) => [tool, args]), [
		["pdfinfo", [path]], ["pdfinfo", ["-box", "-f", "1", "-l", "1", path]],
		["pdffonts", [path]], ["pdfimages", ["-list", path]], ["pdftotext", ["-tsv", path, "-"]],
	]);
	assert.deepEqual(extraction.facts.pages, [{ page: 1, width: 612, height: 792, rotation: 0, boxes: { MediaBox: [0, 0, 612, 792], CropBox: [0, 0, 612, 792], BleedBox: [0, 0, 612, 792], TrimBox: [0, 0, 612, 792], ArtBox: [0, 0, 612, 792] } }]);
	assert.deepEqual(extraction.facts.words, [{ page: 1, rect: [20, 30, 40, 12], text: "Fixture" }]);
	assert.deepEqual(extraction.facts.coordinates, { boxes: "PDF default user space, bottom-left origin; UserUnit not extracted", text: "Poppler TSV page presentation, top-left origin, points; not normalized to unrotated CropBox" });
	assert.deepEqual(extraction.needsReview, []);
});

test("one missing tool leaves its inventory untested while other facts are extracted", async (t) => {
	const path = await snapshot(t);
	const extraction = await extractPdfFacts(path, scriptedPoppler({ pdffonts: { exitCode: null, stdout: "", stderr: "", error: "spawn pdffonts ENOENT" } }));
	assert.equal(extraction.machineStatus, "incomplete");
	assert.deepEqual(extraction.evaluations.map(({ rule, outcome }) => [rule, outcome]), rules.map(rule => [rule, rule === "font.facts" ? "untested" : "passed"]));
	assert.equal(extraction.evaluations[2]?.reason, "spawn pdffonts ENOENT");
	assert.deepEqual(extraction.facts.fonts, []);
	assert.equal(extraction.facts.pages.length, 1);
	assert.equal(extraction.facts.words[0]?.text, "Fixture");
	assert.equal(extraction.evidence.filter(item => item.error === "spawn pdffonts ENOENT").length, 2);
	assert.ok((await stat(path)).isFile());
});

test("a non-zero tool exit retains evidence and does not parse its plausible stdout", async (t) => {
	const path = await snapshot(t);
	const extraction = await extractPdfFacts(path, scriptedPoppler({ pdftotext: { exitCode: 7, stderr: "Could not read text\n" } }));
	assert.equal(extraction.machineStatus, "incomplete");
	assert.deepEqual(extraction.evaluations[4], { rule: "text.facts", outcome: "untested", reason: "Could not read text\n" });
	assert.deepEqual(extraction.facts.words, []);
	assert.equal(extraction.facts.fonts[0]?.name, "Helvetica");
	assert.equal(extraction.evidence[8]?.exitCode, 7);
	assert.equal(extraction.evidence[8]?.stdout, textTable);
	assert.deepEqual(extraction.needsReview, []);
});

test("parser rejection is incomplete extraction and retains the rejected output", async (t) => {
	for (const [tool, rule, stdout, reason] of [
		["pdfinfo", "pdf.open", "Pages: invalid\n", "Missing or invalid page count"],
		["pdfinfo -box", "page.facts", "Pages: 1\n", "Missing page 1 geometry"],
		["pdffonts", "font.facts", "unknown output", "Unrecognized Poppler table header"],
		["pdfimages", "image.facts", imageTable + "unrecognized row\n", "Unrecognized image row: unrecognized row"],
		["pdftotext", "text.facts", "new TSV format", "Unrecognized Poppler TSV header"],
	]) {
		await t.test(rule, async (t) => {
			const path = await snapshot(t);
			const extraction = await extractPdfFacts(path, scriptedPoppler({ [tool!]: { stdout, stderr: "warning on rejected output" } }));
			assert.equal(extraction.machineStatus, "incomplete");
			assert.deepEqual(extraction.evaluations.find(item => item.rule === rule), { rule, outcome: "untested", reason });
			assert.ok(extraction.evidence.some(item => item.stdout === stdout));
			assert.deepEqual(extraction.needsReview, []);
			if (rule !== "pdf.open") assert.equal(extraction.evaluations.find(item => item.rule === "pdf.open")?.outcome, "passed");
		});
	}
});

test("successful Poppler stderr warnings become needs-review issues in extraction order", async (t) => {
	const path = await snapshot(t);
	const extraction = await extractPdfFacts(path, scriptedPoppler({ pdfinfo: { stderr: "open warning\n" }, pdfimages: { stderr: "image warning\n" } }));
	assert.equal(extraction.machineStatus, "complete");
	assert.ok(extraction.evaluations.every(item => item.outcome === "passed"));
	assert.deepEqual(extraction.needsReview, [["pdf.open", "open warning\n"], ["image.facts", "image warning\n"]].map(([rule, evidence]) => ({ rule, message: "Poppler reported warnings while reading the PDF. See the evidence.", remedy: "Review the diagnostic and regenerate from source if needed.", evidence })));
});

test("an encrypted PDF is refused after metadata extraction without running inventories", async (t) => {
	const path = await snapshot(t);
	const extraction = await extractPdfFacts(path, scriptedPoppler({ pdfinfo: { stdout: "Pages: 1\nEncrypted: yes (print:yes copy:no)\n" } }));
	assert.equal(extraction.machineStatus, "incomplete");
	assert.deepEqual(extraction.facts.metadata, { Pages: "1", Encrypted: "yes (print:yes copy:no)" });
	assert.deepEqual(extraction.evaluations, [
		{ rule: "pdf.open", outcome: "untested", reason: "Encrypted PDFs are not supported in this slice." },
		...rules.slice(1).map(rule => ({ rule, outcome: "untested", reason: "PDF could not be opened; extraction did not run." })),
	]);
	assert.equal(extraction.evidence.length, 5);
	assert.deepEqual([extraction.facts.pages, extraction.facts.fonts, extraction.facts.images, extraction.facts.words], [[], [], [], []]);
	assert.ok((await stat(path)).isFile());
});

test("a file without a PDF header records versions but skips opening and inventories", async (t) => {
	for (const content of ["not a PDF", " ".repeat(1024) + "%PDF-1.7"]) {
		const path = await snapshot(t, content);
		const extraction = await extractPdfFacts(path, scriptedPoppler());
		assert.equal(extraction.machineStatus, "incomplete");
		assert.deepEqual(extraction.evaluations, [
			{ rule: "pdf.open", outcome: "untested", reason: "Input has no PDF header in its first 1024 bytes." },
			...rules.slice(1).map(rule => ({ rule, outcome: "untested", reason: "PDF could not be opened; extraction did not run." })),
		]);
		assert.equal(extraction.evidence.length, 4);
		assert.deepEqual(extraction.facts.metadata, {});
		assert.equal(await readFile(path, "utf8"), content);
	}
});

test("a successfully empty inventory is distinct from an unavailable one", async (t) => {
	const path = await snapshot(t);
	const empty = await extractPdfFacts(path, scriptedPoppler());
	const unavailable = await extractPdfFacts(path, scriptedPoppler({ pdfimages: { exitCode: null, stdout: "", stderr: "", error: "spawn pdfimages ENOENT" } }));
	assert.deepEqual(empty.facts.images, []);
	assert.deepEqual(unavailable.facts.images, []);
	assert.deepEqual(empty.evaluations.find(item => item.rule === "image.facts"), { rule: "image.facts", outcome: "passed", reason: "Extraction completed; this is not a quality or conformance verdict." });
	assert.deepEqual(unavailable.evaluations.find(item => item.rule === "image.facts"), { rule: "image.facts", outcome: "untested", reason: "spawn pdfimages ENOENT" });
	assert.equal(empty.machineStatus, "complete");
	assert.equal(unavailable.machineStatus, "incomplete");
});

test("snapshot read failures reject instead of returning empty facts", async () => {
	await assert.rejects(extractPdfFacts(resolve("test/fixtures/nonexistent-pdf-facts.pdf"), scriptedPoppler()), { code: "ENOENT" });
});
