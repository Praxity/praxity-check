# 0002: HTML audit isolation and evidence retention

## Status

Accepted. Records existing behaviour; no runtime change.

## Context

Course scripts, network requests and malformed elements must not compromise other pages or erase evidence already collected.

## Decision

- In `src/html-audit.ts`, `auditHtml`, `auditPages` and `createAuditContext` use fresh storage for each initial page and declared state, preserving navigation storage only within that run. A check failure retains completed results and records unchecked coverage. The 60-second check budget begins after navigation, settling, triage and title retrieval. An initial timeout skips its declared states; a scenario timeout allows later states. States concatenate evidence without deduplication. Repeated initial destinations retain evidence but do not count as distinct audited coverage.
- `runChecks` observes motion before interaction and runs viewport/document mutations last. Only the timeout-race winner can merge evidence; late completions cannot alter a returned report. Page and context cleanup failures become notes; browser cleanup must preserve the CLI outcome. Only browser launch and initial context creation reject the whole audit.
- `withAuditBrowser` permits autoplay so browser policy cannot suppress the behaviour being measured. `createAuditContext` blocks service workers from the start. Redirect request listeners supplement route handlers because Chromium can omit interception events; context-specific listeners and counters retain the issuing context.
- In `src/audit-network.ts`, `blockWebRtc` runs before course scripts because the UDP flag alone did not reliably suppress STUN. `blockAuditNetwork` uses a proxy for redirects, workers and tunnels that page routing misses. Each denied wire attempt keeps its own record; browser metadata may enrich but cannot erase it. Malformed proxy URLs are accounted for, invalid redirect locations do not initiate requests, and the proxy bypass subtracts Chromium's implicit loopback exemption before allowing the exact audit origin.
- In `src/serve.ts`, `serve` binds loopback and preserves literal HTML URLs. Redirecting to clean URLs can strand course navigation. `isAuditServerUrl` limits HTTP and WebSocket traffic to this run's origin. `resolveWithinRoot` resolves symlinks before containment; `byteRange` clamps unbounded numerals before number conversion. HEAD describes the full representation; ranges apply only to GET.
- In `src/archives.ts`, `MAX_TOTAL_BYTES` bounds disk use separately from compression-ratio checks; large video courses can legitimately exceed 512 MiB. `RATIO_FLOOR_BYTES` avoids rejecting tiny compressible files. `Limits` allows small fixtures to exercise production boundaries. `asUnsafe` reclassifies yauzl's unsafe-name/size errors, while `safeEntryPath` and `extractZip` enforce path, link, entry and actual expanded-byte limits. Declared sizes are attacker-controlled and cannot replace counting streamed bytes.
- In `src/input.ts`, `snapshotInput` binds evidence to a private copy including assets; `assertOutputOutside` resolves existing parents to reject aliases that could overwrite input. In `src/discover.ts`, `redirect` and `isStub` exclude only immediate redirects with almost no text and no substantive elements; delayed refresh or real content must stay auditable. `MAX_ACTIONS` in `src/scenarios.ts` allows sequential players to reach late slides without starting a new learner session.

Sources: corresponding comments and implementations at `43dbc10`; `test/html-audit.test.ts`, `test/audit-isolation.test.ts`, `test/input.test.ts`, `test/serve.test.ts` and `test/discover.test.ts`. The redirect distinction records the existing interpretation of WCAG technique G110 and criterion 2.2.1.

## Consequences

Changes to these rules require updated evidence and tests through the affected module interfaces. Removing comments does not broaden what the existing checks establish.
