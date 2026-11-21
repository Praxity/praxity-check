# 0007: Package payload and portability

## Status

Accepted. Records existing behaviour; no runtime change.

## Context

Standalone and portable packages must retain licensing evidence without adding unused native tools or rewriting binary data.

## Decision

- In `scripts/package.mjs`, `packageArtifact` accepts a runtime inspector so foreign-target layouts can be tested without executing foreign binaries. Linux keeps the existing POSIX packaging path. Portable dependency copying omits Playwright dashboard/inspector/trace assets because Check uses the browser API, and omits the macOS watcher used only by Playwright's test runner.
- The nested `dependency` function uses npm's recorded gitHead for axe source links when an upstream release has no version tag. The nested `inventory` function rewrites line endings only in verified UTF-8 text, rejecting NUL-containing data because UTF-16 without a BOM can decode as UTF-8. Payload and provenance manifests cannot hash each other cyclically.
- In `scripts/windows-pe.mjs`, `systemDlls` contains OS components, not compiler redistributables such as vcruntime140. In `src/node-runtime.ts`, `requireNode` accepts the version-range format owned by package.json instead of introducing another range policy.

The npm package ships compiled `lib/` JavaScript because Node refuses to strip TypeScript types from files under `node_modules`. Its `prepack` step reuses the transpilation in `scripts/package.mjs`, so the installed bin needs no TypeScript loader. The CLI checks `package.json`'s `engines.node` range before loading command modules and refuses unsupported Node versions, keeping direct and npm invocation within the same supported runtime range.

Sources: corresponding comments and implementations at `43dbc10`; `scripts/package.test.mjs` and `test/node-runtime.test.ts`.

## Consequences

Changes to these rules require updated evidence and tests through the affected module interfaces. Removing comments does not broaden what the existing checks establish.
