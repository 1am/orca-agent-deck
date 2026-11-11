import { describe, expect, it } from 'vitest';
import { parseScenario } from './load.ts';
import { recordScenario } from './record.ts';

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
