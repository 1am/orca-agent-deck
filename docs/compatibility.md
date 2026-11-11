# Compatibility

"Tested" means someone ran it on that setup. "Untested" means it may work and nobody has checked. Reports from untested setups are welcome.

## Platform

| | Status |
|---|---|
| macOS | Tested (macOS 15). macOS 13 or newer is the declared minimum. |
| Windows | Tested (Windows 11, Orca 1.4.255). Windows 10 or newer is the declared minimum. Pressing a key focuses the pane but does not raise the Orca window. |
| Linux | Tested (Ubuntu 22.04, in OpenDeck). Pressing a key focuses the pane; the Orca window is raised too under X11 with `xdotool` or `wmctrl` installed, not on Wayland. |

## Stream Deck

| | Status |
|---|---|
| Stream Deck Mobile (6 keys) | Tested |
| Stream Deck MK.2 hardware | Tested by the maintainer, on macOS and on Ubuntu 22.04 in OpenDeck |
| Stream Deck Neo hardware | Tested on Windows 11 with the Elgato Stream Deck app 7.4.2 |
| Other Stream Deck hardware | Untested |
| OpenDeck | Tested on Ubuntu 22.04 with Stream Deck MK.2; the plugin behaves the same as in the Elgato app. Each release is meant to pass the dual-host smoke checklist in both hosts; results go in the table below. |
| Other hosts | Untested |
| Elgato Stream Deck app 7.1 or newer | Required |

## Orca

| | Status |
|---|---|
| 1.4.245 | Minimum. Older versions are refused ("Orca x.y.z too old"). |
| 1.4.245 to 1.4.251 | Tested |
| Newer than 1.4.251 | Untested. Newer Orca versions are expected to work, and the Status key shows the version it sees. |

## Harnesses

Agent Deck for Orca draws what Orca reports, so each harness depends on Orca's agent hooks. Claude Code, Codex and Pi are the ones the deck has pictograms for; others show their state without a harness badge guarantee.

| Harness | Reported states | Notes |
|---|---|---|
| Claude Code | working, needs input, done (success, failure, stopped), "asks you" when a turn ends with a question | Tested |
| Codex | Same states if Orca's Codex hooks are on | Partly tested (2026-11-07): states arrive, but Codex's shared background server reports them to one pane; start Codex with `codex --no-daemon` (not yet verified end to end, see [known-issues.md](known-issues.md)). Hooks must be enabled in Orca first. |
| Pi | Top-level state only: working, needs input, done | Reported through Orca's managed Pi extension; tested on Orca 1.4.245 |
| Others | Whatever Orca reports | Untested |

State names follow the colours on the key: working (blue), needs input (amber), asks you (orange), done (green), error (red), stopped (purple-grey), idle (grey). The mapping from Orca's states is in `packages/core/src/status.ts`.

## Hosts

| | Status |
|---|---|
| Local panes | Tested |
| SSH hosts (through Orca's own SSH) | Tested. Read over the same runtime socket as local panes. |
| Paired Orca servers | Tested, with limits: slower updates, no hold-to-assign. See [known-issues.md](known-issues.md). |
| tmux | Tested with one agent per tmux session. Several agents in one session share one key. See [working-with-tmux.md](working-with-tmux.md). |

## Host x version x device

Filled from the dual-host smoke runs, one row per run.

| Host | Host version | Device | Agent Deck for Orca | Result |
|---|---|---|---|---|
| Elgato Stream Deck app | 7.4.2 | MK.2 | | not run |
| Elgato Stream Deck app | 7.4.2 | Neo | 0.2.0 | OK on Windows 11 (Orca 1.4.255): plugin loads, bridge connects, keys render and focus panes |
| OpenDeck (Linux) | | MK.2 | 0.2.0 | OK on Ubuntu 22.04: plugin loads, bridge connects, keys render and focus panes, same as in the Elgato app |
| OpenDeck (macOS) | | MK.2 | | not run |

## Marketplace DRM (SDKVersion 3)

Checked 2026-11-08. The Marketplace DRM needs manifest `SDKVersion` 3, `Software.MinimumVersion` 6.9 or newer and `@elgato/streamdeck` 2 or newer. We ship `SDKVersion` 2 with `MinimumVersion` 7.1 and `@elgato/streamdeck` 3.0.4, so only the `SDKVersion` is missing.

- The plugin does not write into its `.sdPlugin` folder: the mapping file is `~/.orca-deck/mappings.json` (`src/mapping-file.ts`), and the plugin does not read its own manifest at runtime.
- OpenDeck's manifest struct (`src-tauri/src/plugins/manifest.rs`) has no `SDKVersion` field and does not reject unknown fields, so the value should not matter to it.

Decision: stay on `SDKVersion` 2 for now. Nothing here shows that version 3 breaks OpenDeck, but it has not been run on either host, and DRM only matters for Marketplace downloads. To switch: set `SDKVersion` to 3 and `MinimumVersion` to 6.9 or higher (7.1 stays), build, run the dual-host smoke checklist on the packed plugin in the Elgato app and in OpenDeck, then upload to the Maker Console with "Publish after review" off and check that the package is accepted.
