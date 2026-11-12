# Agent Deck for Orca

**Working with LLMs is like...**

[![Working with LLMs is like...](https://media1.giphy.com/media/vx9YFNa9ePYWLNnh0X/giphy.gif)](https://giphy.com/gifs/texasarchive-1960s-industrial-film-southwestern-bell-telephone-company-vx9YFNa9ePYWLNnh0X)

Here comes Agent Deck for Orca which shows the state of your agents and terminals running in [Orca](https://www.onorca.dev) on a Stream Deck, and focuses a pane when you press its key. Easy to look up where and when your attention is needed.

https://github.com/user-attachments/assets/1dfea071-0276-4011-b159-7916241eb2ca

## Features

- Pane key shows each pane's state (working, needs input, awaiting reply, done, error, offline).
- Press a pane key to focus that pane in Orca; hold to assign the current pane, or click "Agent Deck" in Orca's status bar: it opens the Agent Deck panel with the pane you focused last named at the top and marked in the pane list under the grid (choose another pane there if you like, a paired-server pane for one), then click an empty key there or press one on the deck. Cmd+Alt+K (Ctrl+Alt+K on Windows and Linux) does the same and Cmd+Alt+Shift+K (Ctrl+Alt+Shift+K) unmaps a pane. They work in a terminal too, but there the keys also reach the program running in it (see `docs/known-issues.md`).
- The Agent Deck panel in Orca's right sidebar shows the connected deck as a grid of numbered keys, laid out like your deck. Click a key to mark it and see its details under the grid: what it shows, Unmap, "Use the focused pane" and the panes Orca lists (the focused one first). Picking a pane puts it on that key and the details stay open; a pane that is already on another key moves, so a pane is on one key only. Back (or a click on the same key) closes the details. It needs the Stream Deck plugin and the Orca plugin from the same release.
- Status key displays setup checks.
- Attention key counts panes that need you.
- Works locally and over SSH.
- Local tmux and tmux in Orca SSH worktrees work with one agent per tmux session: see [Working with tmux](docs/working-with-tmux.md). Plain or nested `ssh` into a remote tmux is not verified yet: see [Known issues](docs/known-issues.md).
- A shell pane (no agent) pinned to a key shows working once it has printed for about 8 seconds, and done when the output stops.
- Only [Elgato Stream Deck](https://www.elgato.com/ww/en/p/stream-deck) hardware is currently tested, but other decks may work as well. On Linux it runs in [OpenDeck](https://github.com/nekename/opendeck).

> [!WARNING]
> This is an experimental project built for personal use and it is at a very early stage (`0.2.0`). Expect breaking changes, rough edges and missing features. It has been tested on macOS with Stream Deck MK.2 and Stream Deck Mobile, on Windows 11 with Stream Deck Neo, and on Ubuntu 22.04 with Stream Deck MK.2 in OpenDeck. Use it at your own risk.

## Requirements

- macOS 13 or newer, Windows 10 or newer, or Linux (tested on Ubuntu 22.04). Pane raising on press works on macOS, and on Linux under X11 with `xdotool` or `wmctrl` installed.
- Orca 1.4.248 or newer, with the `orca` shell command registered (Orca: Settings, register CLI).
- The Elgato Stream Deck app 7.1 or newer (macOS, Windows) or [OpenDeck](https://github.com/nekename/opendeck) (Linux), and a Stream Deck (hardware or Stream Deck Mobile).

Agent Deck for Orca has two parts and needs both: a **Stream Deck plugin** (draws the keys, talks to Orca) and a small **Orca plugin** (pushes agent status to the deck as it changes).

## Install from a release

Download the Stream Deck plugin from the [latest GitHub release](https://github.com/1am/orca-agent-deck/releases/latest) and double-click it. Install the Orca plugin from GitHub with `open 'orca://plugins/1am.agent-deck?catalog=https://github.com/1am/orca-agent-deck.git'`, or paste `https://github.com/1am/orca-agent-deck` into Orca's Settings, Plugins, Install from Git. Details and the offline install: [docs/install.md](docs/install.md).

## Install from this repository

Needs Node 22.6 or newer and pnpm 12.

```sh
git clone https://github.com/1am/orca-agent-deck.git && cd orca-agent-deck
pnpm i
make package          # builds and checks both plugins into dist/
```

Then install `dist/orca-agent-deck-<version>.streamDeckPlugin` (double-click) and the Orca plugin as described in [docs/install.md](docs/install.md). To work on the code instead, see [Development](#development).

## Known limitations

- Pressing a key raises the Orca window on macOS, and on Linux under X11 when `xdotool` or `wmctrl` is installed. On Windows and on Wayland it only focuses the pane.
- Packages are not signed.
- The two plugins are installed separately.
- Panes on a paired Orca server update more slowly, and hold-to-assign does not work for them (use the picker).
- Agents inside tmux need one agent per tmux session: see [docs/working-with-tmux.md](docs/working-with-tmux.md).

The full list, with the upstream Orca issues behind each one, is in [docs/known-issues.md](docs/known-issues.md).

## Docs

- [Install and quick start](docs/install.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Compatibility: what is tested](docs/compatibility.md)
- [Working with tmux](docs/working-with-tmux.md)
- [Known issues](docs/known-issues.md)
- [Architecture](docs/architecture.md)
- [Bridge protocol](docs/bridge-protocol.md)

## Development

```sh
pnpm i
pnpm lint && pnpm typecheck && pnpm test
pnpm sd:dev           # build, link into the Stream Deck app, rebuild on change
```

Committing images needs `exiftool` (`brew install exiftool`): the pre-commit hook strips image metadata and blocks the commit without it.

Other dev script: `pnpm fake-orca` (a fake Orca for local runs).

`pnpm sd:dev` needs Stream Deck developer mode (`npx streamdeck dev`, once). Load the Orca plugin from its own folder, not the repository root:

```sh
orca plugin dev load orca-plugin
```

Orca watches every file under a development folder. The Stream Deck plugin writes its logs under `packages/streamdeck-plugin/`, so a repository-root dev folder reloads the Orca plugin on every log line (agent connect, key press), and Orca's plugin panel never finishes loading. The `orca-plugin/` folder has its own manifest and none of those logs.

- Architecture, network surface and timings: [docs/architecture.md](docs/architecture.md)

## Support

Agent Deck for Orca is an independent project. It is not affiliated with or endorsed by Stably (Orca) or Elgato (Stream Deck).

Best effort, by one maintainer. Supported: the latest stable Orca and the release before it, on macOS. Upstream Orca limits are listed in [docs/known-issues.md](docs/known-issues.md).

To report a problem, open an issue with one of the templates and attach the file from `node collect-diagnostics.mjs` (see [Logs](docs/install.md#logs)). Read it before attaching it.

## Thanks

Windows support was tested and helped along by [@jondmarien](https://github.com/jondmarien).

## License

[MIT](LICENSE)
