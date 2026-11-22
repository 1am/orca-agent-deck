import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// Conditions are waited for, never slept past: a loaded machine only makes them take longer.
const until = async (fn: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const untilAsync = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
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
    // The info refresh is throttled, so ask again until it has really looked.
    await untilAsync(async () => {
      await d.refresh([]);
      return d.overview().mode === 'live';
    });
    cliCalls.length = 0;
    await d.refresh(['k1']);
    expect(d.overview().mode).toBe('live');
    expect(cliCalls).toEqual([]);
  }, 30_000);

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
    await untilAsync(async () => [...(await d.refresh(['k1'])).values()][0]?.state === 'working');
  }, 30_000);

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
    await untilAsync(async () => [...(await d.refresh(['k1'])).values()][0]?.state === 'idle');
    expect(cliCalls).toEqual([]);
    // the selected tab comes from the layout tree, one terminal.list, no resolveActive
    expect(rt.requests.some((r) => r.method === 'terminal.list')).toBe(true);
  }, 30_000);

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

describe('a paired Orca server that glitches', () => {
  it('shows its keys unreachable only while its own read fails, and back at the next poll', async () => {
    // The paired server is a second simulated Orca, reached only through the CLI with --environment.
    const remote = newState();
    addPane(remote, 'r', { tab: 'tab-9' });
    let remoteFails = false;
    let hostListFails = false;
    const envCli: Exec = async (args) => {
      if (args.includes('--environment')) {
        if (remoteFails) throw new Error('remote_runtime_unavailable');
        const [x, y] = args;
        if (x === 'terminal' && y === 'list') return JSON.stringify(terminalList(remote));
        if (x === 'worktree' && y === 'ps') return JSON.stringify(worktreePs(remote));
      }
      if (args[0] === 'environment' && args[1] === 'list')
        return JSON.stringify({
          ok: true,
          result: { environments: [{ id: 'E1', name: 'remote' }] },
        });
      return cli(args);
    };
    const envsFile = join(dir, 'orca-environments.json');
    await writeFile(envsFile, '{}');
    const { createRuntimeAdapter } = await import('../../packages/adapter-runtime/src/index.ts');
    const adapter = createRuntimeAdapter({
      client: new RuntimeClient({ metaPath }),
      fallback: envCli,
      environmentsFile: envsFile,
      environmentPollMs: 1000,
    });
    const listHosts = adapter.listHosts.bind(adapter);
    adapter.listHosts = async () => {
      if (hostListFails) throw new Error('timeout');
      return listHosts();
    };
    const store = new MappingStore();
    store.set('k1', {
      mode: 'pinned',
      pane: {
        paneKey: 'tab-9:leaf-r',
        worktreeId: 'fake-repo::/fake/agent-deck',
        tabId: 'tab-9',
        leafId: 'leaf-r',
        executionHostId: 'env:E1',
        lastKnown: {},
      },
    });
    const d = new DeckController(adapter, store, undefined, { autofill: false });
    const key = async () => (await d.refresh(['k1'])).get('k1')?.state;
    expect(await key()).not.toBe('unreachable');
    // A failed host list alone: the server of the last list is still read, nothing goes grey.
    hostListFails = true;
    expect(await key()).not.toBe('unreachable');
    hostListFails = false;
    // Its own read fails: the key shows the host unreachable and keeps its pane.
    remoteFails = true;
    await untilAsync(async () => (await key()) === 'unreachable');
    expect(store.get('k1')?.pane?.paneKey).toBe('tab-9:leaf-r');
    // The read works again: the failure is retried on the next poll, well inside the 1 s interval of a success.
    remoteFails = false;
    const back = Date.now();
    await untilAsync(async () => (await key()) !== 'unreachable');
    expect(Date.now() - back).toBeLessThan(500);
  }, 15_000);
});
