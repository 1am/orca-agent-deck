import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScenario } from './load.ts';
import { DROP_KEYS, SECRET_LIKE, recordScenario } from './record.ts';

const SECRET = 'a'.repeat(64);
const log = [
  {
    ts: 1_800_000_000_000,
    kind: 'orca.event',
    name: 'agent.status.changed',
    payload: {
      paneKey: 'tab-1:leaf-a',
      mainAgent: { state: 'working', lastAssistantMessage: 'rm -rf the secret plan', preview: 'x' },
      authToken: SECRET,
    },
  },
  { ts: 1_800_000_000_050, kind: 'bridge.frame', from: 'a', frame: { type: 'hello', nonce: 'n' } },
  {
    ts: 1_800_000_000_120,
    kind: 'bridge.frame',
    from: 'a',
    frame: { type: 'agentStatus', paneKey: 'tab-1:leaf-a', state: 'working', note: SECRET },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n');

describe('recordScenario', () => {
  const r = recordScenario(log, { name: 'permission-cycle', description: 'one cycle' });

  it('writes a scenario the loader accepts, with `at` relative to the first event', () => {
    const sc = parseScenario(r.text);
    expect(sc.header.name).toBe('permission-cycle');
    expect(sc.steps.map((s) => [s.at, s.do])).toEqual([
      [0, 'orca.event'],
      [120, 'bridge.frame'],
    ]);
  });

  it('keeps no terminal content, no token and no handshake frame, and says what it removed', () => {
    expect(r.text).not.toContain('secret plan');
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain('nonce');
    expect(r.text).toContain('"state":"working"');
    expect(r.removed).toEqual(
      expect.arrayContaining([
        'line 1.payload.mainAgent.lastAssistantMessage',
        'line 1.payload.mainAgent.preview',
        'line 1.payload.authToken',
        'line 2: hello frame skipped',
        'line 3.frame.note',
      ]),
    );
    expect(r.removed.join('\n')).not.toContain('rm -rf');
  });

  it('refuses a malformed log with the line number', () => {
    expect(() => recordScenario('{"ts":1,"kind":"nope"}', { name: 'x' })).toThrow(
      /line 1: unknown kind/,
    );
    expect(() => recordScenario('not json', { name: 'x' })).toThrow(/line 1: not valid JSON/);
    expect(() =>
      recordScenario('{"ts":1,"kind":"bridge.frame","from":"c","frame":{}}', { name: 'x' }),
    ).toThrow(/line 1: from/);
  });
});

// Plugin A records at write time with its own copy of the drop list (it ships as plain JS): the two must agree.
const plugin = '../../../../orca-plugin/main.mjs';
interface A {
  RECORD_DROP_KEYS: string[];
  RECORD_SECRET_LIKE: RegExp;
  createRecorder(o: {
    dir: string;
    maxBytes?: number;
    maxMs?: number;
    onStop?: (file: string, why: string) => void;
  }): {
    active: boolean;
    start(): Promise<string>;
    stop(why?: string): string | null;
    event(name: string, payload?: unknown): void;
    frame(from: string, frame: unknown): void;
    flush(): Promise<void>;
  };
}
const loadA = async () => (await import(/* @vite-ignore */ plugin)) as A;

describe('plugin A recording', () => {
  it('drops the same fields and redacts the same strings as the recorder', async () => {
    const a = await loadA();
    expect([...a.RECORD_DROP_KEYS].sort()).toEqual([...DROP_KEYS].sort());
    expect(a.RECORD_SECRET_LIKE.source).toBe(SECRET_LIKE.source);
    expect(a.RECORD_SECRET_LIKE.flags).toBe(SECRET_LIKE.flags);
  });

  it('writes sanitized lines to a private file and stops at the size limit', async () => {
    const a = await loadA();
    const dir = await mkdtemp(join(tmpdir(), 'rec-'));
    const stops: string[] = [];
    const rec = a.createRecorder({
      dir,
      maxBytes: 400,
      onStop: (_f: string, why: string) => stops.push(why),
    });
    const file = await rec.start();
    rec.event('agent.status.changed', {
      paneKey: 't:a',
      mainAgent: { lastAssistantMessage: 'secret plan' },
    });
    rec.frame('a', { type: 'agentStatus', token: 'x'.repeat(10) });
    expect(rec.active).toBe(true);
    for (let i = 0; i < 20; i++) rec.frame('a', { type: 'agentStatus', paneKey: `t:${i}` });
    expect(rec.active).toBe(false);
    expect(stops).toEqual(['size limit reached']);
    await rec.flush();
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('secret plan');
    expect(text).not.toContain('token');
    expect(text).toContain('"kind":"orca.event"');
    expect(await readdir(dir)).toHaveLength(1);
    // Nothing is written once stopped.
    rec.event('agent.status.changed', { paneKey: 't:late' });
    await rec.flush();
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('stops after the time limit', async () => {
    const a = await loadA();
    const stops: string[] = [];
    const rec = a.createRecorder({
      dir: await mkdtemp(join(tmpdir(), 'rec-')),
      maxMs: 20,
      onStop: (_f: string, why: string) => stops.push(why),
    });
    await rec.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(rec.active).toBe(false);
    expect(stops).toEqual(['time limit reached']);
  });
});
