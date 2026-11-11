import { header, stepSchema, type Side, type Step } from './schema.ts';

/**
 * Turns a sanitized event log into a replay scenario (docs/replay.md, "Write or record").
 * The log is NDJSON, one object per line, `ts` in epoch milliseconds:
 *   {"ts":1800000000000,"kind":"orca.event","name":"agent.status.changed","payload":{...}}
 *   {"ts":1800000000120,"kind":"bridge.frame","from":"a","frame":{...}}
 * The recorder drops what must never reach a committed file: terminal content and anything token-like. A field
 * is removed by name, a string that looks like a secret is replaced, and the handshake frames are left out
 * (the runners do their own). It reports what it removed, never the values.
 */

/** Field names that carry terminal content or credentials, matched case-insensitively anywhere in a payload. */
const DROP_KEYS = new Set([
  'lastassistantmessage',
  'lastmessage',
  'message',
  'preview',
  'content',
  'text',
  'output',
  'prompt',
  'authtoken',
  'token',
  'secret',
  'password',
  'nonce',
  'mac',
]);
/** Handshake frames carry nonces and MACs; they are not part of what a scenario describes. */
const HANDSHAKE = new Set(['hello', 'helloAck', 'challenge', 'auth']);
/** 32 or more hex characters, or a long base64-ish run, is treated as a secret. */
const SECRET_LIKE = /^(?:[0-9a-f]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})$/i;

export interface Recorded {
  /** The scenario, NDJSON, ready to commit once `expect.*` lines are added. */
  text: string;
  /** What was removed: `<path>` of each dropped field or redacted value, and skipped handshake frames. */
  removed: string[];
}

function clean(value: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(value)) return value.map((v, i) => clean(v, `${path}[${i}]`, removed));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k.toLowerCase())) {
        removed.push(`${path}.${k}`);
        continue;
      }
      out[k] = clean(v, `${path}.${k}`, removed);
    }
    return out;
  }
  if (typeof value === 'string' && SECRET_LIKE.test(value)) {
    removed.push(path);
    return '<redacted>';
  }
  return value;
}

export function recordScenario(
  log: string,
  opts: { name: string; description?: string; sides?: Side[] },
): Recorded {
  const removed: string[] = [];
  const lines = log.split('\n').flatMap((l, i) => (l.trim() ? [{ n: i + 1, l }] : []));
  if (!lines.length) throw new Error('empty event log');
  const steps: Step[] = [];
  let t0: number | undefined;
  for (const { n, l } of lines) {
    let e: { ts?: unknown; kind?: unknown; [k: string]: unknown };
    try {
      e = JSON.parse(l);
    } catch {
      throw new Error(`event log line ${n}: not valid JSON`);
    }
    if (typeof e.ts !== 'number') throw new Error(`event log line ${n}: ts must be a number`);
    t0 ??= e.ts;
    const at = Math.max(0, Math.round(e.ts - t0));
    const where = `line ${n}`;
    let raw: unknown;
    if (e.kind === 'orca.event') {
      raw = {
        at,
        do: 'orca.event',
        name: e['name'],
        payload: clean(e['payload'] ?? {}, `${where}.payload`, removed),
      };
    } else if (e.kind === 'bridge.frame') {
      const frame = (e['frame'] ?? {}) as { type?: unknown };
      if (typeof frame.type === 'string' && HANDSHAKE.has(frame.type)) {
        removed.push(`${where}: ${frame.type} frame skipped`);
        continue;
      }
      raw = {
        at,
        do: 'bridge.frame',
        from: e['from'],
        frame: clean(frame, `${where}.frame`, removed),
      };
    } else {
      throw new Error(`event log line ${n}: unknown kind ${JSON.stringify(e.kind)}`);
    }
    const r = stepSchema.safeParse(raw);
    if (!r.success)
      throw new Error(
        `event log line ${n}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    steps.push(r.data);
  }
  const head = header.parse({
    v: 2,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    sides: opts.sides ?? ['a'],
    keys: {},
  });
  return {
    text: [head, ...steps].map((x) => JSON.stringify(x)).join('\n') + '\n',
    removed,
  };
}
