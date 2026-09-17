import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePdfReview, validatePdfReviewBundle, validatePdfReviewBundleSelection, readPdfEvidence as readFile } from '../../src/pdf-review.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function object(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) throw new Error(`Expected object keys: ${required.join(', ')}`);
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty string');
}
function integer(value: unknown, minimum = 1): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Expected integer >= ${minimum}`);
}
function array(value: unknown): asserts value is unknown[] { if (!Array.isArray(value)) throw new Error('Expected array'); }
const metric = (numerator: number, denominator: number) => ({ numerator, denominator, ratio: denominator ? numerator / denominator : null });

export async function scoreRun(runPath: string) {
  const base = dirname(resolve(runPath));
  const bytes = await readFile(runPath);
  const run: unknown = JSON.parse(bytes.toString());
  object(run, ['schemaVersion', 'corpus', 'model', 'condition', 'adjudicator', 'cases']);
  if (run.schemaVersion !== 'pdf-checkeval-1') throw new Error('Unsupported CheckEval version');
  object(run.corpus, ['id', 'version', 'generatorPath']);
  object(run.model, ['id', 'effort']);
  for (const value of [run.corpus.id, run.corpus.version, run.corpus.generatorPath, run.model.id, run.model.effort, run.condition, run.adjudicator]) text(value);
  const file = async (path: unknown, root = base) => { text(path); return readFile(resolve(root, path)); };
  const fingerprintFile = async (path: unknown, root = base) => hash(await file(path, root));
  const generatorSha256 = await fingerprintFile(run.corpus.generatorPath);
  array(run.cases);
  if (!run.cases.length) throw new Error('Run needs at least one case');
  const identities = new Set<string>();
  const corpusCases = new Map<string, string>();
  const repeatedEvidence = new Map<string, string>();
  const cases: { id: string; repeat: number; evidence: { pdfSha256: string; pageCount: number; pages: number[]; tier: unknown; artifacts: {page: number; imageSha256: string; factsSha256: string}[]; promptSha256: string; runPromptSha256: string; preprocessingManifestSha256: string | null; manifestSha256: string; reviewSha256: string; reviewSchemaVersion: string }; expected: number; detected: number; missed: number; detectedDefectIds: string[]; missedDefectIds: string[]; findings: number; supportedFindings: number; unsupported: number; contextQuestions: number; suggestions: number; actionableSupported: number; cleanCase: boolean; cleanCaseFalseAlarm: boolean }[] = [];
  const categoryTotals = new Map<string, { expected: number; detected: number }>();
  for (const entry of run.cases) {
    object(entry, ['id', 'repeat', 'pdfPath', 'manifestPath', 'reviewPath', 'promptPath', 'runPromptPath', 'expectedDefects', 'adjudications'], ['preprocessingManifestPath']);
    text(entry.id); integer(entry.repeat);
    const identity = JSON.stringify([entry.id, entry.repeat]);
    if (identities.has(identity)) throw new Error('Duplicate case/repeat');
    identities.add(identity);
    const pdfSha256 = await fingerprintFile(entry.pdfPath);
    text(entry.manifestPath);
    const bundle = await validatePdfReviewBundle(resolve(base, entry.manifestPath), pdfSha256);
    const { pages, artifacts } = bundle;
    const reviewBytes = await file(entry.reviewPath);
    const review = validatePdfReview(JSON.parse(reviewBytes.toString()), pdfSha256, bundle.pageCount);
    if (review.reviewer.model !== run.model.id || review.tier !== bundle.tier) throw new Error('Review model or tier mismatch');
    validatePdfReviewBundleSelection(review, bundle);
    if (JSON.stringify([...review.pagesReviewed].sort((a,b) => a-b)) !== JSON.stringify(pages)) throw new Error('Review must cover exactly the bundle selected pages');
    array(entry.expectedDefects);
    const defects = new Map<string, { category: string; page: number }>();
    for (const defect of entry.expectedDefects) {
      object(defect, ['id', 'category', 'page']); text(defect.id); text(defect.category); integer(defect.page);
      if (!pages.includes(defect.page) || defects.has(defect.id)) throw new Error('Expected defect must have a unique id and selected page');
      defects.set(defect.id, { category: defect.category, page: defect.page });
    }
    let preprocessingManifestSha256: string | null = null;
    if (entry.preprocessingManifestPath !== undefined) {
      text(entry.preprocessingManifestPath);
      const preprocessingBytes = await file(entry.preprocessingManifestPath);
      const preprocessing: unknown = JSON.parse(preprocessingBytes.toString());
      if (!preprocessing || typeof preprocessing !== 'object' || Array.isArray(preprocessing)) throw new Error('Invalid preprocessing manifest');
      const supplemental = preprocessing as Record<string, unknown>;
      array(supplemental.artifacts);
      const preprocessingDir = dirname(resolve(base, entry.preprocessingManifestPath));
      for (const artifact of supplemental.artifacts) {
        object(artifact, ['path', 'sha256']);
        if (await fingerprintFile(artifact.path, preprocessingDir) !== artifact.sha256) throw new Error('Preprocessing artifact hash mismatch');
      }
      preprocessingManifestSha256 = hash(preprocessingBytes);
    }
    const evidence = { manifestSha256: bundle.manifestSha256, pdfSha256, pageCount: bundle.pageCount, pages, tier: bundle.tier, artifacts: artifacts.sort((a,b) => a.page-b.page), promptSha256: await fingerprintFile(entry.promptPath), runPromptSha256: await fingerprintFile(entry.runPromptPath), preprocessingManifestSha256 };
    const corpusCase = JSON.stringify({ pdfSha256, expectedDefects: [...defects].sort(([a],[b]) => a.localeCompare(b)) });
    if (repeatedEvidence.has(entry.id) && repeatedEvidence.get(entry.id) !== JSON.stringify(evidence)) throw new Error('Repeated case evidence changed');
    repeatedEvidence.set(entry.id, JSON.stringify(evidence));
    if (corpusCases.has(entry.id) && corpusCases.get(entry.id) !== corpusCase) throw new Error('Repeated case evidence or expected defects changed');
    corpusCases.set(entry.id, corpusCase);
    array(entry.adjudications);
    const judged = new Set<number>(), detected = new Set<string>();
    let unsupported = 0, contextQuestions = 0, suggestions = 0, supportedFindings = 0, actionableSupported = 0;
    for (const judgment of entry.adjudications) {
      object(judgment, ['findingIndex', 'verdict', 'defectIds', 'actionable', 'reason']);
      integer(judgment.findingIndex, 0); text(judgment.reason); array(judgment.defectIds);
      const finding = review.findings[judgment.findingIndex];
      if (!finding || judged.has(judgment.findingIndex)) throw new Error('Invalid or duplicate adjudication index');
      judged.add(judgment.findingIndex);
      if (typeof judgment.actionable !== 'boolean' || typeof judgment.verdict !== 'string' || !['supported-defect', 'unsupported', 'context-question', 'suggestion'].includes(judgment.verdict)) throw new Error('Invalid adjudication');
      if (new Set(judgment.defectIds).size !== judgment.defectIds.length) throw new Error('Duplicate defect mapping');
      if (judgment.verdict === 'supported-defect') {
        if (!judgment.defectIds.length) throw new Error('Supported defect needs a known defect mapping');
        supportedFindings++;
        if (judgment.actionable) actionableSupported++;
        for (const id of judgment.defectIds) {
          text(id);
          if (defects.get(id)?.page !== finding.page) throw new Error('Unknown defect or wrong finding page');
          detected.add(id);
        }
      } else {
        if (judgment.defectIds.length) throw new Error('Only supported defects can map expected defects');
        if (judgment.verdict === 'unsupported') unsupported++;
        if (judgment.verdict === 'context-question') contextQuestions++;
        if (judgment.verdict === 'suggestion') suggestions++;
      }
    }
    if (judged.size !== review.findings.length) throw new Error('Every finding needs exactly one adjudication');
    for (const [id, defect] of defects) {
      const total = categoryTotals.get(defect.category) ?? { expected: 0, detected: 0 };
      total.expected++; if (detected.has(id)) total.detected++;
      categoryTotals.set(defect.category, total);
    }
    cases.push({ id: entry.id, repeat: entry.repeat, evidence: { ...evidence, reviewSha256: hash(reviewBytes), reviewSchemaVersion: review.schemaVersion }, expected: defects.size, detected: detected.size, missed: defects.size-detected.size, detectedDefectIds: [...detected].sort(), missedDefectIds: [...defects.keys()].filter(id => !detected.has(id)).sort(), findings: review.findings.length, supportedFindings, unsupported, contextQuestions, suggestions, actionableSupported, cleanCase: defects.size === 0, cleanCaseFalseAlarm: defects.size === 0 && unsupported > 0 });
  }
  const sum = (key: 'expected' | 'detected' | 'findings' | 'supportedFindings' | 'unsupported' | 'contextQuestions' | 'suggestions' | 'actionableSupported') => cases.reduce((total,c) => total+c[key],0);
  const corpusSha256 = hash(JSON.stringify({ id: run.corpus.id, version: run.corpus.version, generatorSha256, cases: [...corpusCases].sort(([a],[b]) => a.localeCompare(b)) }));
  return { schemaVersion: 'pdf-checkeval-result-1', model: run.model, condition: run.condition, adjudicator: run.adjudicator,
    corpus: { id: run.corpus.id, version: run.corpus.version, generatorSha256, sha256: corpusSha256 }, runSha256: hash(bytes), scorerSha256: await fingerprintFile(fileURLToPath(import.meta.url)),
    limitations: ['Small author-created synthetic sample with manual adjudication; repeats are not independent documents and do not establish generalization.', 'No conformance, accessibility pass, or certification claim.', 'Compare matching corpus fingerprints, page coverage, tier, and adjudication policy; vary only the stated experimental factor; failures and invalid reviews must be reported separately.'],
    totals: { trials: cases.length, uniqueCases: corpusCases.size, expected: sum('expected'), detected: sum('detected'), missed: sum('expected')-sum('detected'), findings: sum('findings'), unsupportedClaims: sum('unsupported'), contextQuestions: sum('contextQuestions'), suggestions: sum('suggestions'), defectDetection: metric(sum('detected'), sum('expected')), unsupportedFindings: metric(sum('unsupported'),sum('findings')), casesWithUnsupportedClaims: metric(cases.filter(c => c.unsupported > 0).length,cases.length), cleanCaseFalseAlarms: metric(cases.filter(c => c.cleanCaseFalseAlarm).length,cases.filter(c => c.cleanCase).length), supportedActionableAdvice: metric(sum('actionableSupported'),sum('supportedFindings')) },
    categories: [...categoryTotals].sort(([a],[b]) => a.localeCompare(b)).map(([category,c]) => ({ category, ...c, missed: c.expected-c.detected, detection: metric(c.detected,c.expected) })),
    repeats: [...corpusCases.keys()].sort().map(id => ({ id, repeats: cases.filter(c => c.id === id).map(c => c.repeat).sort((a,b) => a-b) })), cases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node bench/pdf/score.ts RUN.json');
    console.log(JSON.stringify(await scoreRun(process.argv[2]!), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
