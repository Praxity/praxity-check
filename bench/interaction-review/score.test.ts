import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scoreRun } from './score.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const identity = (value: unknown) => hash(JSON.stringify(value));
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'html-score-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'input')); await mkdir(join(root, 'bundle'));
  const html = '<!doctype html><title>Synthetic lesson</title><button>Hint</button>';
  await writeFile(join(root, 'input/index.html'), html);
  const trace = { action: 'Enter', before: 'closed', after: 'closed' };
  const raw = { surface: 'disclosures', page: 'index.html', selector: 'button', occurrences: ['button'], occurrenceCount: 1, dom: { html: '<button>Hint</button>', aria: '', contextSelector: 'body', visible: true, related: [] }, traces: [trace] };
  const candidate = { ...raw, id: identity(raw), stateId: identity(raw.dom), traces: [{ ...trace, id: identity(trace) }] };
  const evidence = { pages: [{ file: 'index.html', audited: true }], candidates: [candidate], environment: { browser: 'test', engine: 'test', viewport: 'test', preferredColorScheme: 'light', documentColorScheme: 'light', theme: 'test' }, omitted: 0, perSurfaceCaps: [] };
  const manifest = { schemaVersion: 'html-review-bundle-1', contentSha256: identity([['index.html', hash(html)]]), evidenceSha256: identity(evidence), tier: 'inference', checks: ['accessibility'], allowNetwork: false };
  const finding = { page: 'index.html', candidateId: candidate.id, stateId: candidate.stateId, check: 'accessibility', category: 'observed-defect', claim: 'executed-behavior', confidence: 'high', message: 'The recorded action does not open the hint.', action: 'Handle Enter.', consequence: 'Keyboard users cannot read the hint.', verification: 'Press Enter.', evidence: { observation: 'Closed before and after Enter.', traceIds: [identity(trace)] } };
  const review = { schemaVersion: 'html-review-1', contentSha256: manifest.contentSha256, evidenceSha256: manifest.evidenceSha256, tier: 'inference', checks: ['accessibility'], pagesReviewed: ['index.html'], candidatesReviewed: [candidate.id], reviewer: { model: 'test-model' }, findings: [finding, finding, finding, { ...finding, category: 'needs-context' }, { ...finding, category: 'suggestion' }] };
  const key = { id: 'test', version: 1, split: 'development', cases: [{ id: 'a', family: 'disclosure', inputSha256: hash(html), expectedDefects: [{ id: 'keyboard' }] }, { id: 'b', family: 'disclosure', inputSha256: hash(html), expectedDefects: [] }] };
  const adjudications = ['supported-defect', 'supported-defect', 'unsupported', 'context-question', 'suggestion'].map((verdict, findingIndex) => ({ findingIndex, verdict, defectIds: verdict === 'supported-defect' ? ['keyboard'] : [], evidenceIds: [identity(trace)], actionable: findingIndex === 0, reason: 'Synthetic scorer test judgment.' }));
  const valid = { id: 'attempt-1', caseId: 'a', repeat: 1, model: { id: 'test-model', effort: 'max' }, status: 'valid', inputPath: 'input', bundlePath: 'bundle', manifestSha256: identity(manifest), evidenceSha256: identity(evidence), promptPath: 'prompt.md', promptSha256: hash('Task: read the hint.'), reviewPath: 'bundle/review.json', reviewSha256: identity(review), adjudications };
  const run = { schemaVersion: 'html-development-score-1', keyPath: 'key.json', keySha256: identity(key), adjudicator: 'synthetic test, no quality judgment', trials: [valid] };
  for (const [path, value] of Object.entries({ 'key.json': key, 'bundle/manifest.json': manifest, 'bundle/evidence.json': evidence, 'bundle/review.json': review })) await writeFile(join(root, path), JSON.stringify(value));
  await writeFile(join(root, 'prompt.md'), 'Task: read the hint.');
  const score = async (value: unknown = run) => { await writeFile(join(root, 'run.json'), JSON.stringify(value)); return scoreRun(join(root, 'run.json')); };
  return { root, run, valid, review, manifest, evidence, key, score };
}

test('counts unique detections, duplicate actionable findings, controls and every attempt status separately', async t => {
  const { run, valid, score } = await fixture(t);
  const control = { ...valid, id: 'control', caseId: 'b', adjudications: valid.adjudications.map(j => ({ ...j, defectIds: [], actionable: false, verdict: j.findingIndex < 3 ? 'unsupported' : j.verdict })) };
  const statuses = ['failed', 'invalid', 'contaminated'].map(status => ({ id: status, caseId: 'a', repeat: 1, model: valid.model, status, reason: 'Synthetic failure.' }));
  const onlyQuestions = { ...control, id: 'questions', model: { ...valid.model, effort: 'low' }, adjudications: control.adjudications.map(j => ({ ...j, verdict: 'context-question' })) };
  const result = await score({ ...run, trials: [valid, control, ...statuses, onlyQuestions] });
  const high = result.families[0]!;
  assert.deepEqual(high.detection, { numerator: 1, denominator: 1, ratio: 1 });
  assert.deepEqual(high.unsupportedClaims, { numerator: 4, denominator: 10, ratio: 0.4 });
  assert.deepEqual(high.actionableAdvice, { numerator: 1, denominator: 2, ratio: 0.5 });
  assert.deepEqual(high.controlFalseAlarms, { numerator: 1, denominator: 1, ratio: 1 });
  assert.equal(high.counts.attempted, 5); assert.equal(high.counts.valid, 2);
  for (const status of ['failed', 'invalid', 'contaminated'] as const) assert.equal(high.counts[status], 1);
  assert.equal(high.counts.contextQuestions, 2); assert.equal(high.counts.suggestions, 2);
  assert.equal(result.families[1]!.detection.ratio, null);
  assert.equal(result.families[1]!.actionableAdvice.ratio, null);
  assert.equal(result.families[1]!.controlFalseAlarms.numerator, 0);
  assert.equal(result.trials.length, 6);
});

test('rejects incomplete judgments, unknown defects, changed identities and evidence', async t => {
  const { root, run, valid, review, score } = await fixture(t);
  await score();
  for (const [patch, pattern] of [
    [{ adjudications: valid.adjudications.slice(1) }, /Every finding/],
    [{ adjudications: [...valid.adjudications, valid.adjudications[0]] }, /duplicate adjudication/],
    [{ adjudications: valid.adjudications.map((j, i) => i ? j : { ...j, defectIds: ['invented'] }) }, /Unknown expected defect/],
    [{ adjudications: valid.adjudications.map((j, i) => i ? j : { ...j, evidenceIds: ['0'.repeat(64)] }) }, /correspond/],
    [{ model: { id: 'wrong-model', effort: 'max' } }, /actual trial model/],
    [{ manifestSha256: '0'.repeat(64) }, /SHA-256 mismatch/],
    [{ promptSha256: '0'.repeat(64) }, /SHA-256 mismatch/],
    [{ reviewSha256: '0'.repeat(64) }, /SHA-256 mismatch/],
  ] as const) await assert.rejects(score({ ...run, trials: [{ ...valid, ...patch }] }), pattern);
  await assert.rejects(score({ ...run, trials: [valid, valid] }), /Duplicate attempt/);
  await assert.rejects(score({ ...run, keySha256: '0'.repeat(64) }), /SHA-256 mismatch/);
  const badReview = { ...review, findings: [{ ...review.findings[0], stateId: '0'.repeat(64) }] };
  await writeFile(join(root, 'bundle/review.json'), JSON.stringify(badReview));
  await assert.rejects(score({ ...run, trials: [{ ...valid, reviewSha256: identity(badReview) }] }), /rendered state/);
  await writeFile(join(root, 'input/index.html'), 'changed');
  await assert.rejects(score(), /Input differs/);
});


test('control false alarms follow adjudication even when the model labels a false claim needs-context', async t => {
  const { root, run, valid, review, score } = await fixture(t);
  const questionReview = { ...review, findings: [review.findings.find(finding => finding.category === 'needs-context')!] };
  await writeFile(join(root, 'bundle/review.json'), JSON.stringify(questionReview));
  const judgment = { ...valid.adjudications[3]!, findingIndex: 0 };
  const control = { ...valid, caseId: 'b', reviewSha256: identity(questionReview), adjudications: [judgment] };
  const unsupported = await score({ ...run, trials: [{ ...control, adjudications: [{ ...judgment, verdict: 'unsupported' }] }] });
  assert.deepEqual(unsupported.families[0]!.controlFalseAlarms, { numerator: 1, denominator: 1, ratio: 1 });
  assert.equal(unsupported.families[0]!.counts.unsupported, 1);
  assert.equal(unsupported.families[0]!.counts.contextQuestions, 0);
  const contextual = await score({ ...run, trials: [control] });
  assert.deepEqual(contextual.families[0]!.controlFalseAlarms, { numerator: 0, denominator: 1, ratio: 0 });
  assert.equal(contextual.families[0]!.counts.unsupported, 0);
  assert.equal(contextual.families[0]!.counts.contextQuestions, 1);
});
