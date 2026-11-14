import { z } from 'zod';

/** Bridge protocol v1. Plugin A (in Orca) <-> plugin B (Stream Deck plugin, WebSocket server). */
export const PROTOCOL_VERSION = 1;

/**
 * Minor version: additive features of the same major (new frames, optional fields). Each side
 * advertises its own in `hello` / `helloAck`; a peer that sends none speaks minor 0 (v0.2.x).
 * 1: the Orca panel's deck grid (`requestDeck`, `deckState`, `assignKey`, `unmapKey`).
 * 2: B opens the Orca panel on A's request (`openPanel`, `openPanelResult`).
 * 3: a deck press selects the key in the Orca panel while it is open for mapping (`panelSelect`, `keyPicked`).
 * 4: holding a key opens the panel at that key (`keyPicked` after `openPanel`); the deck's own map mode is gone, so
 *    `pairRequest`, `pairCancel`, `unmapRequest` and `pairState` are no longer sent or read (an A that still sends one is ignored).
 *    `deckState.layout` (what sits at every position of the deck) is an additive optional field of the same minor.
 */
export const PROTOCOL_MINOR = 4;

/** Thrown for a message whose major `v` we do not speak; B shows "update Agent Deck for Orca plugin". */
export class UnsupportedVersionError extends Error {
  readonly received: unknown;
  constructor(received: unknown) {
    super(`unsupported bridge protocol version: ${String(received)}`);
    this.name = 'UnsupportedVersionError';
    this.received = received;
  }
}

const base = <T extends string>(type: T) =>
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal(type) });

// A -> B
export const hello = base('hello').extend({
  orcaVersion: z.string(),
  pluginVersion: z.string(),
  minor: z.number().int().nonnegative().optional(),
});
/** HMAC-SHA256(token, nonceB || nonceA) as hex, answering B's `challenge`. */
export const auth = base('auth').extend({ nonce: z.string(), mac: z.string() });
export const agentStatus = base('agentStatus').extend({
  paneKey: z.string(),
  workspaceId: z.string(),
  state: z.string(),
  outcome: z.string().nullish(),
  stateStartedAt: z.number(),
  receivedAt: z.number(),
  /** Harness id (claude, codex, pi) when Orca's event has it; optional, so v1 stays compatible. */
  agentType: z.string().nullish(),
});
/** No longer sent (A dropped the workspace:read capability); still parsed so an older A build stays compatible. */
export const workspace = base('workspace').extend({
  event: z.enum(['created', 'removed']),
  workspaceId: z.string(),
  path: z.string(),
});
/** Minor 1: A asks B to send `deckState` now (the Orca panel opened). */
export const requestDeck = base('requestDeck');
const key = z.number().int().min(1);
/**
 * Minor 1: put a pane on key `key` (1-based, row-major): the pane `paneKey` names (one of `deckState.panes`),
 * else the focused one. A key that shows a pane needs `replace`.
 */
export const assignKey = base('assignKey').extend({
  requestId: z.string(),
  key,
  replace: z.boolean(),
  paneKey: z.string().optional(),
  /** The pane's host (`deckState.panes[].hostId`): tab and leaf ids repeat across hosts. */
  hostId: z.string().optional(),
});
/** Minor 1: empty key `key`. */
export const unmapKey = base('unmapKey').extend({ requestId: z.string(), key });
/** Minor 2: A asks B to show its sidebar panel `panelId` (B calls Orca's `plugins.open`; A has no call for it). */
export const openPanel = base('openPanel').extend({ requestId: z.string(), panelId: z.string() });
/** Minor 3: the Orca panel is in view and open for mapping (`on`), or no longer; B then sends `keyPicked` on a tap. */
export const panelSelect = base('panelSelect').extend({ on: z.boolean() });

// B -> A
/** First message on every connection: B's nonce. A answers with `auth`, B proves itself with `proof`. */
export const challenge = base('challenge').extend({ nonce: z.string() });
/** HMAC-SHA256(token, nonceA || nonceB) as hex. A sends nothing else until this checks out. */
export const proof = base('proof').extend({ mac: z.string() });
export const helloAck = base('helloAck').extend({
  deck: z.object({
    connected: z.boolean(),
    devices: z.array(z.object({ model: z.string(), keys: z.number() })),
  }),
  minor: z.number().int().nonnegative().optional(),
});
/** Minor 1: the deck as the Orca panel draws it; pushed after `hello`, on change and on `requestDeck`. */
export const deckState = base('deckState').extend({
  connected: z.boolean(),
  model: z.string().nullable(),
  cols: z.number().int().min(0),
  rows: z.number().int().min(0),
  keys: z.array(z.object({ key, label: z.string(), state: z.string(), mapped: z.boolean() })),
  /**
   * What sits at every position of the deck (`cols * rows` entries, 1-based row-major, sorted): `pane`, our `status` or
   * `attention` key, or `other` (empty, or another plugin's action: the SDK does not say). Absent from an older B.
   */
  layout: z
    .array(z.object({ key, kind: z.enum(['pane', 'status', 'attention', 'other']) }))
    .optional(),
  /** The panes the panel offers for a key (at most 200, the focused one first); absent from an older B. */
  panes: z
    .array(
      z.object({
        paneKey: z.string(),
        /** Execution host id, sent back in `assignKey`; absent from an older B. */
        hostId: z.string().optional(),
        /** Repo and branch, or the pane's title when it has neither. */
        label: z.string(),
        /** Pane title and tab: what tells two panes of one worktree apart. */
        detail: z.string(),
        /** Host name of a remote pane. */
        host: z.string().optional(),
        /** The address behind a connection label, searchable; absent when the host is shown by its address. */
        hostAddress: z.string().optional(),
        agent: z.string().nullable(),
        state: z.string(),
        remote: z.boolean(),
        focused: z.boolean(),
        /** Orca shows a paired server (no focus to read) and this pane was last opened from the deck there. */
        lastPressed: z.boolean().optional(),
        /** The 1-based key the pane is on, when it is on one. */
        onKey: z.number().int().min(1).optional(),
      }),
    )
    .optional(),
});
/** Minor 2: the answer to `openPanel`. `unavailable`: Orca's runtime cannot be reached; `refused`: it did not open the panel. */
export const openPanelResult = base('openPanelResult')
  .extend({ requestId: z.string() })
  .and(
    z.union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), reason: z.enum(['unavailable', 'refused']) }),
    ]),
  );
/** Minor 3: a key tapped on the deck while `panelSelect` is on, or (minor 4) held, after `openPanel`: the panel opens its details. */
export const keyPicked = base('keyPicked').extend({ key });
export const requestSnapshot = base('requestSnapshot');
const slot = z.object({ page: z.number().int().min(1), index: z.number().int().min(1) });
export const pairResult = base('pairResult')
  .extend({ requestId: z.string() })
  .and(
    z.union([
      z.object({
        ok: z.literal(true),
        slot,
        /** Minor 1: what happened to the key (absent from an older B). */
        action: z.enum(['mapped', 'moved', 'unmapped']).optional(),
      }),
      z.object({
        ok: z.literal(false),
        reason: z.enum([
          'timeout',
          'cancelled',
          'noFocusedPane',
          'deckOffline',
          'noSuchKey',
          'occupied',
          'noSuchPane',
        ]),
      }),
    ]),
  );

export const messageFromA = z.union([
  hello,
  auth,
  agentStatus,
  workspace,
  requestDeck,
  assignKey,
  unmapKey,
  openPanel,
  panelSelect,
]);
export const messageFromB = z.union([
  challenge,
  proof,
  helloAck,
  requestSnapshot,
  pairResult,
  deckState,
  openPanelResult,
  keyPicked,
]);

export type MessageFromA = z.infer<typeof messageFromA>;
export type MessageFromB = z.infer<typeof messageFromB>;

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const v = typeof raw === 'object' && raw !== null ? (raw as { v?: unknown }).v : undefined;
  if (v !== PROTOCOL_VERSION) throw new UnsupportedVersionError(v);
  return schema.parse(raw);
}

/** Parse a message received by B. Unknown major `v` throws UnsupportedVersionError; malformed throws ZodError. */
export const parseFromA = (raw: unknown): MessageFromA => parse(messageFromA, raw);
/** Parse a message received by A. */
export const parseFromB = (raw: unknown): MessageFromB => parse(messageFromB, raw);
