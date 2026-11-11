---
name: Wrong agent state on a key
about: A key shows the wrong state (stays grey, never turns green, wrong harness)
---

- Agent Deck for Orca version:
- Orca version:
- Harness and version (Claude Code / Codex / Pi):
- Pane type (local / SSH / paired server / tmux):

## What the key showed

## What the agent was doing

## Does Orca show the right state for that pane?

Check Orca's sidebar or `orca worktree ps --json`. If Orca is wrong too, the cause is upstream: see `docs/known-issues.md`.

## Diagnostics

Attach the file from `node collect-diagnostics.mjs` (from the release files; in a clone `pnpm diagnostics`).
