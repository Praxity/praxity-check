import assert from "node:assert/strict";
import test from "node:test";
import { pdfFeedback } from "../src/feedback.ts";
import { createReport } from "../src/report.ts";
import { normalizePdfReview } from "../src/pdf-review.ts";

function resolvePointer(report: unknown, pointer: string): unknown {
	return pointer.slice(1).split("/").reduce<unknown>((value, key) => {
		assert.ok(value !== null && typeof value === "object");
		return (value as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")];
	}, report);
}

test("HTML feedback preserves state, unresolved evidence, skipped pages and revision limits", () => {
	const page = { file: "lesson.html", url: "http://localhost/lesson.html" };
	const report = createReport("/tmp/synthetic", true, { pages: [page], stubs: [{ file: "index.html", target: "lesson.html", resolved: true }] }, [{
		page, audited: true, triage: { ok: true }, notes: ["Focus inspection stopped at the configured limit."],
		findings: [{ what: "Text contrast is too low.", page: page.file, selector: "button", state: "menu-open", evidence: "2:1", fix: "Increase contrast.", confidence: "high", lens: "a11y", rule: "contrast", basis: "WCAG 1.4.3" }],
		needsReview: [{ what: "Confirm the background colour.", page: page.file, state: "menu-open", evidence: "Image background", lens: "a11y", rule: "background", basis: "WCAG 1.4.3" }],
		untested: [{ type: "check", check: "focus", page: page.file, state: "menu-open", outcome: "untested", reason: "Inspection limit reached." }],
	}, { page: { ...page, file: "blocked.html" }, audited: false, triage: { ok: false, reason: "Page did not load." }, findings: [], notes: [] }], [{ url: "https://invalid.example/image.png", method: "GET", resourceType: "image" }], false,
	{ runtime: { name: "node", version: "test" }, browser: { engine: "chromium", version: "test" }, viewport: { width: 1280, height: 720 }, colorScheme: "light" }, []);
	const feedback = JSON.parse(JSON.stringify(report)).feedback as typeof report.feedback;
	assert.equal(feedback.schemaVersion, "feedback-1");
	assert.deepEqual(feedback.findings[0]?.location, { format: "html", page: "lesson.html", state: "menu-open", selector: "button" });
	assert.equal(feedback.findings[0]?.action, "Increase contrast.");
	assert.equal(feedback.questions[0]?.method, "deterministic");
	assert.ok(!Object.hasOwn(feedback.questions[0]!, "action"));
	assert.ok(!Object.hasOwn(feedback.questions[0]!, "confidence"));
	assert.equal(feedback.coverage.find((entry) => entry.rule === "background")?.outcome, "cantTell");
	assert.equal(feedback.coverage.find((entry) => entry.rule === "focus")?.outcome, "untested");
	assert.equal(feedback.coverage.find((entry) => entry.rule === "page.audit")?.reason, "Page did not load.");
	assert.ok(feedback.limitations.some((reason) => reason.includes("no content revision hash")));
	assert.ok(feedback.limitations.some((reason) => reason.includes("configured limit")));
	assert.ok(feedback.limitations.some((reason) => reason.includes("Network requests were blocked") && reason.includes("/network/blockedRequests")));
	assert.match(feedback.coverage.find((entry) => entry.source === "/redirectStubs/0")?.reason ?? "", /Redirect-only page excluded.*Target exists/);
	for (const entry of feedback.coverage) assert.ok(resolvePointer(report, entry.source));
	for (const item of [...feedback.findings, ...feedback.questions]) {
		assert.ok(resolvePointer(report, item.source));
		assert.equal(typeof resolvePointer(report, item.evidence), "string");
		for (const pointer of item.provenance) assert.ok(resolvePointer(report, pointer));
	}
});

test("PDF feedback separates extraction, check domains, sampled inference and partial evidence", () => {
	const hash = "a".repeat(64);
	const issue = { id: "font-1", rule: "font.embedding", severity: "serious" as const, confidence: "high" as const,
		location: { documentSha256: hash }, message: "Font is not embedded.", remedy: "Embed it.", evidence: { font: "Synthetic" } };
	const finding = { page: 1, confidence: "medium" as const, message: "Instructions overlap.", action: "Increase spacing.", consequence: "Instructions are obscured.", origin: "Unknown source cause.", verification: "Inspect regenerated page.", evidence: { observation: "Two lines overlap." } };
	const legacy = normalizePdfReview({ schemaVersion: "pdf-review-1", documentSha256: hash, tier: "visual", pagesReviewed: [1], reviewer: { model: "test-model" }, findings: [finding] });
	const canonical = normalizePdfReview({ schemaVersion: "pdf-review-3", documentSha256: hash, tier: "inference", focus: "visual", checks: ["design"], pagesReviewed: [1], reviewer: { model: "test-model" }, findings: [
		{ ...finding, check: "design", category: "observed-defect" }, { ...finding, check: "design", category: "suggestion" },
	] });
	const report: Parameters<typeof pdfFeedback>[0] = {
		schemaVersion: "pdf-1", run: { id: "00000000-0000-0000-0000-000000000000", startedAt: "2026-09-15", runtime: "test" },
		document: { kind: "pdf", path: "synthetic.pdf", sha256: hash, bytes: 123 },
		selection: { checks: ["accessibility", "design"], tier: "deterministic" }, policy: { checks: "accessibility,design", tier: "deterministic", pdfua: "ua1" },
		machineStatus: "incomplete", evidence: [], facts: { metadata: {}, fonts: [], images: [], words: [], pages: [1, 2].map((page) => ({ page, width: 612, height: 792, rotation: 0, boxes: {} })), coordinates: { boxes: "test", text: "test" } },
		findings: [issue], needsReview: [{ ...issue, id: "image-1", rule: "image.resolution" }],
		evaluations: [{ rule: "font.facts", outcome: "passed", reason: "Extraction completed." }, { rule: "font.embedding", outcome: "failed", reason: "Not embedded." },
			{ rule: "pdfua.machine", outcome: "untested", reason: "Evidence was capped." }, { rule: "assistive.technology", outcome: "untested", reason: "Human review was not performed." }],
		pdfuaValidation: { name: "veraPDF", profile: "ua1", version: "test", machineCompliant: false, coverage: { status: "partial", failedChecks: 3, retainedChecks: 1, omittedChecks: 2, rules: [] } },
		inferenceReviews: [legacy, canonical],
	};
	const feedback = pdfFeedback(report);
	assert.deepEqual(feedback.findings[0]?.domains, ["accessibility", "design"]);
	assert.deepEqual(feedback.questions[0]?.domains, ["design"]);
	assert.equal(feedback.coverage[0]?.purpose, "extraction");
	assert.equal(feedback.coverage.find((entry) => entry.rule === "assistive.technology")?.method, "human");
	assert.equal(feedback.coverage.find((entry) => entry.rule === "pdfua.machine")?.outcome, "untested");
	assert.equal(feedback.coverage.find((entry) => entry.rule === "pdfua.machine.evidence")?.status, "partial");
	assert.deepEqual(feedback.questions.find((entry) => entry.method === "inference")?.domains, []);
	assert.ok(feedback.limitations.some((reason) => reason.includes("legacy review without declared domains")));
	const inferred = feedback.findings.find((entry) => entry.method === "inference")!;
	assert.equal(inferred.category, "observed-defect");
	assert.deepEqual(inferred.domains, ["design"]);
	assert.equal(feedback.suggestions[0]?.category, "suggestion");
	assert.equal(feedback.suggestions[0]?.id, inferred.id);
	assert.notEqual(feedback.suggestions[0]?.source, inferred.source);
	const coverage = feedback.coverage.filter((entry) => entry.method === "inference");
	assert.ok(coverage.every((entry) => entry.status === "partial" && entry.outcome === undefined));
	assert.deepEqual(coverage[0]?.pagesReviewed, [1]);
	for (const item of [...feedback.findings, ...feedback.questions, ...feedback.suggestions]) {
		assert.ok(resolvePointer(report, item.source));
		assert.ok(resolvePointer(report, item.evidence));
		for (const pointer of item.provenance) assert.ok(resolvePointer(report, pointer));
	}
	for (const entry of feedback.coverage) assert.ok(resolvePointer(report, entry.source));
	assert.ok(!JSON.stringify(feedback).includes('"observation"'));
});
