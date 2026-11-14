---
name: Bug report
about: Something does not work (install, keys, focus, setup checks)
---

- Agent Deck for Orca version:
- Orca version:
- macOS version:
- Device (Stream Deck model or Stream Deck Mobile):
- Pane type (local / SSH / paired server / tmux):

## What happened

## What you expected

## Steps to reproduce

## Replay scenario (maintainers)

Before this closes: a `test/replay/*.ndjson` scenario that fails when the fix is reverted (revert check in its description, row in the regression catalog in `docs/replay.md`), or one line here on why the bug cannot be simulated.

## Diagnostics

Run `node collect-diagnostics.mjs` (from the release files; in a clone `pnpm diagnostics`) and attach the file it writes. It holds versions and the last log lines, with tokens, home paths and e-mail addresses removed. The logs never contain terminal content. Read it before attaching.
