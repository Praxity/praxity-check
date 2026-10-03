# Shared NVDA journeys

Praxity Check owns the Windows screen-reader driver. Studio, the site, and other
repos keep their journey JSON beside their content and call Check. They should
not install their own Guidepup driver or copy the Windows automation code.

From another repo, pass an exported folder or ZIP:

```powershell
node <praxity-check>\src\cli.ts screen-reader .\dist `
  --journey .\accessibility\nvda.json --output <new-output-dir> `
  --take-screen-control
```

`<praxity-check>` is your local checkout of this repository.

For the site's running development server, pass its base URL:

```powershell
node <praxity-check>\src\cli.ts screen-reader http://127.0.0.1:3000/ `
  --journey .\accessibility\nvda.json --output <new-output-dir> `
  --take-screen-control --allow-network
```

`--output` must be a new directory outside the export. Relative journey pages
resolve against the URL's directory or the local export root. Page changes must
stay on that origin. For Studio's exported courses, pass the export directory,
not Studio's source directory. Electron application windows are not supported
yet; the URL and export interface is for browser content.

## Setup and desktop control

Use Node 22.18 or later and the pinned pnpm 11.5.3. Install Check's dependencies
and its matching portable screen reader from this checkout:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm dlx @guidepup/setup@0.29.1 install nvda
```

Guidepup 0.34.0 is pinned because it supports portable NVDA and temporary settings.
The previous 0.24.1 dependency expected the legacy NVDA Remote add-on and lacked
the settings API used by journeys. The downloaded asset is NVDA 2026.2, selected
and hash-checked by Guidepup's manifest. It is separate from installed NVDA.
See [Guidepup's release notes](https://github.com/guidepup/guidepup/releases)
and [machine setup](https://www.guidepup.dev/docs/guides/machine-setup).

Journeys need an interactive Windows desktop and a headed Chromium-family
browser. `PRAXITY_NVDA_BROWSER` can select a Chrome or Edge executable instead
of Playwright's Chromium. For example:

```powershell
$env:PRAXITY_NVDA_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

The command speaks, opens a browser, moves focus, and sends real keys. Quit NVDA
first. Check refuses to take over a running session and serializes its own runs.
It changes only Guidepup's temporary config, directs the NVDA log to the evidence
directory, closes its browser and NVDA, and attempts to restore the original
foreground window. It does not change installed NVDA settings or registry keys.
When the desktop shell or its verified primary taskbar has focus, Check verifies
the browser's process and window handle and tries to acquire it for up to
1.5 seconds. It tries ordinary Windows
activation first, then one bare Alt press if needed. Each attempt checks the input
desktop and held modifiers again. Check never releases a user's held keys or
moves page focus past the address bar.
The Alt fallback uses Windows' documented
[foreground unlock behavior](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-locksetforegroundwindow).
If a security dialog or another application takes focus, the driver stops before
sending further keys. Resolve the interruption yourself before starting a new run.

Local exports default to blocking HTTP requests outside the local server,
service workers, WebSockets, and WebRTC. This uses context routes and
a browser-wide proxy policy, so popup and worker requests are covered too.
`--allow-network` removes these restrictions and is required for URL targets.
Run trusted content. These controls are not a hostile-code sandbox.

## Journey format

```json
{
  "version": 1,
  "name": "Lesson result",
  "start": "index.html",
  "steps": [
    {
      "id": "find-result",
      "intent": "Find the result button",
      "keys": ["Control+Home", "b"],
      "capture": false,
      "waitMs": 1500,
      "expect": { "spoken": ["Show result"] }
    },
    {
      "id": "activate",
      "intent": "Activate and hear the result",
      "keys": ["Enter"],
      "capture": false,
      "waitMs": 2000,
      "expect": {
        "spoken": [{ "text": "Ready to continue", "via": "live" }]
      }
    }
  ]
}
```

Use lowercase letters, digits, or named keys such as `Tab`, `Enter`, `Spacebar`,
`ArrowDown`, `Control+Home`, and `Insert+Spacebar`. Each step has a unique
lowercase ID and an intent. Empty `keys` listens without interrupting speech.
Speech comparisons ignore punctuation and case and match complete words.
`via` describes where browser corroboration should expose the phrase; it does
not prove which announcement channel NVDA used. String expectations use `any`.

`expect` also supports `notSpoken`, `path`, `fragment`, `activeSlide`, `maxWords`,
and `focus` with `role`, `name`, or `notOn`. `path` is a pathname suffix;
`fragment` is exact. `maxWords` is a journey-specific speech budget, not a WCAG
threshold. `requires` checks `path`, `fragment`, `activeSlide`, or `focusedRole`
before a step. `snapshot: true` adds headings and landmarks.

`capture: false` avoids Guidepup's speech-cancelling capture keys. Check paces
each key and waits for its IO-log receipt before continuing. With capture enabled,
the transcript distinguishes Guidepup's harness input from journey input.
`waitFor` replaces `waitMs` and accepts `media-playing`, `media-ended`,
`slide-change`, or `live-text`, plus `timeoutMs` and optional `match`.
`address` types a same-origin page address through NVDA. `setup: true` with an
address instead uses explicit DevTools navigation for setup. `addressDestination`
declares a canonical redirect destination. This version supports navigation,
controls, and address entry; course form text entry is not supported.

## Evidence and exit codes

`journey.json` contains environment metadata, effective settings, records, checks,
speech, and each step's `status`: `pass`, `fail`, or `inconclusive`.
`transcript.md` is the readable speech transcript. `screenshots/`, `settings.json`,
and `nvda-temp/nvda.log` retain corroborating evidence. A startup or cleanup failure
also retains `error.txt` when the output directory has been created.

Exit `0` means every scripted step met its expectations with IO-log evidence.
Exit `1` means at least one expectation failed. Exit `2` means the run was
inconclusive, stopped early, or could not start. Failure classifications distinguish
application defect candidates, compatibility candidates, and cases needing review.
They are evidence for investigation, not accessibility findings by themselves.
An IO speech request does not prove acoustic duration or that a listener heard it.

For callers in the same JavaScript process, import `runScreenReaderJourney` from
`src/screen-reader.ts` and pass `{ target, journey, output, takeScreenControl: true,
allowNetwork: false }`. `journey` is the parsed JSON object; Check validates it.
The returned object has `exitCode`, `jsonPath`, and `markdownPath`. CLI invocation
is the preferred boundary between repos. The common `ScreenReaderDriver` operations
are `start`, `stop`, `press`, `type`, and `getSettings`; NVDA implements that
contract. The existing macOS VoiceOver action command remains available and still
uses Guidepup 0.24.1, which has no `getSettings`. Multi-step journeys currently
require Windows.

## Desktop requirements

Live journeys need an interactive desktop session that nothing else will take
over. If a firewall prompt, security dialog or another application takes
foreground, the run stops with exit `2` rather than sending keys to the wrong
window. On a headless or remote machine, keep the session attached to the
console when Remote Desktop disconnects, because nothing can answer a prompt
there.

The journey browser starts with
`--disable-features=MediaRouter,DialMediaRouteProvider` and
`--disable-background-networking`, as Playwright does, so Chrome's Cast
discovery does not raise a Windows Firewall prompt for each new browser path.
NVDA's Remote Access relay on port 6837 uses Guidepup's well-known key
`guidepup`. Guidepup connects over loopback; block inbound connections to that
port so the relay is never reachable from the network.

## Tests

Unit and headless browser tests run with `corepack pnpm test`. Set
`PRAXITY_NVDA_TEST_BROWSER` to enable the optional headless journey tests.
The real desktop test is opt-in and has strict speech and key-delivery
assertions:

```powershell
$env:PRAXITY_NVDA_LIVE = '1'
$env:PRAXITY_NVDA_OUTPUT = '<new-output-dir>'
node --test test/nvda-live.test.ts
Remove-Item Env:PRAXITY_NVDA_LIVE
Remove-Item Env:PRAXITY_NVDA_OUTPUT
```

The output path must not exist. Without `PRAXITY_NVDA_OUTPUT`, the test retains
evidence in a new temporary directory and prints its transcript path. It checks
the local fixture in `test/fixtures/nvda-driver` and needs no external site.
PDF facts and renders use bundled PDFium wasm. PDF/UA validation still requires veraPDF and Java. Windows packages can include those runtimes.
