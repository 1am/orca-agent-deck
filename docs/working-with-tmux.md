# Working with tmux

Orca tracks agents per Orca pane. tmux hides the agents from Orca's process scan and, by default, gives every agent in a tmux server the pane key of the Orca pane that started the server. Follow this setup so each Orca pane gets its own key on the Stream Deck. Background and upstream status: `docs/known-issues.md` (tmux section).

## Setup

1. **Use the reference config.** `docs/assets/tmux-example.conf` has the whole recommended setup; copy it into `~/.tmux.conf`. It does two things:

   - `update-environment` passes the Orca variables from the attaching client into the session, so the agent's hooks reach Orca. Without them a key stays gray (stablyai/orca#32293). The Setup doctor checks this.
   - `extended-keys on` lets modified keys (Shift+Enter and similar) reach the agent inside tmux. Needs tmux 3.2 or newer.

2. **One tmux session per Orca pane.** Attach each Orca pane to its own session, for example `tmux new -A -s cc`. Sessions share the server, but each gets the environment of the pane that attached it.

3. **One agent per session.** Windows inside a session share its environment, so they share one pane key. Several agents in one session overwrite each other's state on a single key.

4. **SSH hosts need the same config.** tmux on a remote host starts from Orca's shell there, so copy `docs/assets/tmux-example.conf` into the remote `~/.tmux.conf` as well. Without it every agent on that host reports to the pane that started the tmux server.

5. **Start Codex with `codex --no-daemon`.** Codex's shared background server otherwise reports every Codex to one pane, also outside tmux (`docs/known-issues.md`).

6. **Restart the agents** after changing the config or session layout. A running process keeps the environment it started with. A fresh tmux server (`tmux kill-server`) is the safest way to pick up the config.

## Check it

Run inside each tmux session:

```
tmux show-environment ORCA_PANE_KEY
```

Each session must print a different value. `orca worktree ps --json` should then list one agent per pane. If two sessions print the same key, they will still share a key on the deck.

Not yet verified end to end: that `update-environment` gives a session started from a second Orca pane its own key (the check above is the test). Please report the result in an issue.

## Symptom: one key shows every harness

You have several tmux sessions, harnesses in each, and typing in any of them updates the same key. Cause: all sessions inherited one `ORCA_PANE_KEY` from the tmux server, so Orca holds a single agent entry and the last hook wins. Apply the setup above.
