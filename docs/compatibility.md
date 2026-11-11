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
| 1.4.246 | Minimum, set by the Orca plugin: older Orca refuses to install it. Before 1.4.245 the deck also shows "Orca x.y.z too old". |
| 1.4.245 to 1.4.251 | Tested |
| Newer than 1.4.251 | Untested. Newer Orca versions are expected to work, and the Status key shows the version it sees. |

## Harnesses

Agent Deck for Orca draws what Orca reports, so each harness depends on Orca's agent hooks. Keys carry a small badge for the harness: a pictogram for Claude Code, Codex, Pi, OpenCode, Droid, Devin, Gemini, Copilot, Cursor and Amp, and a letter for any other agent (two letters when two agents start alike, such as Cl and Cr). The state shows either way.

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

## OpenDeck (source review of v2.14.2)

Read from nekename/OpenDeck tag `v2.14.2` (commit `3ddecc1`, latest stable on 2026-11-10); no device run yet (#84 confirms). Refs are `file:line` under `src-tauri/src/` unless they start with `src/`. "Device only" = the code cannot answer it.

| Question | Answer | Source |
|---|---|---|
| Which node, how started | `node` from OpenDeck's PATH (login-shell PATH merged at start, so nvm/fnm set up in a non-login rc is not seen; nekename/OpenDeck#72). Run as `node <CodePath> -port <p> -pluginUUID <dir name> -registerEvent registerPlugin -info <json>`, cwd = plugin folder, env inherited, stdout+stderr to `<log dir>/plugins/<dir name>.log` | `plugins/mod.rs:204-212,246-278`; `main.rs:62` |
| Node missing or old | `node --version` is compared to `"v20.0.0"` as a string (so v9 passes, v100 fails). Failure only logs `Node.js version 20.0.0 or higher is required`; no UI, the keys stay inert. Flatpak runs it via `flatpak-spawn --host node`. The plugin logs its Node in the `host:` line, the Setup tab's Stream Deck app row warns below 20 | `plugins/mod.rs:248-253,70-73` |
| Manifest fields read | Required: `Name`, `Author`, `Version`, `Icon`, `Actions` (each with `States`), `OS`. Optional: `CodePath`, `CodePathWin/Mac/Lin`, `CodePaths`, `PropertyInspectorPath`, `Category`. Unknown fields are ignored (no `deny_unknown_fields`): `SDKVersion`, `Nodejs`, `Software.MinimumVersion`, `Profiles` and `OS[].MinimumVersion` have no effect | `plugins/manifest.rs:8-69`; `shared.rs:201-244` |
| `OS` handling | The list must contain the host's platform (`mac`, `windows`, `linux`), else `unsupported on platform X` and the plugin does not start. A `windows` entry on another OS counts as supported (Wine path) but a `.js` `CodePath` is run with node before the Wine branch, so `OS: [mac, windows]` runs natively on Linux | `plugins/mod.rs:157-201,246,279` |
| Per-platform overrides | `manifest.<macos\|windows\|linux>.json` next to `manifest.json` is JSON-merge-patched over it (arrays are replaced) | `plugins/manifest.rs:81-86` |
| Registration info (Node plugin) | Built with the Wine flag on for every OS: `platform` is always `"windows"` and `platformVersion` always `"10.0.19045.4474"`; `version` is the fixed `"7.1.0"`; `devicePixelRatio` is `0`. Same `-info` argument and `registerPlugin` event as the Elgato app. No env var, argv flag or field names OpenDeck | `plugins/info_param.rs:71-104`; `plugins/mod.rs:255` |
| Port | First free pair from 57116 (WebSocket) and 57118 (web server) | `plugins/mod.rs:39-51` |
| Events before registration | Queued per plugin and replayed on registration. A second `registerPlugin` for the same UUID is ignored and logged (2.14.2) | `events/outbound/mod.rs:57-70`; `events/mod.rs:30-33` |
| `setImage` with SVG data URLs | `data:` values pass through; the web view decodes `data:image/svg+xml` (URL-encoded or base64). Rendered in OpenDeck's main window, so latency is device only | `events/inbound/states.rs:67-102`; `src/lib/rendererHelper.ts:12-19` |
| `setTitle`, `showAlert`, `showOk`, `setState` | Supported; `setTitle` and `setImage` skip the redraw when nothing changes | `events/inbound/states.rs:32-65,134`; `events/inbound/misc.rs:33-43` |
| Settings | `setSettings`, `getSettings`, `setGlobalSettings`, `getGlobalSettings` supported; global settings only for the plugin's own UUID | `events/inbound/mod.rs:106-113` |
| `keyDown` / `keyUp` timing | Forwarded as they arrive from the device, no debounce, so hold gestures work. The first press after a device sleep is swallowed (device sleep feature) | `events/outbound/keypad.rs:24-110`; `events/inbound/devices.rs:105-117` |
| Devices | `deviceDidConnect` / `deviceDidDisconnect` and `systemDidWakeUp` are sent; there is no `deviceDidChange`. OpenDeck device ids are `sd-<serial>` | `events/outbound/devices.rs:21,36`; `events/outbound/misc.rs:11`; `elgato.rs:272` |
| `willAppear` payload | `coordinates` is computed from the key position and the device column count | `events/outbound/mod.rs:31-55` |
| Bundled `Profiles`, `switchToProfile` | Not available: the manifest has no `Profiles` field, and `switchProfile` from a plugin is dropped unless its UUID is one of two hard-coded ones | `plugins/manifest.rs:17-69`; `events/inbound/mod.rs:114-119` |
| PI lifecycle | One hidden iframe per action instance, all mounted at profile load. They load and send `sendToPlugin` at once; `propertyInspectorDidAppear` / `Disappear` go out only when the user selects another key. Nothing stops a hidden PI's message from reaching the plugin, and the SDK's `ui.sendToPropertyInspector` targets only the current PI (nekename/OpenDeck#449, closed as not planned). Handled in #169 | `src/components/PropertyInspectorView.svelte:199-205`; `src/lib/propertyInspector.ts:10-16`; `events/outbound/property_inspector.rs:56-70` |
| PI context | A PI is registered under its action context and OpenDeck drops its `sendToPlugin` when the payload context differs | `events/inbound/mod.rs:186-196` |
| Install routes | `.streamDeckPlugin` / `.zip` file or URL (needs one top-level `*.sdPlugin` folder in the zip); GitHub release asset ending `.streamDeckPlugin` or `.zip` (prereleases skipped when a stable one exists); catalogue at openactionapi.github.io; marketplace at marketplace.rivul.us; `streamdeck://` deep links are registered too | `events/frontend/plugins.rs:67-125`; `src/components/PluginManager.svelte:87-128,190`; `main.rs:295-320`; `README.md:24` |
| Paths | Plugins in `<app config dir>/plugins/<dir name>`; app id `opendeck` | `events/frontend/plugins.rs:99-101`; `tauri.conf.json:41` |

**Manifest decision (for #172).** Add `{"Platform": "windows", "MinimumVersion": "10"}` to `OS`. Do not add a `linux` entry: it is not in the Stream Deck manifest schema (`streamdeck validate` would fail, see ChrisRegado/streamdeck-googlemeet#62), and OpenDeck on Linux already starts a `.js` plugin when `windows` is listed. If a device run shows that is not enough, ship `manifest.linux.json` with `{"OS":[{"Platform":"linux"}]}` instead; `validate` never reads it. Keep `SDKVersion` 2, `Nodejs` 20 and `Software.MinimumVersion` 7.1: OpenDeck ignores them.

**Host marker (for #174).** There is nothing better than the registration values: no env var, argv flag or info field names OpenDeck. The strongest signals, all from `plugins/info_param.rs`: `application.version === "7.1.0"` (hard-coded, 3 parts), `devicePixelRatio === 0` (the Elgato app sends the real ratio), and `platform === "windows"` while `process.platform !== "win32"` (Node plugins are told `windows` on every OS, so the current "platform other than mac/windows means OpenDeck" rule never fires). `platformVersion === "10.0.19045.4474"` is a fourth. The Elgato side (4-part build version, real pixel ratio) is device only.

## Marketplace DRM (SDKVersion 3)

Checked 2026-11-08. The Marketplace DRM needs manifest `SDKVersion` 3, `Software.MinimumVersion` 6.9 or newer and `@elgato/streamdeck` 2 or newer. We ship `SDKVersion` 2 with `MinimumVersion` 7.1 and `@elgato/streamdeck` 3.0.4, so only the `SDKVersion` is missing.

- The plugin does not write into its `.sdPlugin` folder: the mapping file is `~/.orca-deck/mappings.json` (`src/mapping-file.ts`), and the plugin does not read its own manifest at runtime.
- OpenDeck's manifest struct (`src-tauri/src/plugins/manifest.rs`) has no `SDKVersion` field and does not reject unknown fields, so the value should not matter to it.

Decision: stay on `SDKVersion` 2 for now. Nothing here shows that version 3 breaks OpenDeck, but it has not been run on either host, and DRM only matters for Marketplace downloads. To switch: set `SDKVersion` to 3 and `MinimumVersion` to 6.9 or higher (7.1 stays), build, run the dual-host smoke checklist on the packed plugin in the Elgato app and in OpenDeck, then upload to the Maker Console with "Publish after review" off and check that the package is accepted.
