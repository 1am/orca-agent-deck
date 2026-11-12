# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [0.2.2] - Unreleased

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
