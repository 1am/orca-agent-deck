import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeckController, MappingStore } from '../../packages/core/src/index.ts';
import type { Exec } from '../../packages/adapter-cli/src/index.ts';
import { RuntimeClient, makeRuntimeExec } from '../../packages/adapter-runtime/src/index.ts';
import { CliAdapter } from '../../packages/adapter-cli/src/index.ts';
import {
  BridgeServer,
  BridgeStatusFeed,
  BridgedAdapter,
} from '../../packages/adapter-bridge/src/index.ts';
import {
  BridgeSimulator,
  FakeRuntime,
  addPane,
  advance,
  hostList,
  newState,
  setAgent,
  status,
  terminalList,
  worktreePs,
  type SimState,
} from '../../packages/fake-orca/src/index.ts';

let dir: string;
let s: SimState;
let rt: FakeRuntime;
let server: BridgeServer;
let feed: BridgeStatusFeed;
let sim: BridgeSimulator;
let cliCalls: string[][];
let metaPath: string;

const cli: Exec = async (args) => {
  cliCalls.push(args);
  const [x, y] = args;
  if (x === 'terminal' && y === 'list') return JSON.stringify(terminalList(s));
  if (x === 'worktree' && y === 'ps') return JSON.stringify(worktreePs(s));
  if (x === 'host' && y === 'list') return JSON.stringify(hostList(s));
  if (x === 'status') return JSON.stringify(status(s));
  if (x === 'terminal' && y === 'switch') {
    return JSON.stringify({ ok: true, result: { focus: { navigated: true } } });
  }
  throw new Error(`unsupported ${args.join(' ')}`);
};

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const adapter = () =>
  new BridgedAdapter(
    new CliAdapter(makeRuntimeExec({ client: new RuntimeClient({ metaPath }), fallback: cli })),
    feed,
  );
const stateOf = async (a: BridgedAdapter, k: string) =>
  (await a.snapshot()).statuses.find((x) => x.paneKey === k)?.state;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rt-int-'));
  metaPath = join(dir, 'orca-runtime.json');
  s = newState();
  addPane(s, 'a');
  addPane(s, 'b');
  cliCalls = [];
  rt = new FakeRuntime({ state: () => s, sockPath: join(dir, 'rt.sock'), metaPath });
  await rt.start();
  server = new BridgeServer({ discoveryPath: join(dir, 'bridge.json'), ports: [0] });
  feed = new BridgeStatusFeed(server);
  await server.start();
  sim = new BridgeSimulator(join(dir, 'bridge.json'));
});
afterEach(async () => {
  sim.close();
  await server.stop();
  await rt.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('steady state: zero CLI spawns', () => {
  it('runs a whole scenario through bridge + runtime without a single CLI call', async () => {
    const a = adapter();
    await sim.connect();
    for (const [k, st] of [
      ['a', 'working'],
      ['b', 'working'],
      ['b', 'waiting'],
      ['a', 'done'],
      ['b', 'done'],
    ] as const) {
      advance(s, 600);
      setAgent(s, k, st);
      sim.sendStatus(s, k);
      await until(() => feed.status(`tab-1:leaf-${k}`)?.state === st);
      expect(await stateOf(a, `tab-1:leaf-${k}`)).toBe(st);
      await a.health();
    }
    expect(cliCalls).toEqual([]);
    expect(rt.requests.length).toBeGreaterThan(5);
  });

  it('focuses through the socket and the controller reports live', async () => {
    const d = new DeckController(adapter(), new MappingStore());
    await sim.connect();
    await d.refresh([]);
    expect(d.overview().mode).toBe('live');
    const r = await adapter().focus({
      paneKey: 'tab-1:leaf-a',
      hostId: 'local',
      handle: s.panes[0]!.handle,
    });
    expect(r.ok).toBe(true);
    expect(s.focusedHandle).toBe(s.panes[0]!.handle);
    expect(cliCalls).toEqual([]);
  });
});

describe('losing one source keeps the deck correct', () => {
  it('bridge dropped mid-scenario: runtime polling keeps status live, no missed state', async () => {
    const a = adapter();
    await sim.connect();
    advance(s, 500);
    setAgent(s, 'a', 'working');
    sim.sendStatus(s, 'a');
    await until(() => feed.status('tab-1:leaf-a') !== undefined);
    sim.drop();
    await until(() => !feed.connected);
    advance(s, 500);
    setAgent(s, 'a', 'waiting'); // happens while A is away
    expect(await stateOf(a, 'tab-1:leaf-a')).toBe('waiting');
    advance(s, 500);
    setAgent(s, 'a', 'done');
    expect(await stateOf(a, 'tab-1:leaf-a')).toBe('done');
    expect(cliCalls).toEqual([]);
  });

  it('runtime socket down: falls back to the CLI, then returns to the socket and stops spawning', async () => {
    const a = adapter();
    await a.snapshot();
    expect(cliCalls).toEqual([]);
    await rt.stop();
    advance(s, 100);
    setAgent(s, 'a', 'working');
    expect(await stateOf(a, 'tab-1:leaf-a')).toBe('working'); // via CLI
    const spawned = cliCalls.length;
    expect(spawned).toBeGreaterThan(0);
    await rt.start();
    await a.snapshot();
    await a.snapshot();
    expect(cliCalls.length).toBe(spawned);
  });

  it('both down: degraded polling through the CLI; restore: live again, no more spawns', async () => {
    const d = new DeckController(adapter(), new MappingStore());
    await rt.stop();
    await d.refresh([]);
    expect(d.overview().mode).toBe('degraded');
    expect(cliCalls.length).toBeGreaterThan(0);
    await rt.start();
    await sim.connect();
    await new Promise((r) => setTimeout(r, 1600));
    cliCalls.length = 0;
    await d.refresh([]);
    expect(d.overview().mode).toBe('live');
    expect(cliCalls).toEqual([]);
  }, 10_000);

  it('Orca restart (new token, handles rotate): the next call recovers without CLI', async () => {
    const a = adapter();
    await a.snapshot();
    const { restart } = await import('../../packages/fake-orca/src/index.ts');
    restart(s);
    await rt.restart('new-token');
    const snap = await a.snapshot();
    expect(snap.panes[0]?.handle).toContain('g2');
    expect(cliCalls).toEqual([]);
  });

  it('a stale handle after restart is reported by focus, not thrown', async () => {
    const a = adapter();
    const old = s.panes[0]!.handle;
    const { restart } = await import('../../packages/fake-orca/src/index.ts');
    restart(s);
    const r = await a.focus({ paneKey: 'tab-1:leaf-a', hostId: 'local', handle: old });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('terminal_handle_stale');
  });
});

describe('response time', () => {
  it('a runtime snapshot is far faster than a process spawn would allow (< 100 ms)', async () => {
    const a = adapter();
    await a.snapshot();
    const t = Date.now();
    await a.snapshot();
    expect(Date.now() - t).toBeLessThan(100);
  });
});

describe('awaiting reply end to end (fake Orca -> socket -> deck)', () => {
  const QUESTION = 'Tests pass. Should I commit this?';

  it('a finished turn that ends with a question shows "asks you" and wins the Attention key', async () => {
    const d = new DeckController(adapter(), new MappingStore());
    advance(s, 100);
    setAgent(s, 'a', 'done', null, { lastMessage: 'All done, nothing to decide.' });
    advance(s, 100);
    setAgent(s, 'b', 'done', null, { lastMessage: QUESTION });
    const views = await d.refresh(['k1', 'k2']);
    const states = [...views.values()].map((v) => v.state).sort();
    expect(states).toEqual(['awaiting_reply', 'completed']);
    expect(d.overview()).toMatchObject({ urgent: 1, topState: 'awaiting_reply' });
    expect(await d.pressAttention()).toBe('focused');
    expect(s.focusedHandle).toBe(s.panes[1]!.handle);
    expect(cliCalls).toEqual([]);
  });

  it('a permission prompt outranks a question', async () => {
    const d = new DeckController(adapter(), new MappingStore());
    advance(s, 100);
    setAgent(s, 'a', 'done', null, { lastMessage: QUESTION });
    advance(s, 100);
    setAgent(s, 'b', 'waiting', 'Bash');
    await d.refresh(['k1', 'k2']);
    expect(d.overview()).toMatchObject({ urgent: 2, topState: 'needs_input' });
    await d.pressAttention();
    expect(s.focusedHandle).toBe(s.panes[1]!.handle);
  });

  it('a pending AskUserQuestion reads as a question even though Orca says waiting', async () => {
    const d = new DeckController(adapter(), new MappingStore());
    setAgent(s, 'a', 'waiting', 'AskUserQuestion', {
      interactivePrompt: JSON.stringify({ questions: [{ question: 'Which one?' }] }),
    });
    const views = await d.refresh(['k1']);
    expect([...views.values()][0]?.state).toBe('awaiting_reply');
  });

  it('the bridge push keeps the verdict the poll produced for the same state', async () => {
    await sim.connect();
    const d = new DeckController(adapter(), new MappingStore());
    advance(s, 100);
    setAgent(s, 'a', 'done', null, { lastMessage: QUESTION });
    sim.sendStatus(s, 'a');
    await until(() => feed.status('tab-1:leaf-a')?.state === 'done');
    const views = await d.refresh(['k1']);
    expect([...views.values()][0]?.state).toBe('awaiting_reply');
  });

  it('the agent working again clears the question', async () => {
    const d = new DeckController(adapter(), new MappingStore());
    advance(s, 100);
    setAgent(s, 'a', 'done', null, { lastMessage: QUESTION });
    expect([...(await d.refresh(['k1'])).values()][0]?.state).toBe('awaiting_reply');
    advance(s, 100);
    setAgent(s, 'a', 'working');
    await new Promise((r) => setTimeout(r, 1600));
    expect([...(await d.refresh(['k1'])).values()][0]?.state).toBe('working');
  }, 10_000);

  it('never sends the message text anywhere the logs could see: snapshot has verdicts only', async () => {
    advance(s, 100);
    setAgent(s, 'a', 'done', null, { lastMessage: 'secret-token-in-output. Proceed?' });
    const snap = await adapter().snapshot();
    expect(JSON.stringify(snap)).not.toContain('secret-token');
    expect(snap.statuses.find((x) => x.paneKey === 'tab-1:leaf-a')?.awaiting).toBe('text');
  });
});

describe('acknowledgement through the runtime socket', () => {
  it('focusing a pane in Orca acknowledges its completion without a press, with zero CLI spawns', async () => {
    const d = new DeckController(
      new BridgedAdapter(
        // fast health comes from the runtime-backed adapter
        (await import('../../packages/adapter-runtime/src/index.ts')).createRuntimeAdapter({
          client: new RuntimeClient({ metaPath }),
          fallback: cli,
          environmentsFile: join(dir, 'none.json'),
        }),
        feed,
      ),
      new MappingStore(),
    );
    advance(s, 100);
    setAgent(s, 'a', 'done', null, { lastMessage: 'All finished.' });
    expect([...(await d.refresh(['k1'])).values()][0]?.state).toBe('completed');
    // the user clicks the pane in Orca
    const { focus } = await import('../../packages/fake-orca/src/index.ts');
    focus(s, s.panes[0]!.handle);
    await new Promise((r) => setTimeout(r, 1600));
    expect([...(await d.refresh(['k1'])).values()][0]?.state).toBe('idle');
    expect(cliCalls).toEqual([]);
    // the selected tab comes from the layout tree, one terminal.list, no resolveActive
    expect(rt.requests.some((r) => r.method === 'terminal.list')).toBe(true);
  }, 10_000);

  it('pressing the key marks the Orca worktree read through worktree.set', async () => {
    const { createRuntimeAdapter } = await import('../../packages/adapter-runtime/src/index.ts');
    const d = new DeckController(
      createRuntimeAdapter({
        client: new RuntimeClient({ metaPath }),
        fallback: cli,
        environmentsFile: join(dir, 'none.json'),
      }),
      new MappingStore(),
    );
    advance(s, 100);
    setAgent(s, 'a', 'done', null, { lastMessage: 'Done.' });
    setAgent(s, 'b', 'done', null, { lastMessage: 'Done.' });
    await d.refresh(['k1', 'k2']);
    await d.press('k1');
    await d.press('k2');
    await until(() => rt.requests.some((r) => r.method === 'worktree.set'));
    const sets = rt.requests.filter((r) => r.method === 'worktree.set');
    expect(sets).toHaveLength(1); // both panes share one worktree: cleared once, after the last
    expect(sets[0]?.params).toMatchObject({ isUnread: false });
    expect(cliCalls).toEqual([]);
  });
});
