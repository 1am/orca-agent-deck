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
  { v: 1, type: 'hello', orcaVersion: 'api 1.0', pluginVersion: '0.3.0', minor: 1 },
  { v: 1, type: 'requestDeck' },
  { v: 1, type: 'assignKey', requestId: 'r4', key: 3, replace: false },
  { v: 1, type: 'assignKey', requestId: 'r6', key: 2, replace: true, paneKey: 'a:1' },
  { v: 1, type: 'unmapKey', requestId: 'r5', key: 3 },
  { v: 1, type: 'openPanel', requestId: 'r7', panelId: 'deck' },
  { v: 1, type: 'panelSelect', on: true },
];

const fromB = [
  { v: 1, type: 'helloAck', deck: { connected: true, devices: [{ model: 'mobile', keys: 6 }] } },
  { v: 1, type: 'requestSnapshot' },
  { v: 1, type: 'openPanelResult', requestId: 'r7', ok: true },
  { v: 1, type: 'openPanelResult', requestId: 'r7', ok: false, reason: 'refused' },
  { v: 1, type: 'keyPicked', key: 3 },
  { v: 1, type: 'pairResult', requestId: 'r1', ok: true, slot: { page: 1, index: 5 } },
  { v: 1, type: 'pairResult', requestId: 'r1', ok: false, reason: 'timeout' },
  { v: 1, type: 'helloAck', deck: { connected: false, devices: [] }, minor: 1 },
  {
    v: 1,
    type: 'pairResult',
    requestId: 'r4',
    ok: true,
    slot: { page: 1, index: 3 },
    action: 'unmapped',
  },
  { v: 1, type: 'pairResult', requestId: 'r4', ok: false, reason: 'occupied' },
  { v: 1, type: 'pairResult', requestId: 'r4', ok: false, reason: 'noSuchKey' },
  { v: 1, type: 'pairResult', requestId: 'r6', ok: false, reason: 'noSuchPane' },
  {
    v: 1,
    type: 'deckState',
    connected: true,
    model: '9',
    cols: 5,
    rows: 3,
    keys: [
      { key: 1, label: 'agent-deck/main', state: 'working', mapped: true },
      { key: 2, label: '', state: 'unmapped', mapped: false },
    ],
    layout: [
      { key: 1, kind: 'pane' },
      { key: 2, kind: 'pane' },
      { key: 3, kind: 'status' },
      { key: 4, kind: 'attention' },
      { key: 5, kind: 'other' },
    ],
    panes: [
      {
        paneKey: 'a:1',
        label: 'agent-deck / main',
        detail: 'build-1 · Tab 1',
        agent: 'claude',
        state: 'working',
        remote: true,
        focused: true,
        onKey: 1,
      },
    ],
  },
];

describe('minor 1 stays readable by minor 0', () => {
  it('a v0.2.x hello and helloAck, with no minor, still parse', () => {
    expect(
      parseFromA({ v: 1, type: 'hello', orcaVersion: '1.4.0', pluginVersion: '0.2.1' }),
    ).not.toHaveProperty('minor');
    expect(
      parseFromB({ v: 1, type: 'helloAck', deck: { connected: true, devices: [] } }),
    ).not.toHaveProperty('minor');
  });

  it('rejects a key below 1 and a missing replace flag', () => {
    expect(() =>
      parseFromA({ v: 1, type: 'assignKey', requestId: 'r', key: 0, replace: false }),
    ).toThrow();
    expect(() => parseFromA({ v: 1, type: 'assignKey', requestId: 'r', key: 1 })).toThrow();
  });
});

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
