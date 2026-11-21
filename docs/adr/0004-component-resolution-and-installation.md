# 0004: Component resolution and verified installation

## Status

Accepted. Records existing behaviour; no runtime change.

## Context

Runtime selection must match upstream launchers, while installation must consume pinned bytes and preserve damaged installations for inspection.

## Decision

- In `src/components.ts`, `veraPdfJavaArgs` shares installer/validator arguments. `validatorSelection`, `veraPdfCommand`, `javaEnvironment` and `veraPdfEnvironment` preserve platform-specific launcher behaviour: only Windows defaults to direct Java; an explicit executable selects a wrapper; empty overrides mean no selection. POSIX wrappers retain inherited JVM options and choose their own Java. The managed installer may use managed Java.
- `posixJavaHome` and `executablePath` follow veraPDF 1.30.2: POSIX uses JAVACMD, JAVA_HOME (IBM jre/sh/java before bin/java), then PATH; Darwin/Gentoo discovery falls through to PATH on an empty result. The Windows batch launcher ignores JAVA_HOME, while VERAPDF_JAVA belongs to Check's direct launcher. Optional inaccessible candidates fall through. `resolveComponent` gets a validator's version from JSON instead of requiring a wrapper version command.
- `playwrightVariable`, `browserCache` and `browserLayout` match installed Playwright semantics. Only undefined falls through to npm aliases; cache value "0" means package-local, empty means OS cache, and relative paths resolve from INIT_CWD or the working directory. Existing caches remain usable without setup. Runtime lookup uses Playwright's executable table, independently of pinned download entry points.
- `browserTarget` matches Playwright host detection: Windows architectures use win64; macOS 11+ uses Apple's CPU models, including x64 Node under Rosetta. `componentManifest` detects installation targets independently of environment overrides.
- In `src/setup.ts`, `downloadVerified` publishes only hash-verified bytes and returns that same buffer, avoiding a later cache-path substitution. `installPlaywright` serves verified archives over loopback to the official installer, including offline use. Its environment allowlist and explicit direct/npm aliases prevent inherited mirrors, proxies or Node hooks from bypassing verification.
- `selectedComponents` orders Java before veraPDF's headless installer. `setup` never silently replaces an existing version, preserves damaged installations and resolves selections after publication because explicit overrides can still win.
- In `src/archives.ts`, `entryPath`, `tarArchive` and `extractComponentArchive` enforce filesystem containment even for pinned archives. Temurin's internal licence links become copies of internal regular files; filesystem links are never created, and every copied byte is charged against the extraction cap.

Sources: comments and implementations at `43dbc10`; Playwright 1.62.1 `packages/utils/env.ts`, `packages/utils/hostPlatform.ts` and the server/registry implementation, retained in the installed `playwright-core/lib/coreBundle.js`; veraPDF 1.30.2 `verapdf` and `verapdf.bat`; `test/components.test.ts` and `test/setup.test.ts`. Download-hash provenance is retained in `NOTICE.md`.

## Consequences

Changes to these rules require updated evidence and tests through the affected module interfaces. Removing comments does not broaden what the existing checks establish.
