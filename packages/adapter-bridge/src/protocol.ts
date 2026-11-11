import { z } from 'zod';

/** Bridge protocol v1. Plugin A (in Orca) <-> plugin B (Stream Deck plugin, WebSocket server). */
export const PROTOCOL_VERSION = 1;

/**
 * Minor version: additive features of the same major (new frames, optional fields). Each side
 * advertises its own in `hello` / `helloAck`; a peer that sends none speaks minor 0 (v0.2.x).
 * 1: the Orca panel's deck grid (`requestDeck`, `deckState`, `assignKey`, `unmapKey`).
 */
export const PROTOCOL_MINOR = 1;

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

const panePick = z.object({ paneKey: z.string(), worktreeId: z.string() });

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
export const workspace = base('workspace').extend({
  event: z.enum(['created', 'removed']),
  workspaceId: z.string(),
  path: z.string(),
});
/** `pane: null` lets B resolve the focused pane. */
export const pairRequest = base('pairRequest').extend({
  requestId: z.string(),
  pane: panePick.nullable(),
});
export const unmapRequest = base('unmapRequest').extend({
  requestId: z.string(),
  pane: panePick.nullable(),
});
export const pairCancel = base('pairCancel').extend({ requestId: z.string() });
/** Minor 1: A asks B to send `deckState` now (the Orca panel opened). */
export const requestDeck = base('requestDeck');
const key = z.number().int().min(1);
/** Minor 1: put the focused pane on key `key` (1-based, row-major). A key that shows a pane needs `replace`. */
export const assignKey = base('assignKey').extend({
  requestId: z.string(),
  key,
  replace: z.boolean(),
});
/** Minor 1: empty key `key`. */
export const unmapKey = base('unmapKey').extend({ requestId: z.string(), key });

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
});
export const requestSnapshot = base('requestSnapshot');
export const pairState = base('pairState').extend({
  requestId: z.string(),
  state: z.string(),
  pane: z.object({ label: z.string() }).optional(),
});
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
        ]),
      }),
    ]),
  );

export const messageFromA = z.union([
  hello,
  auth,
  agentStatus,
  workspace,
  pairRequest,
  unmapRequest,
  pairCancel,
  requestDeck,
  assignKey,
  unmapKey,
]);
export const messageFromB = z.union([
  challenge,
  proof,
  helloAck,
  requestSnapshot,
  pairState,
  pairResult,
  deckState,
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
