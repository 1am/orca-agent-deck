# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [0.3.0] - unreleased

### Added

- **orca-plugin:** keyboard shortcuts for "Agent Deck: Map pane to key" (Cmd+Alt+K, Ctrl+Alt+K on Windows and Linux) and "Agent Deck: Unmap pane" (with Shift). Orca lets you change them in its shortcut settings.
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

- **orca-plugin:** needs Orca 1.4.246 or newer. The manifest no longer declares `publisher`, which Orca deprecated and now takes from the repository owner. On Orca 1.4.245, the catalog keeps offering v0.2.1.
- **streamdeck:** a key waiting for permission always reads "needs you". It used to read the tool name when the status came from polling and "needs you" when Orca pushed it.
- **streamdeck:** the working spinner turns in eighths at 4 frames per second while at most 2 keys are working and at 2 with more (as before), because Elgato asks for about 10 image updates per second in total. Ticks with nothing to animate no longer repaint.
- **streamdeck:** key text prefers Liberation Sans and DejaVu Sans, so labels lay out the same on Linux and Windows hosts that lack Helvetica.

### Fixed

- **streamdeck:** a key press at the moment Orca restarts no longer fails: the plugin reads the panes again and retries with the new terminal handle.
- **streamdeck:** the Status key no longer counts a paired server's runtime peers as hosts down, and paired servers whose id needs encoding are matched.
- **streamdeck:** the Orca plugin installed from a local folder is detected, so the Status key does not call it missing.
- **streamdeck:** the Setup tab no longer scrolls sideways in the inspector, and its result marks are drawn, not font glyphs.

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
