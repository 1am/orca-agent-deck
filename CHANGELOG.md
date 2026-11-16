# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- In OpenDeck, the Orca panel could say "The Stream Deck is not connected." while the deck worked, and keys could not be mapped from Orca. This happened when the plugin started after OpenDeck had already connected the deck, for example after installing, updating or reloading the plugin. A deck now counts as connected once it shows an Agent Deck key. The Elgato app is not affected.
- Fifine Control Deck: the plugin did not start at all (no log), because the app runs plugins on Node 20.8.1, which needs to be told that the plugin is an ES module. The plugin now ships `bin/package.json` for that.
- Fifine Control Deck: the Orca panel said "The Stream Deck is not connected." because the app never reports its decks as connected. A deck that shows Agent Deck keys now counts as connected, and the 1x1 virtual device the app adds no longer does.

## [0.3.0] - 2026-11-14

Map keys from inside Orca, see at a glance which agent is on each key, and switch between the Elgato app and OpenDeck without losing your setup.

### Added

- **Agent Deck panel in Orca.** Your deck as a grid of numbered keys in Orca's right sidebar, laid out like the real thing (MK.2, XL, Mini, Neo, ...). Click a key, pick a pane, done. Search panes by title, tab, agent or host. Picking a pane that is already on another key moves it, so a pane is never on two keys.
- **Open the panel from anywhere.** Hold a deck key, click "Agent Deck" in Orca's status bar, run "Agent Deck: Open panel" or press Cmd+Alt+K (Ctrl+Alt+K on Windows and Linux). It opens at the key of the pane you are in. Press again to hide the sidebar. While a key is open in the panel, tapping a deck key selects it there instead of focusing its pane.
- **Agent icons on keys.** Pane keys show the agent's own icon for 40+ agents, among them Codex, Cursor, Gemini, Copilot, OpenCode, Droid, Devin, Amp, Kimi and Cline. Claude Code, plain shells and tmux keep their drawn glyph. The logos belong to their owners, see `NOTICE.md`.
- **Elgato app or OpenDeck, your choice.** The plugin recognizes which app is running on macOS, Windows and Linux, and your key mappings carry over when you switch between them.
- **Clearer setup.** The Status key tells you when the Orca plugin is missing, and the Setup tab has a button that installs it. "Check again" shows that it is running, when it last finished, and names the paired servers it could not reach. Both plugins ask you to update when their versions do not match, instead of failing quietly.
- **Event recording for bug reports.** "Agent Deck: Record events" captures what Orca sends the plugin, for up to 10 minutes or 5 MB. It stores only pane ids, states and timestamps: never terminal content, titles, branch names, paths or tokens.
- **Verified downloads.** Release files carry GitHub build attestations. See "Verify the download" in `docs/install.md`.

### Changed

- **One way to map a key.** Holding a deck key opens the panel at that key, for local, SSH and paired-server panes alike. The deck's own "Assign here" mode is gone. If the panel cannot open, the key says "Map in Orca".
- **Fewer permissions.** The Orca plugin asks only for what it uses. Orca will ask you to accept the access once more on update.
- **Needs Orca 1.4.248 or newer.** Older Orca keeps getting v0.2.2 from the catalog.
- **"Hosts down" counts only hosts you use.** A host counts when it last showed a worktree, terminal or agent, or when a key points to it. An unused SSH host or paired server no longer shows as down.
- **Windows: a key press brings Orca to the front.**
- **"Needs you" everywhere.** A key waiting for permission always reads "needs you", whichever way the status arrived.
- **Lighter animation.** The working spinner is smoother with up to two keys working, and keys with nothing to animate no longer repaint.
- **Same look on every OS.** Key text prefers Liberation Sans and DejaVu Sans, so labels lay out the same on Linux and Windows.

### Fixed

- Switching between the Elgato app and OpenDeck left an orphaned plugin behind and nothing synced. Both sides now notice within a few seconds and reconnect.
- The panel says "The Stream Deck plugin is not running." within about 2 seconds of the plugin going away, and shows the grid again by itself when it is back.
- Mapping a pane while Orca showed an SSH host or paired server mapped the first local pane instead. Remote panes are now matched by host, and "Use the focused pane" follows the pane you actually see.
- A pane could end up on two keys. It is now on one key only, and existing mapping files are cleaned on load.
- An agent that crashed showed as "offline" and the Attention key stayed calm. It now shows as an error and counts.
- A key press during an Orca restart failed. It now retries with the new terminal handle.
- The Status key counted a paired server's runtime peers as hosts down, and missed paired servers whose id needs encoding.
- An Orca plugin installed from a local folder was reported as missing.
- On Windows, an `orca.cmd` launcher on `PATH` would not start with recent Node.
- The Setup tab no longer scrolls sideways, and its result marks render on every system.

## [0.2.2] - 2026-11-12

### Fixed

- A shell tab without a title (common after an Orca restart) no longer breaks the whole listing, which made the Status key say "Orca not running" and emptied the pane keys. Fields Orca leaves out read as defaults, and one bad entry is skipped instead of failing the rest.
- When Orca answers but a listing does not parse, the Status key says "unexpected Orca response" and the keys keep their last good state.
- An SSH host with worktrees but no terminals no longer shows as "host down".

## [0.2.1] - 2026-11-11

Renamed to Agent Deck for Orca.

### Changed

- The plugin is now "Agent Deck for Orca": Orca's plugin directory reserves names that start with "Orca" for official plugins. The Orca commands are "Agent Deck: Map pane to key", "Unmap pane" and "Show status". Plugin ids are unchanged, so existing installs update in place and keep their key mappings.

## [0.2.0] - 2026-11-10

Windows and Linux support.

### Added

- **Windows.** Windows 10 or newer, tested with Stream Deck Neo on Windows 11. Reads Orca over the named pipe and finds the per-user Orca install.
- **Linux through [OpenDeck](https://github.com/nekename/opendeck).** Tested with Stream Deck MK.2 on Ubuntu 22.04, same package, same behaviour. Under X11 with `xdotool` or `wmctrl` installed, a key press raises the Orca window.

### Fixed

- Windows: a missing or empty `APPDATA` no longer puts the bridge and mapping files in the wrong folder, and the plugin no longer looks for `orca` in folders another local account could create.
- Linux X11: only the Orca window is raised, not `orca-ide` windows.
- Windows: the bridge and runtime files must be regular files. A symlink is refused, as on macOS.

## [0.1.2] - 2026-11-08

### Removed

- The bundled Stream Deck Mobile key profile: Orca's plugin catalog rejects releases with binary files. Drag the Pane, Status and Attention actions onto keys instead.

## [0.1.1] - 2026-11-08

### Fixed

- Orca's "Install from Git" works with the repository URL (`https://github.com/1am/orca-agent-deck`).

## [0.1.0] - 2026-11-08

First public release.

### Added

- Pane keys show each pane's state (working, needs input, awaiting reply, done, error, offline) and focus the pane in Orca on press. The focused pane's key is drawn light with a state-coloured frame.
- Hold a key to assign the selected pane, or pick one from the searchable pane picker.
- The Attention key counts the panes that need you. The Status key shows setup checks.
- Shell panes without an agent show working while they print and done when the output stops.
- Panes on SSH hosts and paired Orca servers, with host aliases for SSH hosts.
- Local tmux and tmux in Orca SSH worktrees, one agent per tmux session: see `docs/working-with-tmux.md` and `docs/known-issues.md`.
- Key mappings survive a plugin reinstall.
- The Orca plugin pushes agent status to the deck as it changes, with "Map pane", "Unmap pane" and "Show status" commands.
- Pressing a key raises Orca on macOS without the Accessibility permission.
- Both plugins share one version. GitHub releases ship checksums and `collect-diagnostics.mjs`.
