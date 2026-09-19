# Praxity Check evidence and Studio adoption plan

Historical plan, completed for Praxity Check on 2026-08-29. This document
records that work and its Studio handoff. It is not the current release roadmap.
Use [the usage guide](using-it.md) for current commands.

**Updated:** 2026-08-29

## Objective

Make Praxity Check's results reproducible and explicit about what was tested,
then use the same evidence vocabulary in Praxity Studio without coupling the
two products or overstating automated conformance.

This plan covers three consumers:

1. Praxity Check scans of rendered learning output.
2. Praxity Studio's fast, source-aware checker and accessibility-review UI.
3. Studio's authoring-UI agents and published-output verification.

The final phase runs the enhanced checks against Studio's generated static,
islands, and legacy output and assigns defects to the lowest shared runtime
seam.

## Decisions

- Praxity Check owns rendered-output scanning, its report schema, browser
  scenarios, and scan coverage.
- Studio's embedded checker stays in `packages/editor-core`. It adopts the
  vocabulary below, but does not import Praxity Check or a browser engine.
- Studio's `/a11y` workflow remains the authority for authoring-UI review.
  ACT can improve evidence for web rules; it cannot replace ATAG review,
  browser coverage, assistive-technology testing, or human judgment.
- The Studio output suite keeps Chromium and WebKit. Praxity Check adds its
  eLearning-specific probes; it does not replace that suite.
- Do not integrate HTML_CodeSniffer or Pa11y. Borrow only the useful concepts:
  standards references and named, declarative test actions.
- Do not generate an accessibility statement or a conformance percentage.
  Align report categorization through schema v4.
- Keep WCAG 2.2 A/AA as the default scope. Treat enhanced-contrast or other AAA
  checks as an explicit, non-blocking Studio readability experiment until the
  product policy says otherwise.
- Evaluate the Nu HTML Checker only as an explicit local source-conformance
  companion. Do not bundle it or mix its messages into accessibility findings.
- Do not create a shared package yet. The report schema is the contract;
  Studio can use the same field meanings in its own types.

## Evidence model

Schema v4 must keep three independent questions independent:

| Field | Values | Meaning |
| --- | --- | --- |
| `outcome` | `passed`, `failed`, `cantTell`, `inapplicable`, `untested` | What the evaluation established for one rule, target, and state |
| `comparison` | `new`, `existing` | Whether an occurrence is present in an explicit baseline |
| `disposition` | `unreviewed`, `accepted`, `falsePositive` | A human decision about an occurrence that still exists |
| `changes.resolved` | occurrence records | Baseline occurrences that are absent from the current result |

Rules for these fields:

- A finding can be `failed` and `accepted` at the same time. Acceptance does
  not rewrite the test result.
- `resolved` describes a change between runs, not a reviewer disposition.
- `new` and `existing` are absent when no baseline was supplied.
- `accepted` and `falsePositive` require a reason. Shared or CI baselines also
  require an owner and review date; Studio's local authoring UI may leave those
  fields optional because it is account-free.
- `passed` and `inapplicable` are emitted only when the rule implementation can
  distinguish them. Silence is not a pass.
- Scan exceptions, excluded targets, unsupported states, closed shadow roots,
  and cross-origin frames are represented as `untested`, not hidden in notes.

Each rule also needs machine-readable metadata:

- stable rule ID, source, and ruleset version;
- `kind`: `conformance`, `advisory`, or `contentQuality`;
- WCAG criterion and level where applicable;
- ACT rule ID only where the implementation is genuinely mapped;
- confidence, test mode, assumptions, and applicable target/state.

`findings` remain occurrence-level evidence. `needsReview` remains the
reviewer-facing collection for `cantTell`. A rule-evaluation collection records
the outcomes needed to distinguish failures, passes, inapplicability, and
missing coverage.

## Praxity Check work

### 1. Make the existing fixture corpus executable

- Extend the current fixture manifest with expected Praxity rule IDs and the
  expected result for each defect/clean pair.
- Add one `pnpm bench` command that fails on a missed expected defect, a finding
  in its clean pair, or an unexpected change in a deliberately partial rule.
- Report the existing `yes`, `partial`, and `no` detectability classifications
  rather than treating all fixtures as equivalent.
- Correct the stale `heading-order` comment while touching the axe setup.

**Exit:** all 40 existing pairs run deterministically and rule changes have a
small regression gate.

**Completed 2026-08-29:** `pnpm bench` compares isolated defect and clean
batches against manifest rule expectations. It also reports current gaps by
`expectedDetectable` class. The first run removed a false positive caused by
treating Chromium's unmodified focus ring as author styling.

### 2. Introduce report schema v4

- Add the evidence fields and rule metadata defined above.
- Record browser, engine, engine version, viewport, state, ruleset, and scope
  coverage once per relevant evaluation rather than repeating prose notes.
- Query axe's rule metadata after injection so its WCAG tags and ACT IDs are
  preserved instead of reconstructed from prose.
- Give occurrences a deterministic identity derived from rule, page, target,
  and state. Keep evidence separate from identity so a better excerpt does not
  manufacture a new issue.
- Preserve a documented v3-to-v4 migration path for report consumers.

**Exit:** schema fixtures prove all five outcomes, missing coverage, structured
requirements, and stable occurrence identity. No field implies a pass rate or
conformance score.

**Completed 2026-08-29:** schema v4 retains the existing result arrays and adds
stable occurrence IDs, named states, environment and ruleset versions, axe ACT
metadata, structured rule evaluations, and explicit untested checks. The
[migration guide](report-schema-v4.md) documents the compatible fields and the
new evidence model.

### 3. Add named states and honest DOM coverage

- Let a scan declare a small list of safe actions such as click, press, select,
  and wait-for. Do not accept arbitrary JavaScript.
- Run each declared state as a separate evaluation and restore or reload before
  the next state.
- Traverse open shadow roots and same-origin frames where the engine supports
  them. Record closed roots and cross-origin frames as untested scope.
- Reuse the existing interaction-review environment record rather than create
  a second environment model.

**Exit:** a shell course can be started and at least one revealed lesson state
is scanned; unsupported scope appears as structured coverage.

**Completed 2026-08-29:** `--scenarios` accepts bounded click, navigation-key,
selection, and visible-selector actions. Each state starts in a fresh page and
failed actions become `untested`. Axe's same-origin frame and open-shadow
coverage is verified; native-check frame and shadow limits are structured, and
closed roots are counted before page code hides them. Output validation also
proved that a scroll probe must stop its arrow key at the region boundary;
otherwise a document-level page shortcut can navigate midway through a scan.

### 4. Validate selected native rules with ACT cases

- Start with approved ACT rules that match current native behavior, especially
  visible focus (`oj04fd`) and scrollable-region keyboard accessibility
  (`0ssw9k`).
- Pin the selected fixture revision and retain the W3C Software and Document
  Notice and License with copied cases.
- Keep proposed ACT rules and partially consistent implementations labelled as
  such. Do not claim ACT conformance or submit an implementation report until
  applicability, expectations, and consistency have been demonstrated.

**Exit:** selected ACT cases run through the normal benchmark and discrepancies
are documented as implementation limits, not massaged into passes.

**Completed 2026-08-29:** eight pinned, licensed fixtures cover representative
passed, failed, and inapplicable cases for `oj04fd` and `0ssw9k`. Seven are
consistent. The manifest preserves the known modal/inert-region discrepancy,
and both native mappings remain labelled partial rather than gaining ACT IDs.

### 5. Add exact baselines and review dispositions

- Compare deterministic occurrences, not rule counts or wildcard allowances.
- Keep accepted and false-positive occurrences visible in machine output.
- Require the review metadata described in the evidence model.
- Report resolved occurrences separately from current findings.

**Exit:** adding a second occurrence of an accepted rule is reported as new,
and an accepted occurrence cannot silently hide unrelated growth.

**Completed 2026-08-29:** `--baseline` accepts a validated prior schema-v4
report. Exact occurrence IDs produce `new`, `existing`, and `changes.resolved`;
accepted and false-positive decisions require reason, owner, and review date.
Decisions remain visible and never rewrite outcomes or CLI gating. Stable block
structure is used instead of Mantine's random per-mount IDs, so unchanged
rendered controls retain their occurrence identities across scans.

### 6. Test the optional validator boundary

- Tested Nu 26.8.29 as a verified, temporary external binary against current
  Studio static, islands, and comprehensive legacy HTML exports.
- It found three shared source defects that rendered checks missed: malformed
  meta-refresh values, missing language metadata on redirect shims, and a
  percentage value in an iframe `width` attribute. Studio fixed them at the
  shared generators and added regressions.
- After the fixes, static and islands exports had no errors. The legacy export
  retained one heading-order error already reported by axe, plus warnings for
  deliberate iframe sandbox permissions and redundant list roles.
- Do not add `--vnu`, bundle Nu, or require Java. The unique defects now have
  direct tests, while routine Nu output would duplicate axe and require
  policy-specific filtering. Use Nu manually when investigating generated HTML
  conformance.

**Exit:** complete. Nu remains an occasional development diagnostic, not a
Praxity Check engine.

## Studio handoff

Studio implementation and generated-output validation are tracked in the
sibling repository at `rootstock/docs/tasks/plan-studio.md`. That work starts
after phases 1–5 here establish the evidence contract. Studio adopts the field
meanings without importing Praxity Check; output validation follows the Studio
checker and agent alignment.

## Deferred until evidence demands them

- an accessibility-statement generator;
- a conformance percentage or synthetic accessibility score;
- a general AAA mode or unconditional enablement of axe's disabled AAA rules;
- ACT implementation-list submission;
- bundled validator binaries or Java runtime;
- a shared cross-repository schema package;
- arbitrary scripted actions;
- HTML_CodeSniffer or Pa11y dependencies.

## Primary references

- [ACT Rules Format 1.1](https://www.w3.org/TR/act-rules-format/)
- [Nu HTML Checker](https://github.com/validator/validator)
- [HTML_CodeSniffer](https://github.com/squizlabs/HTML_CodeSniffer)
- [Pa11y](https://github.com/pa11y/pa11y)
