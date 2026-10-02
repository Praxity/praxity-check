# Live-region capture experiment — 11 August 2026

## Result

VoiceOver + Safari reliably captured live-region speech for one bounded action.
With a clean comparison, it also distinguished one announcement from the same
announcement spoken twice.

## Method

The first controls used the same button and visible update with:

- a pre-existing empty `role="status"` region;
- the same element without live-region semantics; and
- a `role="alert"` positive control.

Each accepted run opened the local page in Safari, proved that VoiceOver was in
the named web content, activated the button, read VoiceOver's last phrase for six
seconds, and used the changed page title as separate proof that the action ran.

The duplicate follow-up used two automatic controls so keyboard feedback could
not create the difference. The clean control updated one status region once.
The defect control updated two status regions with the exact same text, one
second apart. The run recorded VoiceOver's local speech-start timing as well as
its last-phrase text. It did not record or transcribe audio.

Environment: macOS 26.5.2 (25F84), Safari 26.5.2, VoiceOver, and Guidepup
0.24.1.

## Results

| Control | Accepted runs | Result |
| --- | ---: | --- |
| `role="status"` | 3/3 | Result phrase captured in 516–551 ms |
| No live-region role | 3/3 | Visible result occurred; result phrase was absent for six seconds |
| `role="alert"` | 1/1 | Result phrase captured in 511 ms |

The duplicate follow-up also passed all three pairs:

| Control | Accepted runs | Speech starts per run |
| --- | ---: | --- |
| One status update | 3/3 | 1, 1, 1 |
| Same status text sent twice | 3/3 | 2, 2, 2 |

Every run entered the named web content and changed its title to the expected
result. The [recorded timings](duplicate-results.json) show the second speech
start about 2.36 seconds after the first in each duplicate run.

Polling the last-phrase string alone was not enough. That value can move through
queued context and later return to an earlier phrase even when no new speech
starts. The speech-start signal supplied the missing count.

## How to use this evidence

Use this for one exact interaction where the resulting speech is the question.
Record the browser and screen-reader pairing, prove that VoiceOver is in the
expected page, and separately prove that the action occurred.

For duplicate speech, compare the suspected interaction with a clean version
that announces the phrase once. A speech start has no phrase text and can also
come from unrelated VoiceOver output. The macOS speech-start stream is not a
documented VoiceOver interface, so this remains an experiment rather than a
general CLI check.

Apple documents that VoiceOver can speak live regions while focus is elsewhere
on the webpage. See Apple's guides to [webpage live
regions](https://support.apple.com/en-md/guide/voiceover/vo34654/10/mac/26)
and [the last spoken phrase](https://support.apple.com/en-md/guide/voiceover/vo2725/10/mac/26).
