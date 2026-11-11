# Troubleshooting

Find the symptom, check the cause, apply the fix. Status key captions come from the Setup check; the Status key shows the worst problem first. Upstream Orca limits are in [known-issues.md](known-issues.md); tmux setup is in [working-with-tmux.md](working-with-tmux.md).

## Status key

### "Orca not running" (value OFF)

- **Cause.** Orca is closed, still starting, or its runtime socket is not ready.
- **Check.** Is Orca open and running as the same macOS user as the Elgato app?
- **Fix.** Open Orca. The deck reconnects on its own. Pane keys show "offline" meanwhile.

### "Orca x.y.z too old"

- **Cause.** Orca is older than 1.4.245. The Orca plugin itself needs Orca 1.4.246 or newer.
- **Fix.** Update Orca.

### "orca CLI not found"

- **Cause.** The `orca` command was not found at `ORCA_BIN`, in the Orca app bundle, or in `/usr/local/bin` or `/opt/homebrew/bin`. A login shell is not consulted, so a `PATH` set only in your shell profile is not seen.
- **Check.** `ls /Applications/Orca.app/Contents/Resources/bin/orca`, or `which orca` in a terminal.
- **Fix.** In Orca, register the CLI (Settings, register CLI). If `orca` lives elsewhere, set `ORCA_BIN` to its full path in the environment the Elgato app starts with, then restart the Elgato app. The deck mostly reads Orca over its runtime socket, so this matters most for paired-server panes and as a fallback.

### "slow link (CLI)"

- **Cause.** The runtime socket is not answering, so every read spawns the `orca` CLI (150-230 ms each).
- **Check.** The plugin log says why (see Logs in [install.md](install.md)).
- **Fix.** Restart Orca. Check that Orca 1.4.246 or newer runs as the same user as the Elgato app.

### "slow updates" (grey OK)

- **Cause.** The Orca plugin is not connected, so status is polled instead of pushed.
- **Check.** Look for a second check, "Install the Orca plugin" or "Update Agent Deck for Orca". Orca stops the plugin worker after about 10 minutes without agent events; that is normal and not shown as a fault, and the worker reconnects on the next event.
- **Fix.** See the next two entries.

### "Install the Orca plugin"

- **Cause.** Orca reports the Orca plugin as not installed or disabled (it has not connected since the Stream Deck plugin started). A plugin that is installed but has not woken yet is not shown as missing.
- **Check.** In Orca run "Agent Deck: Show status", then read `~/.orca-deck/plugin-a.log` (Windows: `%APPDATA%\orca-deck\plugin-a.log`). Check Orca Settings, Plugins.
- **Fix.** Press the Status key, open the Setup tab and click "Install the Orca plugin" (it opens `orca://plugins/1am.agent-deck?catalog=https://github.com/1am/orca-agent-deck.git`), or follow Quick start step 2 in [install.md](install.md), and enable it. Start or finish a turn in an agent so Orca wakes it. If the Elgato app was restarted after Orca, the plugin reconnects with a backoff of up to 30 s.

### "Update Agent Deck for Orca"

- **Cause.** The Orca plugin and the Stream Deck plugin speak different bridge versions (one is older than the other, or an Orca plugin from before the handshake), so they cannot connect. The Orca plugin logs "update Agent Deck for Orca" and the Show status toast starts with it.
- **Fix.** Update the older one. Both plugins must come from the same release.

### "tmux env missing"

- **Cause.** tmux does not pass Orca's hook variables to sessions, so agents inside tmux report no status.
- **Fix.** Add to `~/.tmux.conf` the `update-environment` lines from `docs/assets/tmux-example.conf`, then run `tmux kill-server` and start tmux again. Details: [working-with-tmux.md](working-with-tmux.md). The check needs a running tmux server and `tmux` in `/opt/homebrew/bin`, `/usr/local/bin` or `/usr/bin`; otherwise it is skipped.

### "no panes mapped"

- **Cause.** No Pane key holds a pane yet.
- **Fix.** Focus a pane in Orca and hold a free Pane key, or pick a pane in the key's settings.

## Pane keys

### Key stays grey

- **Cause.** Grey has several meanings. Dark grey "empty": no pane assigned. Dim grey "offline": Orca is closed or the pane is gone. Grey "idle": the pane is there but reports no agent activity. Dim grey "host down": an SSH host or paired server is unreachable; the key keeps its pane.
- **Check.** Read the second line of the key. For "idle" with an agent running inside tmux, see [working-with-tmux.md](working-with-tmux.md).
- **Fix.** Per cause: assign a pane, open Orca, wait for the host to reconnect (after a sleep this can take about 3 minutes), or fix the tmux setup.

### Key never turns green

- **Cause.** Green means an agent turn finished. Orca reports no status when its hook variables are missing, typically for agents in a tmux server started outside Orca (stablyai/orca#32293). Green also clears once you press the key or focus the pane in Orca.
- **Check.** Run "Agent Deck: Show status" and look at the Status key for "tmux env missing". Check in Orca that agent hooks are on for the harness. Run `orca worktree ps --json` and look for the agent.
- **Fix.** [working-with-tmux.md](working-with-tmux.md). A shell pane (no agent) shows "done" only after it has printed continuously for about 8 seconds and then stopped.

### Shell pane never shows working

- **Cause.** A pane without an agent shows an activity indicator only when it is pinned to a key. The key shows "working" once the pane has printed continuously for about 8 seconds, and "done" (green) when the output stops, until you press the key or focus the pane in Orca. Quick commands never show. Orca reports no exit status for a shell, so a finish is always "done", never failed; a process that exits non-zero closes its pane and shows as an error. A pane that prints all the time (`tail -f`, `watch`) stays on working.
- **Fix.** Pin the pane with the picker or a hold, then run a long command in it.

### Wrong harness badge, or a stale "tmux" label

- **Cause.** Orca finds agents by walking the process tree under the pane's shell. tmux runs outside that tree, so the pane may read `tmux` and the badge can lag after you swap the agent (stablyai/orca#7797). Several agents in one tmux server also share one pane key and overwrite each other.
- **Fix.** One agent per tmux session, one tmux session per Orca pane. See [known-issues.md](known-issues.md).

### Keys are shuffled or empty after a reinstall

- **Cause.** Mappings are stored by the plugin per key. A reinstall can give keys new internal ids, so the plugin carries a mapping over to the new key at the same device position when exactly one old key sat there (not verified on a real reinstall; keys on several pages at the same position cannot be told apart). Keys that get no mapping stay empty: pin them again. A mapping is released when its pane has been gone for 24 h.
- **Fix.** Pin the panes you care about: focus the pane in Orca and hold a Pane key, or use the picker in the key settings.

### Nothing happens when I press a key

- **Cause.** Pressing focuses the pane in Orca and raises the Orca window. Raising works on macOS and on Linux under X11 with `xdotool` or `wmctrl` installed. On Windows and on Wayland the pane is focused but the window stays where it is.
- **Check.** The key flashes an alert on failure. The Stream Deck plugin log has one `press` line per press with the result.
- **Fix.** On Linux, install `xdotool` or `wmctrl` (`sudo apt install xdotool`), restart the Stream Deck software, and check that `echo $XDG_SESSION_TYPE` prints `x11`. The plugin log has a `raise ok=false error=...` line when no tool is found. On macOS, check that Orca's bundle id is `com.stablyai.orca` and that Orca is running. A pane on a host that is down cannot be focused; the press still raises Orca.

### Paired-server panes are slow or cannot be held

- **Cause.** Paired Orca servers are reachable only through the `orca --environment` CLI. Status can lag by about 7 s, and Orca publishes no focus for them.
- **Fix.** Assign them from the picker, not by holding a key. Background and numbers: [known-issues.md](known-issues.md).

## Orca plugin (development)

### Orca's plugin panel stays on "Loading plugin panel..." or its plugin list hangs

- **Cause.** Orca's development folder was set to the repository root instead of `orca-plugin/`. Orca watches every file under a development folder and reloads the plugin when one changes. The Stream Deck plugin writes its log under `packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin/logs/`, so every connect or key press reloads the Orca plugin, which connects again and writes another log line. The reload loop keeps the plugin service busy, so panel reads never finish.
- **Check.** `~/.orca-deck/plugin-a.log` shows `worker started` every second or so. The Stream Deck plugin log shows `A connected` at the same rate.
- **Fix.** Remove the repository root from Orca Settings, Plugins, Development folders and add the `orca-plugin` folder instead:
  `orca plugin dev unload <path-to-repo>` then `orca plugin dev load <path-to-repo>/orca-plugin` (approve the fingerprint it prints). Restart Orca if its plugin service is already stuck. Stop the Stream Deck plugin while doing this so its log stops waking the watcher.

## What to attach to an issue

Run the diagnostics script (see Logs in [install.md](install.md#logs)) and attach the file it writes. Read it before attaching. Also say which Status key caption you see and what the key shows.
