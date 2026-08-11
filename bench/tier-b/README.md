# Tier B controls

The tab files use the same recognised component markup with three behaviours:
missing arrow operation, automatic activation, and W3C-style manual activation.
A useful Tier B packet must expose those differences in before/action/after
traces without declaring any result a finding itself.

The native-select control verifies that the packet labels native popup and
keyboard behaviour unexercised instead of treating headless-browser silence as
a product failure.

The state/context control verifies that each trace-bearing candidate is reset
before later evidence is captured, and that a disclosure packet includes its
heading ancestor rather than only the button fragment.
