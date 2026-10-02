import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runScreenReaderJourney } from "../src/screen-reader.ts";

test("real portable NVDA delivers navigation keys and speaks the local live region", {
  skip: process.env.PRAXITY_NVDA_LIVE !== "1",
  timeout: 120_000,
}, async (t) => {
  assert.equal(process.platform, "win32", "the opt-in live test requires Windows");
  const fixture = fileURLToPath(new URL("./fixtures/nvda-driver/", import.meta.url));
  const journey = JSON.parse(await readFile(join(fixture, "journey.json"), "utf8"));
  const output = process.env.PRAXITY_NVDA_OUTPUT ?? join(await mkdtemp(join(tmpdir(), "praxity-nvda-live-")), "evidence");
  const result = await runScreenReaderJourney({ target: fixture, journey, output, takeScreenControl: true, allowNetwork: false });
  t.diagnostic(`Speech transcript: ${result.markdownPath}`);
  const report = JSON.parse(await readFile(result.jsonPath, "utf8"));
  assert.equal(result.exitCode, 0, JSON.stringify(report.results.map((step: { step: { id: string }; classification: string; reasons: string[] }) => ({ id: step.step.id, classification: step.classification, reasons: step.reasons })), null, 2));
  assert.equal(report.results.length, 4);
  for (const step of report.results) {
    assert.equal(step.status, "pass", step.step.id);
    assert.equal(step.speech.source, "nvda-log", step.step.id);
    assert.ok(step.checks.every((check: { met: boolean }) => check.met), step.step.id);
  }
  assert.ok(report.results[3].speech.phrases.some((phrase: string) => phrase.includes("Ready to continue")));
});
