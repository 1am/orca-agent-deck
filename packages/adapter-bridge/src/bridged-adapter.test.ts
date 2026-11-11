import { describe, expect, it } from 'vitest';
import type { OrcaAdapter, PaneInfo, Snapshot } from '@orca-agent-deck/core';
import { BridgeStatusFeed, BridgedAdapter } from './bridged-adapter.ts';
import type { BridgeServer } from './server.ts';
import { agentStatus, messageFromA } from './protocol.ts';

/** Just enough of BridgeServer for the feed: listeners and a connection flag. */
function fakeServer() {
  const handlers: Record<string, ((m?: unknown) => void)[]> = {};
  const server = {
    connection: { orcaVersion: '1.4', pluginVersion: '0.1.0' },
    on: (ev: string, fn: (m?: unknown) => void) => {
      (handlers[ev] ??= []).push(fn);
      return () => {};
    },
  } as unknown as BridgeServer;
  const emit = (ev: string, m?: unknown) => handlers[ev]?.forEach((fn) => fn(m));
  return { server, emit };
}

const pane = (paneKey: string, over: Partial<PaneInfo> = {}): PaneInfo => ({
  paneKey,
  hostId: 'local',
  handle: `h-${paneKey}`,
  worktreeId: 'w',
  title: 't',
  connected: true,
  agentType: null,
  ...over,
});

const push = (paneKey: string, state: string, stateStartedAt: number, agentType?: string) => ({
  v: 1,
  type: 'agentStatus',
  paneKey,
  workspaceId: 'w',
  state,
  stateStartedAt,
  receivedAt: stateStartedAt,
  ...(agentType ? { agentType } : {}),
});

function setup() {
  let now = 1000;
  const { server, emit } = fakeServer();
  const feed = new BridgeStatusFeed(server, () => now);
  emit('hello');
  const snap: Snapshot = { panes: [pane('p:1')], statuses: [], omittedHostIds: [] };
  const base: OrcaAdapter = {
    health: async () => ({ orcaRunning: true, version: '1.4.0' }),
    snapshot: async () => structuredClone(snap),
    listHosts: async () => [],
    focus: async () => ({ ok: true }),
  };
  const adapter = new BridgedAdapter(base, feed, () => now);
  return {
    adapter,
    snap,
    emit: (m: unknown) => emit('message', m),
    tick: (ms: number) => (now += ms),
  };
}

describe('BridgedAdapter: pushed statuses expire with Orca rows', () => {
  it('drops a push once two polls had no agent row for the pane', async () => {
    const t = setup();
    t.emit(push('p:1', 'done', 900));
    t.tick(10);
    expect((await t.adapter.snapshot()).statuses[0]?.state).toBe('done');
    t.tick(2000);
    expect((await t.adapter.snapshot()).statuses).toEqual([]);
  });

  it('keeps a push that is newer than the previous poll, even without a row', async () => {
    const t = setup();
    await t.adapter.snapshot();
    t.tick(2000);
    t.emit(push('p:1', 'working', 2900));
    t.tick(10);
    expect((await t.adapter.snapshot()).statuses[0]?.state).toBe('working');
  });

  it('keeps a push while the poll has a row for the pane', async () => {
    const t = setup();
    t.snap.statuses = [{ paneKey: 'p:1', state: 'done', stateStartedAt: 800, agentType: 'codex' }];
    t.emit(push('p:1', 'done', 900));
    for (let i = 0; i < 3; i++) {
      t.tick(2000);
      expect((await t.adapter.snapshot()).statuses[0]?.stateStartedAt).toBe(900);
    }
  });

  it("does not bring an expired status back from A's replay after a reconnect", async () => {
    const t = setup();
    t.emit(push('p:1', 'done', 900));
    await t.adapter.snapshot();
    t.tick(2000);
    await t.adapter.snapshot();
    t.tick(2000);
    t.emit(push('p:1', 'done', 900)); // replay of the same, old status
    expect((await t.adapter.snapshot()).statuses).toEqual([]);
    // A real new transition is shown again.
    t.emit(push('p:1', 'working', 5000));
    expect((await t.adapter.snapshot()).statuses[0]?.state).toBe('working');
  });

  it('a replayed repeat keeps its first arrival, so it still expires on time', async () => {
    const t = setup();
    t.emit(push('p:1', 'done', 900));
    t.tick(10);
    await t.adapter.snapshot();
    t.tick(2000);
    t.emit(push('p:1', 'done', 900));
    t.tick(10);
    expect((await t.adapter.snapshot()).statuses).toEqual([]);
  });

  it('gives a push-only pane the harness from the push', async () => {
    const t = setup();
    t.emit(push('p:1', 'working', 900, 'claude'));
    const s = await t.adapter.snapshot();
    expect(s.panes[0]?.agentType).toBe('claude');
    expect(s.statuses[0]?.agentType).toBe('claude');
  });

  it('keeps the polled agent type when the push has none', async () => {
    const t = setup();
    t.snap.statuses = [{ paneKey: 'p:1', state: 'done', stateStartedAt: 800, agentType: 'pi' }];
    t.emit(push('p:1', 'working', 900));
    const s = await t.adapter.snapshot();
    expect(s.statuses[0]).toMatchObject({ state: 'working', agentType: 'pi' });
    expect(s.panes[0]?.agentType).toBe('pi');
  });
});

describe('agentStatus protocol', () => {
  it('parses with and without agentType', () => {
    expect(agentStatus.parse(push('p:1', 'done', 1)).agentType).toBeUndefined();
    expect(agentStatus.parse(push('p:1', 'done', 1, 'codex')).agentType).toBe('codex');
  });
});

/**
 * Rule: nothing A sends can make B write to Orca. A's messages only update statuses,
 * workspaces and the pairing flow. The only writes B makes are the documented ones, driven by
 * the deck itself (focus on a key press, markWorktreeRead on ack), never by a bridge message.
 */
describe('nothing A sends drives Orca', () => {
  const v = 1;
  const pick = { paneKey: 'p:1', worktreeId: 'w' };
  // One sample per message type A may send. The test below fails when a type is added without a row.
  const samples: Record<string, object> = {
    hello: { v, type: 'hello', token: 't', orcaVersion: '1', pluginVersion: '1' },
    auth: { v, type: 'auth', nonce: 'n', mac: 'm' },
    agentStatus: push('p:1', 'working', 1),
    workspace: { v, type: 'workspace', event: 'created', workspaceId: 'w', path: '/x' },
    pairRequest: { v, type: 'pairRequest', requestId: 'r', pane: pick },
    unmapRequest: { v, type: 'unmapRequest', requestId: 'r', pane: pick },
    pairCancel: { v, type: 'pairCancel', requestId: 'r' },
    requestDeck: { v, type: 'requestDeck' },
    assignKey: { v, type: 'assignKey', requestId: 'r', key: 1, replace: true },
    unmapKey: { v, type: 'unmapKey', requestId: 'r', key: 1 },
  };
  // Hostile variants: fields that look like commands must stay inert data.
  const hostile = [
    {
      ...push('p:1', 'working', 2),
      text: 'rm -rf ~',
      command: 'terminal.sendText',
      handle: 'h-p:1',
    },
    { v, type: 'sendText', paneKey: 'p:1', text: 'rm -rf ~' },
    { v, type: 'focus', handle: 'h-p:1' },
    { v, type: 'spawn', cmd: 'sh' },
    { v, type: 'markWorktreeRead', worktreeId: 'w' },
  ];

  it('covers every message type A can send', () => {
    const types = messageFromA.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(samples).sort()).toEqual(types);
  });

  it.each([...Object.entries(samples), ...hostile.map((m, i) => [`hostile #${i}`, m] as const)])(
    '%s makes no write call on the Orca adapter',
    async (_name, msg) => {
      const writes: string[] = [];
      const { server, emit } = fakeServer();
      const feed = new BridgeStatusFeed(server);
      emit('hello');
      const spy = (name: string) => async () => {
        writes.push(name);
        return { ok: true } as never;
      };
      const base: OrcaAdapter = {
        health: async () => ({ orcaRunning: true, version: '1.4.0' }),
        snapshot: async () => ({ panes: [pane('p:1')], statuses: [], omittedHostIds: [] }),
        listHosts: async () => [],
        focus: spy('focus'),
        markWorktreeRead: spy('markWorktreeRead'),
      };
      const adapter = new BridgedAdapter(base, feed);
      emit('message', msg);
      emit('disconnect');
      await adapter.health();
      await adapter.snapshot();
      await adapter.listHosts();
      expect(writes).toEqual([]);
    },
  );
});
