# Known issues

Setting up tmux so each pane gets its own key: see `docs/working-with-tmux.md`.

Issues that affect Agent Deck for Orca but are not ours to fix, plus how the deck lives with them. Re-check the upstream status on each Orca update and update the "Checked" date.

## Stream Deck app

### The plugin can only answer the inspector the app announced (Stream Deck SDK 3.0.4)

- **What.** The SDK sends to a property inspector only after the app's `propertyInspectorDidAppear` event named it. After the plugin restarts, an inspector that was already open sends `load` (Check again) but the plugin has no inspector to answer.
- **How the plugin copes.** With no announced inspector, a `load` from an inspector is answered to that inspector alone through the SDK's internal connection (`actions/pi-send.ts`; `@elgato/streamdeck` is pinned to 3.0.4 and a test fails when the internals move). Before this, the Setup tab's Check again showed "No answer from the plugin. If it was restarted, select the key again." after 5 s (10 s while Orca is read through the CLI).
- **Workaround.** Select another key and then this one again; the app announces the inspector and the tab answers. Not yet verified whether the Elgato app or OpenDeck re-announce it after a restart.

### Windows: a deck tap or hold that changes the Orca panel does not bring Orca to the front

- **What.** On macOS and X11 the plugin raises the Orca window itself when a key tap selects a key in the panel or a hold opens the panel, as it does for a focus press. On Windows (and Wayland) it cannot raise another app's window; a focus press gets Orca forward through Orca's own `terminal.reveal`, which the panel paths do not call.
- **Workaround.** Switch to Orca by hand. An Orca-side raise through the host API is a later follow-up.

## Orca chats

Checked: 2026-11-20 (Orca 1.4.265, macOS).

Orca opens an agent as a chat (a structured agent session) instead of a terminal when its Chat | CLI setting is Chat. A chat has no terminal handle: `terminal list` never lists it, and its `paneKey` is `structured-agent-session-<sessionId>:<leafId>`. `worktree ps` and `agent list` report it (`address: orca_session_id:<sessionId>`, `kind: "chat"`) with the same `state` and `mainAgent` fields as a terminal agent.

### Chats do not show on the deck

- **What.** The deck builds its pane list from `terminal list`, so chats get no pane: no key, no entry in the pane list, and their status from `worktree ps` or plugin A matches no pane and is dropped. A workspace whose agents are all chats shows only its plain terminal tabs (a setup tab, a shell).
- **Deck impact.** Agents started as chats are invisible to the deck.
- **Workaround.** Set the agent to CLI in Orca (Chat | CLI) or start it with `orca agent launch --surface terminal`, so it runs in a terminal pane.
- **Fix.** Ours: list the chats from `worktree ps` as panes. Pressing a chat key and highlighting the focused chat then still need the two Orca changes below.

### No way to bring a chat tab to the front (stablyai/orca#39847, #42069)

- **What.** No CLI command, runtime method or plugin host method selects a chat tab. `terminal switch` / `terminal.focus` with `structured-agent-session-<id>` answer `terminal_handle_stale`. `terminal.reveal { worktreeId, tabId, leafId }` with the chat's ids answers `navigated: true` but only opens the workspace and shows the tab already selected there (checked on three chats; stablyai/orca#37801 says it works for some chats, not seen here). `tab switch --page` handles browser tabs only (`browser_tab_not_found`), and `orca chat` has only `rename`.
- **Deck impact.** Once chats are listed, a press on a chat key can open its workspace, not the chat itself.
- **Upstream.** stablyai/orca#39847 and #42069 (open) ask for `agent.focus({ sessionId })` and `orca chat switch --session`; #42069 offers a PR. Either that or `terminal.reveal` selecting a structured tab would do. Related: #37801 (a public command to open a chat, from another Stream Deck integration).

### No way to tell which chat is on screen (stablyai/orca#44947, #41553)

- **What.** `terminal list --include-visual-layouts` lists terminal tabs only, so while a chat is on screen the layout still names a terminal tab as active. `terminal.resolveActive` answers the last focused terminal, also one in another workspace. `workspace.readContext` names no chat.
- **Deck impact.** With a chat on screen the deck highlights a terminal's key instead, and the panel's "Use the focused pane" would map that terminal. Not yet checked live with a chat in front.
- **Upstream.** stablyai/orca#44947 (open) proposes `activeSessionId` in `workspace.readContext` and `workspace.changed`, which would cover plugin A; #41553 (open) asks for `orca chat current`. Listing chat tabs in `visualLayouts` would cover the CLI and runtime path without a new command.

### A new chat is not listed until its first turn (not reported upstream)

- **What.** A chat started from the new-agent tab or `orca agent launch --surface chat` shows in Orca at once, but `agent list` and `worktree ps` report it only after its first turn finished.
- **Deck impact.** A freshly opened chat cannot be shown or mapped until it has replied once.
- **Upstream.** Needs Orca to list a chat as soon as its tab exists, idle like an idle terminal.

## Orca plugin tooling

Checked: 2026-11-11.

### Orca 1.4.251 ships no typings for plugin panels (not reported upstream)

- **What.** `orca plugin create --template components` (and `worker-panel`) and `orca plugin types` stop with `ENOENT ... resources/plugins/declarative/orca.d.ts`: the `.d.ts` files the tooling reads are missing from the app bundle (`resources/plugins/declarative` holds only the `.mjs` runtimes). The scaffold still writes the plugin files.
- **Deck impact.** None at runtime. A panel cannot be type-checked against Orca's typings here, so the panel in this repository is plain JSX checked with `orca plugin check` and `orca plugin test`, and its API was read from Orca's shipped schemas.
- **Workaround.** None needed. Re-check on each Orca update and report upstream if it persists.

## Orca plugin shortcuts

Checked: 2026-11-12 (Orca 1.4.251, not reported upstream). Verified on macOS; not yet on Windows or Linux.

### A plugin shortcut also reaches the program running in the terminal

- **What.** Orca runs a plugin's `contributes.keybindings` from a handler on the window, which sees a key press after the terminal (xterm) has already taken it (read from the app's code, the effect seen on macOS). Orca's own shortcuts are claimed under its terminal shortcut policy, so the program in the pane does not get them; a plugin shortcut is not, so Orca runs the command and the same keys also go to the program. Any plugin chord is affected, not only Cmd+Alt+K, and remapping it in Orca's Settings > Keyboard changes the keys but not this.
- **Deck impact.** "Open panel" (Cmd+Alt+K, Ctrl+Alt+K on Windows and Linux) works in a terminal pane as well as outside it, but in a terminal the chord also reaches the program there: Claude Code, for one, closed its prompt on Cmd+Alt+K. There is no shortcut to unmap: the panel's Unmap does it. The press toggles: with the panel in view it hides the whole right sidebar (`commands.run sidebar.right.toggle`; Orca's plugin API cannot hide a single plugin panel), otherwise it shows the panel. That needs the `workspace:write` capability, which adds "Open and rename your workspaces ... and run its built-in commands" to Orca's consent dialog. Orca older than host API 1.3 only shows.
- **Workaround.** Click "Agent Deck" in Orca's status bar (it opens the panel and does not type anything into the pane) or run "Agent Deck: Open panel" from the command palette, and use the shortcut when you are not in a program that reacts to it.
- **Upstream.** Needs Orca to claim a plugin shortcut for the app when it fires in a terminal (as it does for its own, under the terminal shortcut policy).

## Paired Orca servers

Checked: 2026-11-06.

### Panes on a paired server: polled slowly, their focus is unreadable

- **What.** Orca's runtime socket serves this machine and its SSH hosts. A paired server (an environment, often reached through an SSH tunnel) is reachable only through the `orca --environment` CLI, which opens its connection again on every call. A focus on such a pane took 1.4 to 2.6 s in a field log, against about 50 ms for a local pane; the first poll after the plugin starts took about 4.6 s. Orca also publishes no focus for a paired server, so the deck cannot tell which remote pane is selected.
- **Deck impact.** Pressing a key no longer goes through the CLI (2026-11-06): the deck asks this Orca to `terminal.reveal` the pane, as the CLI does in its last step, which takes milliseconds; the CLI switch is only the fallback. Status of remote panes can lag up to ~7 s unless plugin A pushes it. Holding a key opens the Agent Deck panel at that key whatever host the focused pane is on, so the deck never has to read a remote focus; mapping happens in the panel's pane list (guessing the pane from its last output was tried and pinned wrong panes). Orca marks no worktree active both while it shows a paired server and in its settings, so with paired-server panes around, "Use the focused pane" does not fall back to the last local pane either. The Agent Deck panel names the pane you last opened from the deck on that server ("Last opened from the deck"), if there is one; otherwise you choose the pane in its list. The deck's own "Assign here" mode is gone (v0.3.0). Checked on Orca 1.4.257 (2026-11-13): while panes on a paired server were clicked, the local `worktree ps` had no active worktree, the server's own `worktree ps` had none either, its `terminal show` said `no_active_terminal`, and the active tab and pane in its layout did not change. The plugin host's `workspace.readContext` reads the local runtime only and names no active terminal. Matching the focused pane by its title does not help either: Orca reports no title for it, so there is nothing to match against.
- **Workaround.** Assign remote panes from the key settings picker, or from the Agent Deck panel: hold or tap the key, choose the remote pane in its list. Polls of a paired server are served from a cache and refreshed in the background every 5 s; a read that failed is retried on the next poll, so a server back after a network hiccup shows again within a poll. Only a server whose own read fails shows unreachable, not every server when the host list fails. The key draws itself focused as soon as it is tapped, so the press is visibly taken while the switch runs.
- **After sleep.** A field log (2026-11-06) showed the paired server's panes missing for about 3 minutes after wake while Orca reconnected. Their keys keep their mapping and show unreachable; a press raises Orca and shows an alert until the server is back.
- **Upstream.** Reading the focused remote pane (no longer needed for holding a key, the panel's "Use the focused pane" would use it) waits for stablyai/orca PR #32012 (`activeTerminalId` in the plugin `workspace.readContext`), not in 1.4.250. Faster polling needs the paired server to be reachable over the runtime socket, or a persistent connection for the CLI. The runtime lists the capabilities `runtime.environments.v1` and `remote-runtime.shared-control.v1`; no method that uses them was found.

## Codex

Checked: 2026-11-22 (Orca 1.4.265, macOS, `codex --no-daemon`, not reported upstream).

### A Codex reply that ends with a question reads as finished

- **What.** When a Codex turn ends with a question to you, Orca reports it like any finished turn: `state: done`, no `interactivePrompt` and no tool. Only the message text says it is a question.
- **Deck impact.** The key shows the turn as finished, not "needs you". The deck does not read message text to tell the two apart. A command approval is reported as `waiting` (tool `Bash`) and shows "needs you" as it should.
- **Workaround.** None on the deck; a finished Codex key may hold a question, so look at the pane.
- **Upstream.** Needs Orca (or Codex's hooks) to report a question as waiting for input, as it does for Claude Code.

## tmux

Checked: 2026-11-07 (all open upstream).

### Agents inside tmux are not detected by Orca (stablyai/orca#7797)

- **What.** Orca finds a pane's agent by walking the process tree down from the pane's shell. tmux runs its server outside that tree, so `claude` / `codex` / `pi` belong to the tmux server, not to the pane. Orca only sees the tmux client: the pane gets no `agentIdentity` and its title reads `tmux`.
- **Deck impact.** A tmux pane cannot be named from Orca's identity. A key can keep a stale `tmux` label after the agent inside is swapped. Agent state still arrives through hooks when the tmux env is set up, so the key can light up, but the harness comes only from hook state.
- **Workaround.** One agent per tmux session. The deck shows a distinct "tmux, no agent" look instead of gray-stale.
- **Upstream fix.** PRs stablyai/orca#7799, #10009, #10856 (open). Related feature request #18185. When one lands, tmux panes should get a real `agentIdentity`: show the harness instead of the generic tmux look.
- **PR #10009 (reviewed 2026-11-05): not mergeable as is.** It is far behind main, conflicts with it, and its fallback can show an unrelated tmux session's agent when `tmux list-clients` fails. A fix needs a local-only rewrite on main's `shared/tmux-client-attachment.ts` that takes the socket from the client's argv and does not guess on failure.

### No status when tmux was started outside Orca (stablyai/orca#32293)

- **What.** Orca's hook scripts need `ORCA_AGENT_HOOK_PORT`, `ORCA_AGENT_HOOK_TOKEN`, `ORCA_PANE_KEY` and `ORCA_AGENT_HOOK_ENDPOINT`. A tmux server started outside Orca, or without `update-environment`, does not pass them on, and the hook exits silently.
- **Deck impact.** The key stays gray and never turns green.
- **Workaround.** The `update-environment` lines from `docs/assets/tmux-example.conf` in `~/.tmux.conf`, then a fresh tmux server. The Setup doctor checks this locally. Remote hosts: docs only, and they need the same `~/.tmux.conf`. A field check (2026-11-07) on an SSH host without it: every agent there inherited the key of the pane that started the tmux server, so only that pane's harness (Pi) showed and the Claude and Codex keys showed a plain shell.

### All agents in one tmux server share one pane key (stablyai/orca#37799)

- **What.** Every agent in a tmux server inherits the `ORCA_PANE_KEY` of the Orca pane that started the server. Orca keeps the state of whichever agent sent the last hook, also from a hidden window.
- **Deck impact.** Several agents in one session overwrite each other's state on one key.
- **Workaround.** One agent per tmux session.
- **Upstream progress.** Orca PR #24737 (merged) shows only the selected tmux pane's status, first for OpenCode. Since Orca 1.4.248 (#36825) the Claude hook also sends its tmux pane and socket (`TMUX_PANE` + `TMUX`) and the hook server reads it, so Claude may already get selected-pane status. Codex and Pi hooks do not send it. Not yet verified live; if it holds, several Claude agents per session could become supported.

### Codex's shared daemon reports every Codex to one pane (not reported upstream)

- **What.** Codex (seen in 0.167) runs its sessions in one shared background server, `codex app-server`, that stays alive across TUIs. Every `codex` TUI connects to it, and Codex runs its hooks inside the daemon, with the daemon's environment. Orca's hook command reads `ORCA_PANE_KEY` from that environment, so every Codex on the host reports under the pane key of whichever pane started the daemon, even after that pane or its tmux server is gone. Not tmux-specific, but tmux makes it likelier: the daemon outlives sessions. Field check (2026-11-07): the daemon dated from the day before and carried the key of a pane running plain zsh; the Codex pane got no `agentIdentity` and the zsh pane read "Codex ready". On an SSH host the daemon carried the key of a pane in another, closed worktree, so Codex state went nowhere.
- **Deck impact.** A Codex key stays without state while another key (any harness, or a shell) shows Codex's state. Several Codex panes overwrite each other on that one key. The deck only shows what Orca has, so it cannot tell.
- **Workaround.** Start Codex with `codex --no-daemon` ("Run without the shared background server"), so its hooks run with the pane's own environment. Stop a stale daemon with `codex app-server daemon` (see its `--help`). Not yet verified end to end.
- **Upstream.** Needs a fix in Orca's Codex hook or in Codex: either Codex passes the TUI's environment to the hooks it runs, or Orca identifies the pane from the hook payload instead of the hook process's environment.

### Other open tmux items

- stablyai/orca#25344: attach an existing tmux session started outside Orca as a pane.
- stablyai/orca#34305: work an agent detaches (nohup / tmux / ssh) shows as done.
- stablyai/orca#18607: cursor blink redraws in nested tmux + Claude Code (cosmetic, no deck impact).
