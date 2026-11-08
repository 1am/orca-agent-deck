import { describe, expect, it } from 'vitest';
import { parseFromA, parseFromB, UnsupportedVersionError } from './protocol.ts';

const fromA = [
  { v: 1, type: 'hello', orcaVersion: '1.4.0', pluginVersion: '0.1.0' },
  {
    v: 1,
    type: 'agentStatus',
    paneKey: 'tab1:leaf9',
    workspaceId: 'w',
    state: 'done',
    outcome: 'failure',
    stateStartedAt: 1761800000000,
    receivedAt: 1761800000123,
  },
  { v: 1, type: 'workspace', event: 'created', workspaceId: 'w', path: '/p' },
  { v: 1, type: 'workspace', event: 'removed', workspaceId: 'w', path: '/p' },
  { v: 1, type: 'pairRequest', requestId: 'r1', pane: null },
  { v: 1, type: 'pairRequest', requestId: 'r2', pane: { paneKey: 'k', worktreeId: 'w' } },
  { v: 1, type: 'unmapRequest', requestId: 'r3', pane: null },
  { v: 1, type: 'pairCancel', requestId: 'r1' },
];

const fromB = [
  { v: 1, type: 'helloAck', deck: { connected: true, devices: [{ model: 'mobile', keys: 6 }] } },
  { v: 1, type: 'requestSnapshot' },
  {
    v: 1,
    type: 'pairState',
    requestId: 'r1',
    state: 'waitingForKey',
    pane: { label: 'feature-login › claude' },
  },
  { v: 1, type: 'pairResult', requestId: 'r1', ok: true, slot: { page: 1, index: 5 } },
  { v: 1, type: 'pairResult', requestId: 'r1', ok: false, reason: 'timeout' },
];

describe('bridge protocol v1', () => {
  it.each(fromA)('round-trips A -> B %j', (m) => {
    expect(parseFromA(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it.each(fromB)('round-trips B -> A %j', (m) => {
    expect(parseFromB(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it('rejects an unknown major version with a typed error', () => {
    expect(() => parseFromA({ ...fromA[0], v: 2 })).toThrow(UnsupportedVersionError);
    expect(() => parseFromB({ type: 'requestSnapshot' })).toThrow(UnsupportedVersionError);
  });

  it('rejects malformed or unknown messages', () => {
    expect(() => parseFromA({ v: 1, type: 'hello' })).toThrow();
    expect(() => parseFromA({ v: 1, type: 'nope' })).toThrow();
    expect(() =>
      parseFromB({ v: 1, type: 'pairResult', requestId: 'r', ok: false, reason: 'weird' }),
    ).toThrow();
  });
});
