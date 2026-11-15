# Agent Deck for Orca

**Running several agents at once is like...**

[![Running several agents at once is like...](https://media.giphy.com/media/bsoUDDuaSi2rV9T2F7/giphy.gif)](https://giphy.com/gifs/BrabantinBeelden-connecting-plug-in-plugging-bsoUDDuaSi2rV9T2F7)

Agent Deck for Orca shows the state of your agents and terminals running in [Orca](https://www.onorca.dev) on a Stream Deck, and focuses a pane when you press its key. Easy to see where and when your attention is needed.

https://github.com/user-attachments/assets/e582b431-699e-401b-8338-61762e6e8f5a

## What you get

- **Pane keys** show each pane's state (working, needs input, awaiting reply, done, error, offline). Press one to focus that pane in Orca.
- **Attention key** counts the panes that need you.
- **Status key** shows setup checks.
- **Agent Deck panel** in Orca's right sidebar is where you map panes to keys. Open it by holding a key, clicking "Agent Deck" in Orca's status bar, or pressing Cmd+Alt+K (Ctrl+Alt+K on Windows and Linux).
- Works locally and over SSH, and with tmux (see [Working with tmux](docs/working-with-tmux.md)).

> [!WARNING]
> Experimental, built for personal use, and at a very early stage. Expect breaking changes and rough edges. Use it at your own risk. What has been tested is listed in [Compatibility](docs/compatibility.md).

## Requirements

- macOS 13+, Windows 10+ or Linux, with Orca 1.4.248 or newer and the `orca` shell command registered.
- The Elgato Stream Deck app 7.1+ (macOS, Windows) or [OpenDeck](https://github.com/nekename/opendeck) (Linux), and a Stream Deck.

It has two parts and needs both: a **Stream Deck plugin** and an **Orca plugin**.

## Install

1. Download the Stream Deck plugin from the [latest release](https://github.com/1am/orca-agent-deck/releases/latest) and double-click it.
2. Install the Orca plugin: paste `https://github.com/1am/orca-agent-deck` into Orca's Settings, Plugins, Install from Git.

Offline install, building from source and first steps: [Install and quick start](docs/install.md).

## Docs

- [Install and quick start](docs/install.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Compatibility](docs/compatibility.md)
- [Working with tmux](docs/working-with-tmux.md)
- [Known issues and limitations](docs/known-issues.md)
- [Architecture](docs/architecture.md)
- [Bridge protocol](docs/bridge-protocol.md)

## Development

```sh
pnpm i
pnpm lint && pnpm typecheck && pnpm test
pnpm sd:dev                     # build, link into the Stream Deck app, rebuild on change
orca plugin dev load orca-plugin
```

Load the Orca plugin from `orca-plugin/`, not the repository root. More in [Architecture](docs/architecture.md).

## Support

An independent project, not affiliated with or endorsed by Stably (Orca) or Elgato (Stream Deck). Best effort, by one maintainer.

To report a problem, open an issue and attach the file from `node collect-diagnostics.mjs` (see [Logs](docs/install.md#logs)). Read it before attaching it.

## Thanks

Windows support was tested and helped along by [@jondmarien](https://github.com/jondmarien).

## License

[MIT](LICENSE)
