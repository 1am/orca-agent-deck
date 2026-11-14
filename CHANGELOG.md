# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [0.3.0] - unreleased

### Added

- **orca-plugin:** an Agent Deck panel in Orca's right sidebar with the deck as a grid of numbered keys, laid out like your deck (a wide deck wraps instead of clipping). A click on a key marks it and shows its details under the grid, as in the Stream Deck app: what it shows, Unmap, "Use the focused pane" and a list of the terminal panes to choose from (the focused one first; each line starts with the pane's title, then the agent, the host last). The details stay open after a choice; Back closes them. A search field narrows the pane list by title, tab, agent or host. A pane that is on another key moves, so a pane is on one key only. The panel names the deck model (MK.2, XL, Mini, Neo, ...). Bridge protocol minor 1 carries it (the major stays 1; an older Stream Deck plugin ignores the new frames and the panel says to update it).
- **orca-plugin:** a keyboard shortcut for "Agent Deck: Open panel" (Cmd+Alt+K, Ctrl+Alt+K on Windows and Linux), the same as the "Agent Deck" button in the status bar and the command palette: it shows the panel and opens the key of the pane you focused, if it is on one, else the bare grid. There is no map mode and no shortcut to unmap: mapping is done in the panel. Orca lets you change the shortcut in its shortcut settings. It works in a terminal pane too, but there the keys also reach the program running in it (see `docs/known-issues.md`).
- **orca-plugin:** an "Agent Deck" button in Orca's status bar (it reads "Deck offline", "No Stream Deck" or "Update Agent Deck" when mapping cannot work), the Cmd+Alt+K shortcut and "Agent Deck: Open panel" show the Agent Deck panel, with the key of the pane you focused opened; they only show it, hiding the right sidebar would need Orca's `workspace:write` capability. The panel lists the panes under the key's details with the focused one first, in its own scroll area (up to 480 px), so the grid stays in view. The Stream Deck plugin opens the panel through Orca's runtime (a worker cannot); where that is not possible (an older Stream Deck plugin, no runtime, Orca refuses) the toast says so. Bridge protocol minor 2 adds `openPanel` and `openPanelResult`.
- **orca-plugin:** while the Agent Deck panel is in view with a key's details open, a tap on a deck key opens that key in the panel instead of focusing its pane, so a key can be chosen from the deck too. Hidden, closed or not mapping, the panel leaves deck taps alone. Bridge protocol minor 3 adds `panelSelect` and `keyPicked`; with an older plugin on either side taps focus as before.
- **streamdeck:** tells the Elgato Stream Deck app from OpenDeck on macOS, Windows and Linux, and the Setup tab has a "Stream Deck app" row with what it concluded. The log line `host:` carries the same.
- **streamdeck:** key mappings survive switching between the Elgato app and OpenDeck. A key at the same position inherits the mapping of the vanished one even though the other app names the device differently.
- **streamdeck:** when the Orca plugin is not installed, the Status key says "Install the Orca plugin" and the Setup tab has a button that opens the install link in Orca. The deck keeps working from polled status meanwhile.
- **streamdeck:** the badge on a pane key shows the agent's own icon, taken from Orca: 40+ agents such as Codex, Cursor, Gemini, Copilot, OpenCode, Droid, Devin, Amp, Kimi and Cline. Claude Code, plain shells and tmux keep a drawn glyph, and an agent without an icon shows its first letter, or two letters when another agent starts alike. The logos belong to their owners (see `NOTICE.md`).
- **streamdeck:** the Setup tab shows that "Check again" is running and when the last check finished, and names the paired servers it cannot reach.
- **orca-plugin:** "Agent Deck: Uninstall" removes the data folder (`~/.orca-deck`, `%APPDATA%\orca-deck` on Windows) with the bridge file, key mappings and the plugin log, and says how to remove the two plugins by hand. Run it twice within 10 seconds to confirm.
- **orca-plugin:** "Agent Deck: Record events" is an opt-in capture of what Orca sends the plugin, for bug reports and replay tests. A second run stops it and shows the file; it stops by itself after 10 minutes or 5 MB, and carries on when Orca restarts the plugin's worker meanwhile. Only the fields a replay needs (pane, state, timestamps) are written: never terminal content, pane titles, branch names, paths or tokens.
- Both plugins say "Update Agent Deck for Orca" when their bridge versions differ, instead of failing quietly.
- Release files carry GitHub build attestations. "Verify the download" in `docs/install.md` shows how to check them with `gh attestation verify`.

### Changed

- **orca-plugin:** the consent dialog is shorter: the plugin no longer asks for `workspace:read` (the workspace created/removed events, which the Stream Deck plugin never acted on) or `storage:own` (unused: it writes `~/.orca-deck` with Node). It lists Full access, the commands line and agent status. Orca asks you to accept the access again on update.

- **streamdeck:** the Agent Deck panel is the single way to map a key. Holding a Pane key opens the panel at that key's details on every host type (local, SSH, paired server) and maps nothing itself; if the panel cannot be opened the key says "Map in Orca" for 3 s. The deck's own "Assign here" mode (with its "Replace:" labels and the Cancel on the Status and Attention keys) is removed, and so are the bridge messages `pairRequest`, `unmapRequest`, `pairCancel` and `pairState` (protocol minor 4; `keyPicked` now also follows a hold). Supersedes remote hold focus (#122).

- **orca-plugin:** needs Orca 1.4.248 or newer (for the status bar button). The manifest no longer declares `publisher`, which Orca deprecated and now takes from the repository owner. On older Orca, the catalog keeps offering v0.2.2.
- **streamdeck:** "hosts down" counts only hosts that showed something in Orca (a worktree, a terminal or an agent) the last time they answered, or that a key is mapped to. A configured SSH host or paired server you do not use no longer counts.
- **streamdeck:** on Windows a key press brings Orca to the front: the plugin asks Orca to reveal the pane, and Orca raises its own window.
- **streamdeck:** a key waiting for permission always reads "needs you". It used to read the tool name when the status came from polling and "needs you" when Orca pushed it.
- **streamdeck:** the working spinner turns in eighths at 4 frames per second while at most 2 keys are working and at 2 with more (as before), because Elgato asks for about 10 image updates per second in total. Ticks with nothing to animate no longer repaint.
- **streamdeck:** key text prefers Liberation Sans and DejaVu Sans, so labels lay out the same on Linux and Windows hosts that lack Helvetica.

### Fixed

- **orca-plugin:** the Agent Deck panel says "The Stream Deck plugin is not running." within about 2 s of the Stream Deck plugin going away (it kept showing Connected and the last grid until Refresh), closes an open key, and shows the grid again by itself when the plugin is back. A switch between the Elgato app and OpenDeck does not flicker.
- **streamdeck, orca-plugin:** after quitting OpenDeck (or the Elgato app) and starting the other, nothing synced: the old Stream Deck plugin kept running as an orphan and Orca's plugin stayed connected to it. The plugin now exits when its Stream Deck app is gone (and leaves a `bridge.json` a newer one wrote alone), and the Orca plugin checks `bridge.json` every 5 s and moves to a newer Stream Deck plugin.
- **streamdeck:** on Windows, an Orca launcher found on `PATH` as `orca.cmd` is run through `cmd.exe` (recent Node refuses to start a `.cmd` directly), and only with arguments that contain no shell characters.
- **streamdeck:** an agent whose process crashed or exited with an error shows as an error on its key (it read "offline") and counts on the Attention key, which stayed calm.
- **streamdeck:** a pane is on one key only. Mapping a pane that already sits on a key (from the "Map pane to key" command, by holding a key, or from the picker) moves it instead of showing it on two keys, and a mappings file that has a pane on several keys is cleaned on load. Run from the plugin settings, "Map pane to key" uses the last pane Orca reported focused, and says "Focus a terminal pane first" when there is none.
- **streamdeck:** a key press at the moment Orca restarts no longer fails: the plugin reads the panes again and retries with the new terminal handle.
- **streamdeck:** the Status key no longer counts a paired server's runtime peers as hosts down, and paired servers whose id needs encoding are matched.
- **streamdeck:** the Orca plugin installed from a local folder is detected, so the Status key does not call it missing.
- **streamdeck:** the Setup tab no longer scrolls sideways in the inspector, and its result marks are drawn, not font glyphs.
- **streamdeck:** mapping a pane while Orca shows a remote host (SSH or paired server) no longer maps the first local pane. The focus read does not ask `terminal show` (the local runtime's pane) for a remote worktree, says which host the focus is on, and the deck matches the pane by host as well as tab and leaf ids, so a remote pane that shares ids with a local one is the one mapped. "Use the focused pane" and the Focused mark in the panel no longer fall back to the last local pane while a remote one is shown. While Orca shows a paired server (it marks no worktree active, as in its settings) and paired-server panes exist, "Map pane to key" no longer falls back to the last local pane. A pane chosen in the panel is matched by host too, and a pane is on one key per host, so mapping a local pane no longer empties the key of a remote pane with the same ids.

## [0.2.2] - 2026-11-12

### Fixed

- **adapter-cli:** a terminal Orca lists with `"title": null` (a plain shell tab after an Orca restart) no longer fails the whole listing, which made the Status key say "Orca not running" and the pane keys stay empty. A field Orca leaves out or sends as null (terminal title and execution host, an agent's `interrupted`, a worktree's host and agents, the host scope lists) now reads as its default, and one terminal, worktree or agent entry that does not match is skipped instead of failing the rest. Each skipped entry is logged once with the schema path and handle (never its content).
- **streamdeck:** when Orca answers the health check but a listing does not parse, the Status key says "unexpected Orca response" (a failed Setup check, with the schema path in the plugin log) instead of "Orca not running", and the keys keep the last good read.
- **adapter-cli:** a host is counted down only when no listing covered it. `omittedHostIds` is per-listing coverage, not health, so an SSH host with worktrees but no terminals (it appears only in the terminal listing's gaps) no longer shows as "host down". Mapped keys, released entries and remote panes hold their last known state for any omitted host, and the Setup count uses the new `downHostIds`. A known environment's runtime id is still removed, so a failed host list cannot hide a paired runtime that is down.

## [0.2.1] - 2026-11-11

Renamed to Agent Deck for Orca.

### Changed

- The plugin is now called "Agent Deck for Orca". Orca's plugin directory reserves display names that start with "Orca" for official plugins, so it did not list "Orca Agent Deck". The Stream Deck actions move to the "Agent Deck for Orca" category, and the Orca commands are now "Agent Deck: Map pane to key", "Agent Deck: Unmap pane" and "Agent Deck: Show status". The plugin ids do not change, so existing installs update in place and keep their key mappings.

## [0.2.0] - 2026-11-10

Windows and Linux support.

### Added

- **streamdeck:** Windows support. The plugin manifest declares Windows 10 or newer, tested with Stream Deck Neo on Windows 11.
- **runtime:** read the Orca runtime over the Windows named-pipe transport as well as the Unix socket, so steady-state reads no longer fall back to spawning the CLI.
- **streamdeck:** Linux support through [OpenDeck](https://github.com/nekename/opendeck), tested with Stream Deck MK.2 on Ubuntu 22.04. The same release package works there unchanged and behaves as in the Elgato app. Pressing a key focuses the pane and, under X11 with `xdotool` or `wmctrl` installed, raises the Orca window.
- **adapter-cli:** find the per-user Orca install on Windows (`%LOCALAPPDATA%\Programs\orca`) and join `PATH` with the platform delimiter.

### Fixed

- **bridge:** on Windows, fall back to `%USERPROFILE%\AppData\Roaming` when `APPDATA` is missing, which Orca's plugin worker does not always set. Plugin A then finds `bridge.json` instead of logging "Stream Deck plugin not running".
- **adapter-cli:** on Windows, no longer look for `orca` in `/usr/local/bin` and `/opt/homebrew/bin`. They resolve to `C:\usr\local\bin`, a folder any local account can create, so another account could plant an `orca` the plugin would run.
- **windows:** an empty `APPDATA`, `LOCALAPPDATA` or `ProgramFiles` is treated as missing instead of producing a path relative to the working directory, which put `bridge.json` and `mappings.json` in the wrong folder.
- **window-raiser:** on Linux X11, match only the Orca window. The class search was a regex that also matched `orca-ide` windows, so the raise activated the wrong ones.
- **bridge, runtime:** on Windows, `bridge.json` and `orca-runtime.json` must be regular files again. A symlink is refused, as on macOS.

## [0.1.2] - 2026-11-08

### Removed

- **streamdeck:** the bundled Stream Deck Mobile key profile. Orca's plugin catalog rejects releases that contain binary files, and the `.streamDeckProfile` file is one. Drag the Pane, Status and Attention actions onto keys instead.

## [0.1.1] - 2026-11-08

### Fixed

- **orca-plugin:** Orca's "Install from Git" now takes the repository URL (`https://github.com/1am/orca-agent-deck`). Before, it stopped with "No readable orca-plugin.json was found", because the plugin lives in the `orca-plugin/` folder. The `orca://` link and catalog installs work as before.

## [0.1.0] - 2026-11-08

First public release.

### Added

- **streamdeck:** pane keys show each pane's state (working, needs input, awaiting reply, done, error, offline) and focus the pane in Orca on press
- **streamdeck:** hold a pane key to assign the selected Orca pane, or pick one from the pane picker (search matches every word in any order)
- **streamdeck:** key numbers on the Assign here keys
- **streamdeck:** Attention key counts the panes that need you; Status key shows setup checks
- **streamdeck:** the focused pane's key is drawn light with a state-coloured frame
- **streamdeck:** shell panes without an agent show working while they print and done when the output stops
- **streamdeck:** key mappings survive a plugin reinstall and are stored outside the host app's settings
- **streamdeck:** host aliases for SSH hosts (set in the plugin's global settings)
- **orca-plugin:** pushes agent status to the deck as it changes; "Map pane", "Unmap pane" and "Show status" commands
- **remote:** panes on SSH hosts and paired Orca servers
- **tmux:** local tmux and tmux in Orca SSH worktrees, one agent per tmux session (needs `update-environment` in `~/.tmux.conf`, see `docs/working-with-tmux.md`); plain or nested `ssh` into a remote tmux and moving a session between panes are not verified yet, see `docs/known-issues.md`
- **window-raiser:** pressing a key raises Orca on macOS without the Accessibility permission
- **release:** both plugins share one version; GitHub release with checksums and `collect-diagnostics.mjs`
