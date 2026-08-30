# Selected ACT fixtures

These fixtures compare two Praxity Check native rules with representative cases
from the official ACT test-case feed:

- `oj04fd` → `focus-visible`
- `0ssw9k` → `scroll-region-keyboard`

`pnpm bench` runs them through the same CLI used for the WCAG defect/clean
fixtures. The manifest pins the upstream case IDs and the SHA-256 of the source
feed retrieved on 2026-08-29. It records expected Praxity output separately from
the ACT expectation, so a known discrepancy remains visible.

Both mappings are **partial**. This is regression evidence, not an ACT
implementation report or a claim of ACT consistency. The fixture subset does
not establish that Praxity Check implements every applicability, expectation,
or assumption in either ACT rule.

The focus fixtures add only a `<main>` wrapper. Praxity Check intentionally
declines to audit pages with under 40 characters and no landmarks, while the
upstream focus examples are tiny fragments. The test target and upstream assets
are otherwise unchanged. The scroll fixture content is unchanged apart from a
final newline.

Copied material is covered by [LICENSE.md](LICENSE.md).
