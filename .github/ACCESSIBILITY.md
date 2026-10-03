# Accessibility

Praxity makes tools for people who build and review online courses. Some of
them exist to find accessibility barriers, so we treat a barrier in our own
tools, documentation or generated reports as a bug and fix it ahead of other
work.

This page covers Praxity Check. Other Praxity repositories follow the
[organisation's page](https://github.com/Praxity/.github/blob/main/ACCESSIBILITY.md).

## What we aim for

- Documentation, generated reports and web interfaces meet WCAG 2.2 level AA.
  This is a goal. No one has audited them yet, and we do not claim conformance.
- Every feature works from the keyboard.
- Command-line output reads in order with a screen reader and never relies on
  colour alone.
- Reports and dashboards work in light and dark colour schemes, at 200% zoom
  and at 320 CSS pixels wide.

The [README](../README.md#quick-start) lists the supported runtimes. VoiceOver
evidence works only on macOS.

## Known barriers

Open issues labelled
[`accessibility`](https://github.com/Praxity/praxity-check/issues?q=is%3Aissue+is%3Aopen+label%3Aaccessibility)
list the barriers we know about.

## Report a barrier

[Open an issue](https://github.com/Praxity/praxity-check/issues/new) and start the title with "Accessibility:".
Tell us what you were trying to do, what happened, and the operating system,
browser and assistive technology you used.

If GitHub issues do not work for you, email
[hello@praxity.io](mailto:hello@praxity.io).

Leave out private course content and learner data unless you have permission
to share it.

## A wrong or missed finding

If Check reports a barrier that is not there, or misses one that is, that is a
bug in a check rather than a barrier in Check. Open a normal issue with the
smallest page or PDF that shows it, the command you ran, and the report JSON.

## Contributing

Pull requests that change a report, page or interface should say how the
change was checked with a keyboard and, where it applies, a screen reader.

## Ownership

The Praxity maintainers keep this page and review it when a project's
interface or report format changes.
