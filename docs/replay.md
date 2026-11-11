# Replay scenarios (dev only)

A scenario is a timeline of what Orca and the Stream Deck do, plus what the keys must show. One NDJSON file in `test/replay/`: line 1 is the header, every other line one step. The schema and its rules are in `packages/fake-orca/src/replay/schema.ts`.

```
{"v":2,"name":"ssh-drop-reconnect","sides":["sim"],"keys":{"1":"r"}}
{"at":0,"do":"orca.host.add","id":"ssh-1","kind":"ssh","name":"remote"}
{"at":0,"do":"orca.pane.add","pane":"r","host":"ssh-1"}
{"at":1000,"do":"orca.host.set","id":"ssh-1","connected":false}
{"at":1000,"do":"expect.key","key":1,"state":"unreachable"}
```

- `at` is ms on a virtual clock. Steps are `orca.*` (Orca to plugin A), `deck.*` (host to plugin B), `bridge.*` (A to B) and `expect.*`. `orca.agent` uses Orca's own names (`state`: working, waiting, blocked, done, idle; `outcome`, `toolName`).
- `keys` is the initial layout (key number to pane): every runner plays it as `willAppear` at t=0 with that pane pinned. `deck` defaults to the MK.2 (5x3).
- `sides` names the runners that play it (`sim`, `a`, and `b`); the others skip it and list it as skipped.

## Two layers of assertions
- `expect.*` lines are the intent: what the bug or feature is about. A scenario needs at least one, and a bug fix is only proven by an `expect` that fails when the fix is reverted. An `expect` field the runner cannot evaluate is an error, never a pass.
- `test/replay/__snapshots__/<name>.timeline.txt` is the full picture, generated: one row per change of a key (state, label, line 2). A failure prints the changed rows with their line number.

## Plugin A (side `a`)
`make replay-a` plays the `a` scenarios into the real `orca-plugin/main.mjs` on Orca's `orca/testing` `mountWorker`, with the real `BridgeServer` as B. Local only: it needs Orca >= 1.4.251 installed (no CI). It stages a temp folder (real `main.mjs`, manifest, scenarios, one esbuild bundle) because `orca plugin test` only imports files inside the plugin folder.
- A runs on real time: `at` only orders steps. Steps at one `at` are applied together; then the runner waits for the listed frames (4 s timeout, no fixed sleeps) plus a 30 ms settle to catch unlisted ones.
- `bridge.frame` with `from:"a"` is an expected frame of A: same count and order as sent at that instant, each matching the listed fields (a subset). A failure prints expected vs actual frames. `hello` frames are only checked when listed. `from:"b"` is sent by the fake B (`"$requestId"` = A's last pairing request id).
- `orca.activate` / `orca.deactivate` start and idle out the worker (implicit activate at t=0 if the scenario has none); `orca.event` and `orca.command {id, result}` (the toast) drive it; `deck.device` says whether B reports a deck; `deck.restart` restarts B, `up:false` stops it and leaves its discovery file behind.
- Each scenario states its revert check (the line of `main.mjs` whose removal must fail it).

## Plugin B (side `b`)
`make replay-b` plays the `b` scenarios into the built `bin/plugin.js` (it builds first) through a fake Stream Deck host (`test/replay-b/host.ts`), once per host profile that can run on this OS (`profiles.ts`: the registration info `detectHost` reads plus how the host treats property inspectors). No Orca needed; CI runs it on Linux (opendeck-linux), a Windows runner is not wired yet. B reads the real `process.platform`, so profiles of other OSes are skipped and listed as skipped.
- Orca is the same `SimState` as everywhere: `orca.*` steps drive the runtime socket (or the CLI shim with header `runtime: false`), `bridge.frame from:"a"` lines are what plugin A would send (the same lines the A suite checks A produces) and `from:"b"` lines are the frames B must send back. A shared scenario names `sides: ["a","b"]`; each runner skips the other's steps. Frames use the sim clock for `stateStartedAt` (`1800000000000` + ms), or B ignores them as stale.
- Keys: the header `keys` are pinned at t=0 (through the inspector's `configure`, like a user); `{"action":"attention"|"status"}` makes those keys. Auto-fill is off in the shipped plugin, so nothing relies on it. `deck.pi.open` selects a key's inspector; OpenDeck profiles also mount a hidden inspector per key that sends `load` at appear, played by the host, never written in scenarios. `deck.restart {profile}` restarts the plugin as another host (a host family such as `opendeck` is resolved for this OS, and a different host app starts with empty host settings).
- `expect.key` reads the key image back through `decodeKey` (markers on the root `<svg>`: state, label, line2, agent as `badge`, key number as `number`; info keys: label = caption, line2 = value) and waits up to 4 s. `expect.pi` lists the messages (a list inside a message, such as the Setup checks, matches as an ordered subsequence) the plugin sent to that key's inspector since the last checkpoint (consecutive identical ones count once), `expect.focus` the pane Orca was asked to focus. Fields the runner cannot read are errors.
- There is no timeline snapshot for side b: spinner frames and poll timing make one unstable, so the `expect.*` lines are the whole contract. A failure prints what the key showed over time.
- Isolation: everything runs in a temp dir (HOME, APPDATA, XDG_CONFIG_HOME, a copy of the `.sdPlugin` folder as the working directory); `ORCA_BIN` is the fake-orca shim, `open` is a stub on `PATH`, and `ORCA_DECK_BRIDGE_PORTS=0` keeps B off the real bridge port range. `pnpm replay-b` fails if `git status` changed during the run. Pairing's 15 s timeout stays a unit test (`core/pairing.test.ts`).

## Regression catalog
Every bug closes with a scenario that fails when its fix is reverted (the revert check is in the scenario's `description`, and was run by hand once), or a line on why it cannot be simulated. Add a row when you close a bug.

| Bug | Scenario | Revert check, and what then fails |
|---|---|---|
| Status key says Orca plugin missing while the install probe is pending; installed but asleep reads slow | `b-status`, `b-plugin-installed-asleep` | pending probe mapped to missing, or the asleep branch dropped (`bridge.ts`): key 14 reads "Orca plugin missing" / "Install the Orca plugin" |
| a pushed status stays on a key after Orca dropped the agent row (tmux) | `b-stale-push` | never expire a pushed status (`bridged-adapter.ts`): key 1 stays completed instead of idle |
| a turn that ends with a question reads done | `b-awaiting-reply` | `awaitingOf` never reports a question (`adapter-cli`): key 1 reads completed/done instead of awaiting reply/asks you |
| Orca restart rotates terminal handles | `b-orca-restart`, `b-orca-restart-press` (a press in the same instant retries with the fresh handle; + `a-idle-out-reconnect`, `a-b-restart` for the reconnects) | focus with a generation-1 handle (`deck.ts`): the press never focuses the pane |
| Lazy wake: the event that woke plugin A is kept | `a-lazy-wake` | `onAck` replay removed (`main.mjs`): no agentStatus after B returns |
| Plugin B restarts, A reconnects | `a-b-restart` | no reconnect scheduled (`main.mjs`): no hello after B restarts |
| Hold with Orca showing a paired server says "Remote pane: use the picker" | `b-hold-remote` | hint dropped (`deck.ts`): the key says "No pane selected in Orca" |
| Needs-input reads the same by push and by poll | `b-needs-input-label` | tool name back in `lineTwo`: poll reads "permission" |
| last-good host list, released panes off auto-fill | none: auto-fill is off in the shipped plugin, and a failing host list needs a paired Orca environment that the simulation does not model (unit tests in `adapter-cli` and `core`) | |
| agent swapped inside a tmux pane | none: superseded by the owner's decision of one agent per tmux session | |
| coalesced refreshes, instant press feedback | none: the focus highlight and timings are not part of the semantic key state (unit tests in `core`) | |
| Sleep/wake and Wi-Fi drops after an Orca restart | none: the simulation can restart Orca but not suspend the machine | |
| Codex's shared daemon reports to one pane (known-issues.md) | none: it is Codex's behaviour; the deck draws what Orca reports | |

## Run
- `pnpm replay [file|dir ...]` or `make replay` (all scenarios); `--update` (`make replay ARGS=--update`) rewrites the snapshots - read the diff before committing it.
- `pnpm test` runs every sim scenario and the loader tests (`replay.test.ts`); `make replay-a` runs the `a` ones, `make replay-b` the `b` ones.

## Write or record
- Write: copy a scenario, change the steps, add the `expect` for the behaviour, run with `--update`, check the timeline reads right.
- Record: the recorder writes the same header and steps, with real timestamps turned into `at` relative to the first event, `orca.event` / `bridge.frame` for what it saw, and no terminal content. Add the `expect` lines by hand.
