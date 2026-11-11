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

  it('fills the workspace fields Orca requires and the recorder never writes', () => {
    const w = recordScenario(
      '{"ts":1,"kind":"orca.event","name":"workspace.created","payload":{"workspaceId":"w1"}}',
      { name: 'ws' },
    );
    const line = JSON.parse(w.text.trim().split('\n')[1]!);
    expect(line.payload).toEqual({
      kind: 'worktree',
      path: '/recorded',
      branch: 'recorded',
      workspaceId: 'w1',
    });
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
  RECORD_EVENT_FIELDS: Record<string, unknown>;
  RECORD_FRAME_FIELDS: Record<string, unknown>;
  pickFields(value: unknown, spec: unknown): Record<string, unknown>;
  toAgentStatus(ev: unknown, now?: number): unknown;
  sanitizeForRecording(value: unknown): unknown;
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

  it('writes only allow-listed fields, to a private file, and stops at the size limit', async () => {
    const a = await loadA();
    const dir = await mkdtemp(join(tmpdir(), 'rec-'));
    const stops: string[] = [];
    const rec = a.createRecorder({
      dir,
      maxBytes: 600,
      onStop: (_f: string, why: string) => stops.push(why),
    });
    const file = await rec.start();
    rec.event('agent.status.changed', {
      workspaceId: 'w1',
      paneKey: 't:a',
      state: 'working',
      receivedAt: 1,
      title: 'secret plan',
      terminalId: 'term_1',
      mainAgent: { state: 'working', stateStartedAt: 1, lastAssistantMessage: 'secret plan' },
    });
    rec.event('workspace.created', {
      workspaceId: 'w2',
      kind: 'worktree',
      path: '/Users/ann/acme',
      branch: 'fix/acme-breach',
    });
    rec.frame('a', { type: 'agentStatus', v: 1, paneKey: 't:a', state: 'working', token: 'x' });
    expect(rec.active).toBe(true);
    for (let i = 0; i < 20; i++) rec.frame('a', { type: 'agentStatus', v: 1, paneKey: `t:${i}` });
    expect(rec.active).toBe(false);
    expect(stops).toEqual(['size limit reached']);
    await rec.flush();
    const text = await readFile(file, 'utf8');
    for (const leak of ['secret plan', 'term_1', '/Users/ann', 'acme', 'token'])
      expect(text).not.toContain(leak);
    expect(text).toContain('"kind":"orca.event"');
    expect(text).toContain('"workspaceId":"w2"');
    expect(await readdir(dir)).toHaveLength(1);
    // Nothing is written once stopped.
    rec.event('agent.status.changed', { paneKey: 't:late' });
    await rec.flush();
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('an unknown event or frame type keeps nothing but its type', async () => {
    const a = await loadA();
    const rec = a.createRecorder({ dir: await mkdtemp(join(tmpdir(), 'rec-')) });
    const file = await rec.start();
    rec.event('workspace.changed', { context: { title: 'x' } });
    rec.frame('b', { v: 1, type: 'someNewFrame', detail: 'x' });
    rec.stop();
    await rec.flush();
    const lines = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.payload ?? l.frame)).toEqual([{}, { v: 1, type: 'someNewFrame' }]);
  });

  it('the second line of defence still drops what an allow-listed field might carry', async () => {
    const a = await loadA();
    expect(
      a.sanitizeForRecording({
        state: 'x',
        note: 'a'.repeat(64),
        nested: { token: 't', text: 'y' },
      }),
    ).toEqual({ state: 'x', note: '<redacted>', nested: {} });
  });

  it('keeps nothing the recorder would drop, and nothing the plugin reads is lost', async () => {
    const a = await loadA();
    const names = (spec: unknown): string[] =>
      Object.entries(spec as Record<string, unknown>).flatMap(([k, v]) => [
        k,
        ...(v === 1 ? [] : names(v)),
      ]);
    const allowed = [
      ...Object.values(a.RECORD_EVENT_FIELDS).flatMap(names),
      ...Object.values(a.RECORD_FRAME_FIELDS).flatMap(names),
    ];
    expect(allowed.filter((k) => DROP_KEYS.has(k.toLowerCase()))).toEqual([]);
    // The converter reads the same fields from the recording as from Orca's event.
    const ev = {
      workspaceId: 'w1',
      paneKey: 't:a',
      state: 'done',
      receivedAt: 5,
      agentType: 'claude',
      title: 'x',
      terminalId: 'h',
      mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 3, agentType: 'claude' },
    };
    const kept = a.pickFields(ev, a.RECORD_EVENT_FIELDS['agent.status.changed']);
    expect(a.toAgentStatus(kept, 9)).toEqual(a.toAgentStatus(ev, 9));
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
