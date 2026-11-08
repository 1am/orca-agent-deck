# Install Orca Agent Deck from the release packages

Nothing here needs the repo; only the diagnostics script needs Node 18 or newer.

## Quick start

About 5 minutes. You need Orca, the Elgato Stream Deck app and a Stream Deck (see "You need" below).

1. **Stream Deck plugin.** Download `orca-agent-deck-<version>.streamDeckPlugin` from the [latest GitHub release](https://github.com/1am/orca-agent-deck/releases/latest) and double-click it. The Elgato app installs it and offers the "Orca Agent Deck" key profile. Accept it, or drag the Pane, Status and Attention actions from the "Orca Agent Deck" category onto keys.
2. **Orca plugin.** With Orca running, run this in a terminal:

   ```sh
   open 'orca://plugins/1am.agent-deck?catalog=https://github.com/1am/orca-agent-deck.git'
   ```

   Orca opens the plugin page. Read and accept the access consent: the plugin runs its own code, reads agent status and workspaces, and stores its own data. Orca updates it from the same catalog.

   Without the terminal: in Orca go to Settings, Plugins, Install from Git, and paste `https://github.com/1am/orca-agent-deck`. Orca installs the newest release tag.
3. In Orca open the command palette and run "Orca Agent Deck: Show status".
4. Look at the Status key on the deck. Green "OK" with "live" and the Orca version means everything is connected. Anything else shows a short caption: see [troubleshooting](troubleshooting.md).
5. Start an agent in an Orca pane. To pin the pane you are in to a key, hold a free Pane key (about 1 second). To pick a pane from a list, or to assign a pane on a paired server, use the key's settings in the Elgato app.
6. Press a Pane key to focus that pane in Orca.

### More agents than keys

A plugin cannot change the page of a Stream Deck profile, so Orca Agent Deck has no page keys of its own. Use the Elgato app's built-in Page or Folder navigation keys to add pages. The Attention key counts every pane that needs you, on any page, and adds `+N` for those that are on no key at all, so an urgent pane on another page is never hidden. Press the Attention key to focus the most urgent pane.

Versions and platforms that have been tested: [compatibility](compatibility.md).

## You need

- Orca 1.4.245 or newer, with the `orca` shell command registered (Orca: Settings, register CLI).
- The Elgato Stream Deck app 7.1 or newer, and a Stream Deck (the bundled key profile is for Stream Deck Mobile, 6 keys).
- macOS 13 or newer. Windows and Linux are untested; pane raising on press is macOS only.
- Orca notifications can stay off. Orca Agent Deck does not use them.

## Release files

- `orca-agent-deck-<version>.streamDeckPlugin` - the Stream Deck plugin
- `orca-agent-deck-orca-plugin-<version>.zip` - the Orca plugin, for the offline install only
- `collect-diagnostics.mjs` - for bug reports (see Logs); needs Node 18 or newer
- `SHA256SUMS` - check with `shasum -a 256 -c SHA256SUMS`

The packages are unsigned, so macOS may warn when you open them.

## Offline install of the Orca plugin

Unzip `orca-agent-deck-orca-plugin-<version>.zip` into a folder you keep, since Orca loads it from there. Then in Orca go to Settings, Plugins, install from local path, and pick that folder.

## Permissions

Orca Agent Deck needs no macOS permission of its own. It reads Orca through the local runtime socket, finds the `orca` command at fixed paths (no login shell), and raises the Orca window with `open -b`, which needs nothing. You should see no Files and Folders, Automation, Accessibility or Local Network dialog from it. If you do, please report it with the dialog text.

## tmux

If your agents run inside tmux, read `docs/working-with-tmux.md` first. The reference config is `docs/assets/tmux-example.conf`.

## Logs

- Orca plugin: `~/.orca-deck/plugin-a.log`, or `orca plugin logs 1am.agent-deck`. "Orca Agent Deck: Show status" shows a one-line summary as a toast and writes the details to the log. Orca's Logs pane in the plugin settings is read once when opened and does not refresh.
- Stream Deck plugin: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/pl.1am.orca-agent-deck.sdPlugin/logs/` (`pl.1am.orca-agent-deck.0.log` is the newest). `~/Library/Logs/ElgatoStreamDeck/` holds only the Elgato app's own log.
- When reporting a problem, run `node collect-diagnostics.mjs` (from the release files; in a clone `pnpm diagnostics`) and attach the file it writes. It collects versions and both plugin logs with tokens, home paths and e-mail addresses removed.

## Uninstall

Elgato app: Preferences, Plugins, remove Orca Agent Deck. Orca: Settings, Plugins, remove Orca Agent Deck. Delete `~/.orca-deck/` for leftover logs and the bridge discovery file.
