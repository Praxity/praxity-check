# WCAG 2.2 single-defect bench

This directory contains **40** single-defect static HTML pages and clean twins. The set covers **33 distinct WCAG 2.2 Level A/AA success criteria**: 1.1.1, 1.3.1, 1.3.2, 1.3.3, 1.3.5, 1.4.1, 1.4.3, 1.4.4, 1.4.10, 1.4.11, 1.4.12, 2.1.1, 2.1.2, 2.1.4, 2.2.1, 2.2.2, 2.4.2, 2.4.3, 2.4.4, 2.4.6, 2.4.7, 2.4.11, 2.5.2, 2.5.3, 2.5.8, 3.1.1, 3.1.2, 3.2.4, 3.3.1, 3.3.2, 3.3.3, 4.1.2, 4.1.3.

Class spread: 19 runtime-measurable, 10 static-semantic, 9 contextual-judgment,
and 2 assistive-technology-specific cases. The latter two categories are review
examples, not promises of automatic detection.

## Run

From the repository root, serve the files as static content:

```sh
python3 -m http.server 4173 --directory bench/wcag
```

Each case is available at `http://localhost:4173/<id>/defect.html` and
`clean.html`. Evaluate each target independently against its twin; auditing the
parent directory together would mix both versions into one run.

`inconsistent-control-identification/reference.html` is an unscored support page that establishes the second page required by SC 3.2.4. Treat each target as an alternative version in a set with that reference page; do not score the reference itself.

For a structure-only check:

```sh
node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync("bench/wcag/manifest.json"));if(m.length!==40)process.exit(1);for(const x of m)for(const f of ["defect.html","clean.html"])if(!fs.existsSync(`bench/wcag/${x.id}/${f}`))process.exit(1)'
for d in bench/wcag/*/; do diff -u "${d}defect.html" "${d}clean.html" >/dev/null || test $? -eq 1 || exit 1; done
```

Pages involving layout, computed colour, focus, timing, keyboard, pointer, or
accessibility-tree behaviour require a real browser; static inspection is not a
result.

## Sources

Defects were derived from [WCAG 2.2](https://www.w3.org/TR/WCAG22/), the [WCAG 2.2 Understanding documents](https://www.w3.org/WAI/WCAG22/Understanding/), and the [WCAG 2.2 Techniques](https://www.w3.org/WAI/WCAG22/Techniques/). `failureTechnique` is null where no published WCAG Failure technique precisely matches the authored failure.

## Uncertain list (excluded, not scored)

- **1.2.2 Captions (Prerecorded):** excluded because a genuine synchronized-media failure and clean caption twin require an auditable local media asset and verification of caption equivalence.
- **1.3.4 Orientation:** excluded because lock behavior and the essential exception require a capable mobile runtime; CSS-only reorientation messages can be mistaken for an actual lock.
- **1.4.2 Audio Control:** excluded because browser autoplay policy can prevent the purported defect and invalidate first-paint measurability.
- **1.4.13 Content on Hover or Focus, 2.5.7 Dragging Movements, 3.2.1 On Focus, and 3.2.2 On Input:** excluded because their failure state would be behind an interaction, contrary to the bench rule.
- **2.3.1 Three Flashes or Below Threshold:** excluded because flash-area/frequency thresholds cannot be verified statically and deliberately flashing content is unsafe.
- **2.4.1 Bypass Blocks, 2.4.5 Multiple Ways, and 3.2.3 Consistent Navigation:** excluded where a genuine failure requires broader site structure. The included 3.2.4 case has one explicit, unscored top-level reference page to establish its two-page set.
- **3.3.7 Redundant Entry and 3.3.8 Accessible Authentication:** excluded because a single initial page cannot prove previous-entry or authentication-process context without hidden steps.
