import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHtmlReview } from '../../src/html-review.ts';
import { snapshotInput } from '../../src/input.ts';
import { discover } from '../../src/discover.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const metric = (numerator: number, denominator: number) => ({ numerator, denominator, ratio: denominator ? numerator / denominator : null });
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty string');
}
function array(value: unknown): asserts value is unknown[] { if (!Array.isArray(value)) throw new Error('Expected array'); }
function strings(value: unknown): asserts value is string[] {
  array(value); value.forEach(text);
  if (new Set(value).size !== value.length) throw new Error('Duplicate list entry');
}
function integer(value: unknown, min = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('Expected nonnegative integer');
}
const counts = () => ({ attempted: 0, valid: 0, failed: 0, invalid: 0, contaminated: 0, expected: 0, detected: 0, findings: 0, unsupported: 0, controlTrials: 0, controlFalseAlarms: 0, contextQuestions: 0, suggestions: 0, supported: 0, actionable: 0, unexpectedDefects: 0 });

/** Counts blinded judgments; never decides whether finding prose is true. */
export async function scoreRun(runPath: string) {
  const base = dirname(resolve(runPath));
  const file = async (path: unknown) => { text(path); return readFile(resolve(base, path)); };
  const checkedFile = async (path: unknown, expected: unknown) => {
    const bytes = await file(path);
    if (hash(bytes) !== expected) throw new Error(`SHA-256 mismatch: ${String(path)}`);
    return bytes;
  };
  const bytes = await readFile(runPath);
  const run: unknown = JSON.parse(bytes.toString()); object(run);
  if (run.schemaVersion !== 'html-development-score-1') throw new Error('Unsupported score version');
  text(run.adjudicator);
  const key: unknown = JSON.parse((await checkedFile(run.keyPath, run.keySha256)).toString()); object(key);
  if (key.split !== 'development') throw new Error('Only development keys are supported');
  text(key.id); integer(key.version, 1); array(key.cases);
  const cases = new Map<string, { family: string; inputSha256: string; expected: string[] }>();
  for (const entry of key.cases) {
    object(entry); text(entry.id); text(entry.family); text(entry.inputSha256); array(entry.expectedDefects);
    const expected = entry.expectedDefects.map(defect => { object(defect); text(defect.id); return defect.id; });
    strings(expected);
    if (cases.has(entry.id)) throw new Error('Duplicate key case');
    cases.set(entry.id, { family: entry.family, inputSha256: entry.inputSha256, expected });
  }
  array(run.trials);
  if (!run.trials.length) throw new Error('Run needs attempted trials');
  const identities = new Set<string>();
  const groups = new Map<string, { family: string; model: { id: string; effort: string }; counts: ReturnType<typeof counts> }>();
  const frozenEvidence = new Map<string, string>();
  const trials = [];
  for (const trial of run.trials) {
    object(trial); text(trial.id); text(trial.caseId); integer(trial.repeat, 1);
    object(trial.model); text(trial.model.id); text(trial.model.effort);
    if (identities.has(trial.id)) throw new Error('Duplicate attempt id');
    identities.add(trial.id);
    const entry = cases.get(trial.caseId);
    if (!entry) throw new Error('Unknown case');
    if (!['valid', 'failed', 'invalid', 'contaminated'].includes(String(trial.status))) throw new Error('Unknown attempt status');
    const model = { id: trial.model.id, effort: trial.model.effort };
    const groupId = JSON.stringify([entry.family, model.id, model.effort]);
    const group = groups.get(groupId) ?? { family: entry.family, model, counts: counts() };
    groups.set(groupId, group);
    const total = group.counts;
    total.attempted++;
    const identity = { id: trial.id, caseId: trial.caseId, repeat: trial.repeat, model, status: trial.status };
    if (trial.status !== 'valid') {
      text(trial.reason);
      total[trial.status as 'failed' | 'invalid' | 'contaminated']++;
      if (trial.adjudications !== undefined) { array(trial.adjudications); if (trial.adjudications.length) throw new Error('Excluded attempt cannot have quality judgments'); }
      if (trial.reviewPath !== undefined || trial.reviewSha256 !== undefined) await checkedFile(trial.reviewPath, trial.reviewSha256);
      trials.push({ ...identity, reason: trial.reason, reviewPath: trial.reviewPath, reviewSha256: trial.reviewSha256 });
      continue;
    }
    text(trial.inputPath); text(trial.bundlePath); text(trial.reviewPath);
    const inputPath = resolve(base, trial.inputPath), bundlePath = resolve(base, trial.bundlePath);
    if (JSON.stringify((await readdir(inputPath)).sort()) !== '["index.html"]') throw new Error('Development input must contain only index.html');
    if (hash(await readFile(join(inputPath, 'index.html'))) !== entry.inputSha256) throw new Error('Input differs from frozen key');
    await checkedFile(join(bundlePath, 'manifest.json'), trial.manifestSha256);
    await checkedFile(join(bundlePath, 'evidence.json'), trial.evidenceSha256);
    await checkedFile(trial.promptPath, trial.promptSha256);
    await checkedFile(trial.reviewPath, trial.reviewSha256);
    // A trial copy may hold the response, but its packet must be the frozen packet.
    for (const name of ['manifest.json', 'evidence.json']) {
      if (!((await file(join(dirname(resolve(base, trial.reviewPath)), name))).equals(await readFile(join(bundlePath, name))))) throw new Error('Review packet differs from frozen bundle');
    }
    const packet = JSON.stringify([trial.manifestSha256, trial.evidenceSha256]);
    if (frozenEvidence.has(trial.caseId) && frozenEvidence.get(trial.caseId) !== packet) throw new Error('Case evidence changed across attempts');
    frozenEvidence.set(trial.caseId, packet);
    const reviewPath = resolve(base, trial.reviewPath);
    const snapshot = await snapshotInput(inputPath);
    const review = await (async () => {
      try { return await importHtmlReview(reviewPath, snapshot.contentSha256, await discover(snapshot.root, 'http://127.0.0.1:1')); }
      finally { await snapshot.cleanup(); }
    })();
    if (review.reviewer.model !== model.id) throw new Error('Review model differs from actual trial model');
    array(trial.adjudications);
    const judged = new Set<number>(), detected = new Set<string>();
    let unsupported = 0, controlFalseAlarm = false;
    for (const judgment of trial.adjudications) {
      object(judgment); integer(judgment.findingIndex); text(judgment.reason); strings(judgment.defectIds); strings(judgment.evidenceIds);
      const finding = review.findings[judgment.findingIndex];
      if (!finding || judged.has(judgment.findingIndex)) throw new Error('Invalid or duplicate adjudication index');
      judged.add(judgment.findingIndex);
      if (typeof judgment.actionable !== 'boolean') throw new Error('Actionable must be boolean');
      const candidate = review.retainedEvidence.candidates.find(candidate => candidate.id === finding.candidateId)!;
      const evidenceIds = [candidate.id, candidate.stateId, ...candidate.traces.map(trace => trace.id)];
      if (!judgment.evidenceIds.length || judgment.evidenceIds.some(id => !evidenceIds.includes(id))) throw new Error('Adjudication evidence must correspond to the finding candidate');
      if (judgment.verdict === 'supported-defect') {
        if (!judgment.defectIds.length && judgment.unexpectedDefect === undefined) throw new Error('Supported finding needs defect mapping or unexpectedDefect reason');
        if (judgment.unexpectedDefect !== undefined) { text(judgment.unexpectedDefect); total.unexpectedDefects++; }
        for (const id of judgment.defectIds) {
          if (!entry.expected.includes(id)) throw new Error('Unknown expected defect');
          detected.add(id);
        }
        total.supported++;
        if (judgment.actionable) total.actionable++;
      } else {
        if (judgment.defectIds.length || judgment.unexpectedDefect !== undefined || judgment.actionable) throw new Error('Only supported defects can map defects or have actionable advice');
        if (judgment.verdict === 'unsupported') { unsupported++; controlFalseAlarm = true; }
        else if (judgment.verdict === 'context-question') total.contextQuestions++;
        else if (judgment.verdict === 'suggestion') total.suggestions++;
        else throw new Error('Invalid verdict');
      }
    }
    if (judged.size !== review.findings.length) throw new Error('Every finding needs exactly one adjudication');
    total.valid++; total.expected += entry.expected.length; total.detected += detected.size;
    total.findings += review.findings.length; total.unsupported += unsupported;
    if (!entry.expected.length) { total.controlTrials++; if (controlFalseAlarm) total.controlFalseAlarms++; }
    trials.push({ ...identity, detectedDefectIds: [...detected].sort(), missedDefectIds: entry.expected.filter(id => !detected.has(id)), findings: review.findings.length, unsupported, manifestSha256: trial.manifestSha256, evidenceSha256: trial.evidenceSha256, promptSha256: trial.promptSha256, reviewSha256: trial.reviewSha256 });
  }
  return {
    schemaVersion: 'html-development-score-result-1', keySha256: run.keySha256, runSha256: hash(bytes), scorerSha256: hash(await readFile(fileURLToPath(import.meta.url))), adjudicator: run.adjudicator,
    limitations: ['Development cases with inspected mechanisms; these counts do not establish generalization or conformance.', 'Valid-trial detection excludes failed, invalid and contaminated attempts; read their counts together.', 'Families are reported separately and are not a combined model ranking.'],
    families: [...groups.values()].map(({ family, model, counts: c }) => ({ family, model, counts: c, detection: metric(c.detected, c.expected), unsupportedClaims: metric(c.unsupported, c.findings), controlFalseAlarms: metric(c.controlFalseAlarms, c.controlTrials), actionableAdvice: metric(c.actionable, c.supported) })), trials,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node bench/interaction-review/score.ts RUN.json');
    console.log(JSON.stringify(await scoreRun(process.argv[2]!), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
