import { z } from 'zod';

/**
 * Replay scenario format v2: NDJSON, line 1 is the header, every other line one step.
 * `at` is milliseconds on a virtual clock from scenario start (a recorder normalises real timestamps to it).
 * Step kinds are grouped by who produces them: `orca.*` (Orca to plugin A), `deck.*` (Stream Deck host to
 * plugin B), `bridge.*` (the seam between A and B) and `expect.*` (checkpoints).
 */

export const SIDES = ['sim', 'a', 'b'] as const;
export type Side = (typeof SIDES)[number];

/**
 * `keys` is the initial deck layout: key number (1-based, row-major) to pane key (the `pane` ids used by the
 * `orca.*` steps). Every runner plays it as a `willAppear` for each key at t=0 with that pane pinned to it;
 * later layout changes are `deck.appear` / `deck.disappear` steps. Do not invent another mapping mechanism.
 * `sides` lists the runners a scenario targets; a runner skips the others, and inside a targeted
 * scenario an `expect.*` field the runner cannot evaluate is an error, never a pass.
 */
export const header = z
  .object({
    v: z.literal(2),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    description: z.string().optional(),
    sides: z.array(z.enum(SIDES)).min(1),
    keys: z.record(
      z.string().regex(/^[1-9]\d*$/),
      z.union([z.string().min(1), z.object({ action: z.enum(['attention', 'status']) }).strict()]),
    ),
    runtime: z.boolean().default(true),
    /** Layout of the device, default Stream Deck MK.2. */
    deck: z
      .object({ cols: z.number().int().positive(), rows: z.number().int().positive() })
      .strict()
      .default({ cols: 5, rows: 3 }),
  })
  .strict();

const at = z.number().int().nonnegative();
const pane = z.string().min(1);
const key = z.number().int().positive();
const json = z.record(z.unknown());

/** Mirrors the names and values of Orca's `agent.status.changed` payload (`mainAgent`), as a recording has them. */
const agentState = z.enum(['working', 'waiting', 'blocked', 'done', 'idle']);

const step = <K extends string, T extends z.ZodRawShape>(kind: K, shape: T) =>
  z.object({ at, do: z.literal(kind), ...shape }).strict();

export const stepSchema = z.discriminatedUnion('do', [
  step('orca.pane.add', {
    pane,
    agent: z.string().nullable().optional(),
    title: z.string().optional(),
    host: z.string().optional(),
  }),
  step('orca.pane.remove', { pane }),
  step('orca.agent', {
    pane,
    state: agentState,
    outcome: z.string().nullable().optional(),
    toolName: z.string().nullable().optional(),
    /** The agent's last message as `worktree ps` reports it (`lastAssistantMessage`); a final question makes the key ask. */
    message: z.string().optional(),
  }),
  step('orca.host.add', { id: z.string(), kind: z.enum(['local', 'ssh']), name: z.string() }),
  step('orca.host.set', { id: z.string(), connected: z.boolean() }),
  step('orca.restart', {}),
  /** What `orca plugin list` reports for a plugin (the Orca plugin A is `1am.agent-deck`); `absent` removes it. */
  step('orca.plugin', { key: z.string(), status: z.enum(['enabled', 'disabled', 'absent']) }),
  /** Orca selects this pane (what hold-to-assign reads). */
  step('orca.focus', { pane }),
  /** Plugin A's worker (re)starts, as Orca does for the next event after it idled out; `orca.deactivate` is the idle-out. */
  step('orca.activate', {}),
  step('orca.deactivate', {}),
  /** A command from the palette; `result` is the text Orca shows as its toast. */
  step('orca.command', {
    id: z.string(),
    args: json.optional(),
    result: z.string().optional(),
    resultContains: z.string().optional(),
  }),
  /** A raw plugin event or runtime frame as Orca emits it (plugin A suite). */
  step('orca.event', { name: z.string(), payload: json }),
  step('deck.appear', { key, pane: pane.optional() }),
  step('deck.disappear', { key }),
  step('deck.down', { key }),
  step('deck.up', { key }),
  /** The user selects this key: the host sends propertyInspectorDidAppear (and Disappear for the previous one). */
  step('deck.pi.open', { key }),
  /** The property inspector of this key sends a message to the plugin. */
  step('deck.pi.send', { key, message: json }),
  step('deck.device', { id: z.string(), connected: z.boolean() }),
  /**
   * Plugin B restarts (new token); `up: false` stops it and leaves its discovery file behind, as a crash does.
   * For plugin B's suite it is the host restarting the plugin, optionally as another host: `profile` is a profile id or a family (`elgato`, `opendeck`), resolved to that family's profile for this OS.
   */
  step('deck.restart', { up: z.boolean().optional(), profile: z.string().optional() }),
  /**
   * A frame on the A-B seam. `from: "a"` is expected: frames A sends at that instant, in order, each matching the listed
   * fields (a subset). `from: "b"` is sent by the fake B; the string `"$requestId"` stands for A's last pairing request id.
   */
  step('bridge.frame', { from: z.enum(['a', 'b']), frame: json }),
  step('expect.key', {
    key,
    state: z.string().optional(),
    label: z.string().optional(),
    line2: z.string().optional(),
    host: z.string().nullable().optional(),
    badge: z.string().nullable().optional(),
    number: z.string().optional(),
  }),
  /** The messages the plugin sent to this key's property inspector since the last checkpoint: same count and order, each a subset. */
  step('expect.pi', { key, messages: z.array(json) }),
  /** Plugin A: the toast or log lines the worker wrote so far contain this text. */
  step('expect.log', { contains: z.string() }),
  /** Plugin A: a path under the worker's HOME exists (or not). */
  step('expect.file', { path: z.string(), exists: z.boolean() }),
  step('expect.focus', { pane }),
  step('expect.reveal', { pane }),
]);

export type Header = z.infer<typeof header>;
export type Step = z.infer<typeof stepSchema>;
export interface Scenario {
  header: Header;
  steps: Step[];
}
