# PDF review controls

Run `python3 bench/pdf/generate.py /tmp/pdf-controls` with Poppler on PATH and a new output directory. The dependency-free generator writes two pairs of two-page PDFs, page images and separate ground-truth files. The controls test print review, not PDF/UA conformance; they use an unembedded standard font and have no tags.

Prepare each PDF with Check's `prepare-review --checks design --tier inference --focus visual`. Give the reviewer only its bundle. Keep the generator, control names and ground-truth file outside its review context. Record the exact model, effort, prompt, PDF hash and pages inspected.

Compare findings against the four planted defects, including page accuracy and unnecessary changes to the intentional writing and pause areas. Review the clean control for false alarms. A second run is needed before treating an initial result as repeatable.

The original `flawed.pdf` and `clean.pdf` worksheet pair is unchanged. The `reference-flawed.pdf` and `reference-clean.pdf` pair adds grayscale routing instructions and separately distributed table pages. Its two planted defects are missing redundant route labels and missing continuation headers with units. Ordinary line-end hyphenation, different type sizes for distinct roles, and reserved blank space are negative cases. See `reference-ground-truth.json` after reviewing; do not expose it to the reviewer. The new pair is suitable for visual and usability trials.

Canonical inference bundles request `pdf-review-4`, with selected check domains, a domain on each finding and `bundleSha256` binding the exact manifest. Versions 1–3 remain supported for frozen benchmark material. Legacy visual/usability commands still request `pdf-review-2`. Record `observed-defect`, `needs-context`, and `suggestion` separately, alongside evidence, reader consequence and proposed verification. An observed defect remains a model inference. Compare defect detection, unsupported defect claims, unresolved context, and unnecessary suggested changes separately; prompt/schema tests do not establish review quality. Version 1 imports remain supported and normalize to `needs-context`.

The controls paraphrase principles from [W3C on use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) and [table relationships](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6). They are original synthetic cases, not reproductions of published documents. A model's visual finding does not establish WCAG or PDF/UA conformance.

For a repair trial, supply only the flawed generator and its findings. Preserve the original PDF. Regenerate, check again and inspect every changed page against the defect key. A lower finding count alone does not prove a repair. Keep downloaded documents, model transcripts and evaluation reports outside the repository.

## Manual CheckEval scoring

Run `node bench/pdf/score.ts /tmp/trial/run.json` on Node 22.18 or later. The command writes descriptive JSON to stdout and exits 2 on invalid input. Model execution and manual adjudication stay with the caller. Report failed model calls and rejected reviews separately, including their count and attempted-trial denominator; do not quietly drop them from a model comparison.

A run uses this shape. File paths resolve relative to `run.json`; artifact paths resolve relative to the bundle manifest. Keep evidence and run files outside this repository.

```json
{
  "schemaVersion": "pdf-checkeval-1",
  "corpus": { "id": "worksheet-controls", "version": "1", "generatorPath": "generator.py" },
  "model": { "id": "exact-model-id", "effort": "low" },
  "condition": "original-page-images",
  "adjudicator": "human-reviewer-id",
  "cases": [{
    "id": "worksheet-flawed", "repeat": 1,
    "pdfPath": "input.pdf", "manifestPath": "bundle/manifest.json",
    "reviewPath": "review.json", "promptPath": "bundle/review-prompt.md",
    "runPromptPath": "actual-run-prompt.txt",
    "expectedDefects": [{ "id": "overlap", "category": "layout", "page": 1 }],
    "adjudications": [{
      "findingIndex": 0, "verdict": "supported-defect", "defectIds": ["overlap"],
      "actionable": true, "reason": "The reference image confirms the overlapping labels."
    }]
  }]
}
```

Every finding needs exactly one zero-based `findingIndex` adjudication. Verdicts are `supported-defect`, `unsupported`, `context-question`, or `suggestion`. Only supported defects map expected defect IDs, and each mapping must match the finding's page. Two findings identifying the same defect detect it once. Use `expectedDefects: []` for a clean control. Record a concrete reason for each judgment; the scorer checks consistency, not whether the human judgment is correct. Model-authored v2 categories do not determine adjudicated verdicts. Both production review schema versions are accepted through the production validator.

`actionable` records whether the advice is useful according to the adjudicator. The supported-actionable-advice denominator is the number of supported findings, including duplicate findings. This measures advice quality among those findings, not repair success. Defect detection counts unique expected defects per trial. Unsupported claims, cases with unsupported claims, clean-case false alarms, context questions, and suggestions are separate. A clean-case false alarm requires an unsupported claim; a context question alone does not count. Every ratio includes its numerator and denominator and is null when the denominator is zero. No combined score or model ranking is produced.

The scorer reuses production validation for the actual PDF hash, bundle version, selected pages, artifact hashes and review focus/domains. Version 4 also binds the exact manifest hash, and its bundle requires facts hashes. The scorer additionally checks the review model and exact coverage. All expected defects must be on selected pages; partial coverage cannot silently reduce the expected-defect denominator. It hashes extracted facts, review files, manifests, prompts, the generator, and the scorer source. Add optional `preprocessingManifestPath` to a case to record preprocessing. This JSON object requires `artifacts: [{"path": "tiles/page-1.png", "sha256": "actual-file-sha256"}]`. Paths resolve relative to that manifest. The scorer verifies every listed artifact hash and fingerprints the manifest; other configuration fields are retained as opaque evidence. It does not verify that the transforms were performed as claimed or that the artifact list is complete. Evidence must be regular files no larger than 64 MiB.

The corpus fingerprint covers the corpus ID/version, generator bytes, unique case IDs, PDF hashes, and expected defects. It excludes repeat count, model, prompt and preprocessing so matched conditions can be compared; match page coverage, tier, and adjudication policy too, varying only the stated experimental factor. Compare the separate evidence hashes to check what changed. Repeats of one case must use identical evidence within a run. Different corpus fingerprints are not directly comparable. Use the same adjudication policy across conditions and retain the individual trial results. These author-created synthetic controls and manual judgments do not establish performance on independent documents, statistical confidence, accessibility conformance, or certification.

Run the synthetic scorer check with `node --test bench/pdf/score.test.ts`.

## Expanded comparison corpus

`python3 bench/pdf/expanded.py /absolute/new/corpus` generates 12 original matched pairs: 24 PDFs and 36 planted defects. Clipping, overlapping labels, low text contrast, small essential text, color-only meaning and missing table context each have six examples across different document purposes. The corpus includes landscape and two-page documents. `private-key.json` contains pair identities and drawing facts for adjudicators only. Reviewers receive one PDF's prepared bundle and its `useContext`; never the key, generator, counterpart or other reviews.

The current generator produces corpus version 2. It adds a stock-code entry field to both stock-order variants after a version 1 control ambiguity was discovered. Preserve the original generator and PDFs when reproducing a frozen version 1 comparison; do not substitute regenerated version 2 PDFs into earlier scores.

Audit every rendered page before freezing a comparison. Hash the generator, PDFs, key, bundles and prompts before model calls. Keep pilot cases out of a fresh comparison, preserve every failed attempt, and do not change controls or prompts after looking at results. These sparse synthetic documents reuse defect mechanisms; six occurrences do not establish generalization to arbitrary PDFs. They deliberately share untagged, unembedded-font structure and are unsuitable as PDF/UA pass controls.

`python3 bench/pdf/run.py PLAN.json NEW_OUTPUT_DIR` runs fresh Codex CLI sessions on macOS. The plan specifies `seed`, `models: [{id, effort}]`, `cases: [{id, bundlePath}]` and `protectedPaths`; optional fields are `workers` (1–3), `repeats` (default 1), `timeoutSeconds` (default 600) and `codexPath`. Set an absolute Codex path when the shell's Node is unsuitable. The output directory must be new and outside protected paths.

The runner copies only bundle artifacts into neutral trial directories, fixes the randomized trial order, disables user configuration and rules, and retains commands, hashes, timings, logs and outputs. Its outer macOS sandbox denies reads and writes of protected keys, source bundles and other trials, and denies changes to the current bundle. Codex runs with its inner sandbox disabled to avoid nested macOS sandbox failures; the outer profile supplies these restrictions. Unlisted filesystem paths remain accessible for ordinary CLI runtime operation. Add repositories, source corpora, prior experiments, research, agent histories and skills to `protectedPaths`. Sentinel checks must prove protected reads/writes are denied and the current bundle remains readable before each model call. Before a comparison, verify shell and image tools through the actual CLI on unrelated synthetic evidence; a shell-only preflight cannot catch every harness failure. The runner does not provide complete network isolation: provider access remains available, and logs still need inspection for outside-source use. A syntactically valid JSON result is not yet a valid review; use the production validator and scorer.

The per-trial prompt supplies the requested model identifier for `reviewer.model`; model self-identification is not authoritative. Creating `OUTPUT/CANCEL` cancels queued trials while active trials finish or reach their timeout. `runner.pid` records the process started by the runner.

Adjudicate with model identifiers hidden, using the same policy for every model. Report attempted, valid, failed and contaminated trials alongside detection and false alarms. Preserve the frozen answer key if an unexpected real defect is discovered, and document any exclusion symmetrically across models. Run the local checks with `python3 bench/pdf/expanded.test.py` and `python3 bench/pdf/run.test.py`.

For an evidence comparison, add `--design-evidence` only to the enriched condition. The runner copies and locks its listed XML, JSON and PNG artifacts, verifies their hashes and rejects duplicate or unexpected filenames. The scorer checks these hashes and matches canonical review domains and focus to the bundle. Keep the shared prompt, schema, original images, facts and task context identical across conditions. Use a fresh corpus after inspecting results; preserve original frozen sources when replaying old comparisons.
