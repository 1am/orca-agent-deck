import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeckController, MappingStore } from '../../packages/core/src/index.ts';
import { CliAdapter, type Exec } from '../../packages/adapter-cli/src/index.ts';
import {
  BridgeServer,
  BridgeStatusFeed,
  BridgedAdapter,
} from '../../packages/adapter-bridge/src/index.ts';
import {
  BridgeSimulator,
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
let discoveryPath: string;
let server: BridgeServer;
let feed: BridgeStatusFeed;
let a: BridgeSimulator;
let s: SimState;
/** The CLI answers from this state; tests can freeze it to model polling lag. */
let polled: SimState;
let cliCalls = 0;

const execFor =
  (get: () => SimState): Exec =>
  async (args) => {
    cliCalls++;
    const st = get();
    const [x, y] = args;
    if (x === 'terminal' && y === 'list') return JSON.stringify(terminalList(st));
    if (x === 'worktree' && y === 'ps') return JSON.stringify(worktreePs(st));
    if (x === 'host' && y === 'list') return JSON.stringify(hostList(st));
    if (x === 'status') return JSON.stringify(status(st));
    throw new Error(`unsupported ${args.join(' ')}`);
  };

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const KEY_A = 'tab-1:leaf-a';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridge-int-'));
  discoveryPath = join(dir, 'bridge.json');
  server = new BridgeServer({ discoveryPath, ports: [0] });
  feed = new BridgeStatusFeed(server);
  await server.start();
  a = new BridgeSimulator(discoveryPath);
  s = newState();
  addPane(s, 'a');
  addPane(s, 'b');
  addPane(s, 'p', { agent: 'pi', title: 'Pi' });
  polled = s;
  cliCalls = 0;
});
afterEach(async () => {
  a.close();
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

const adapter = () => new BridgedAdapter(new CliAdapter(execFor(() => polled)), feed);
const stateOf = async (k: string) =>
  (await adapter().snapshot()).statuses.find((x) => x.paneKey === k)?.state;

describe('bridge status over the real server', () => {
  it('delivers a pushed status faster than the CLI poll would, within 500 ms', async () => {
    await a.connect();
    polled = structuredClone(s); // CLI still shows the old world
    advance(s, 1000);
    setAgent(s, 'a', 'working');
    const t0 = Date.now();
    a.sendStatus(s, 'a');
    await until(() => feed.status(KEY_A)?.state === 'working');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(await stateOf(KEY_A)).toBe('working');
  });

  it('matches the CLI-only result after every step of a scenario', async () => {
    await a.connect();
    const steps: Array<[string, 'working' | 'waiting' | 'done']> = [
      ['a', 'working'],
      ['b', 'working'],
      ['b', 'waiting'],
      ['a', 'done'],
      ['b', 'done'],
    ];
    for (const [k, st] of steps) {
      advance(s, 700);
      setAgent(s, k, st);
      a.sendStatus(s, k);
      await until(() => feed.status(`tab-1:leaf-${k}`)?.stateStartedAt === s.now);
      polled = s;
      const viaBridge = await adapter().snapshot();
      const viaCli = await new CliAdapter(execFor(() => s)).snapshot();
      const norm = (x: typeof viaCli) =>
        Object.fromEntries(x.statuses.map((e) => [e.paneKey, e.state]));
      expect(norm(viaBridge)).toEqual(norm(viaCli));
    }
  });

  it('gives Pi a status the CLI poll does not have', async () => {
    await a.connect();
    advance(s, 500);
    // Pi is absent from worktree ps agents[] in real Orca; model that by not setting an agent in the CLI view
    a.send({
      v: 1,
      type: 'agentStatus',
      paneKey: 'tab-1:leaf-p',
      workspaceId: 'ws1',
      state: 'waiting',
      outcome: null,
      stateStartedAt: s.now,
      receivedAt: s.now,
    });
    await until(() => feed.status('tab-1:leaf-p') !== undefined);
    expect(await stateOf('tab-1:leaf-p')).toBe('waiting');
  });

  it('never lets an older push overwrite a newer polled state', async () => {
    await a.connect();
    advance(s, 1000);
    setAgent(s, 'a', 'working');
    a.sendStatus(s, 'a');
    await until(() => feed.status(KEY_A)?.state === 'working');
    advance(s, 1000);
    setAgent(s, 'a', 'done'); // only the CLI knows this yet
    polled = s;
    expect(await stateOf(KEY_A)).toBe('done');
  });

  it('ignores a replayed older message after a newer one (reconnect replay)', async () => {
    await a.connect();
    advance(s, 1000);
    setAgent(s, 'a', 'working');
    a.sendStatus(s, 'a');
    const older = structuredClone(s);
    advance(s, 1000);
    setAgent(s, 'a', 'done');
    a.sendStatus(s, 'a');
    await until(() => feed.status(KEY_A)?.state === 'done');
    a.sendStatus(older, 'a');
    await new Promise((r) => setTimeout(r, 60));
    expect(feed.status(KEY_A)?.state).toBe('done');
  });

  it('drops the status of a pane that no longer exists', async () => {
    await a.connect();
    advance(s, 100);
    setAgent(s, 'b', 'working');
    a.sendStatus(s, 'b');
    await until(() => feed.status('tab-1:leaf-b') !== undefined);
    s.panes = s.panes.filter((p) => p.leafId !== 'leaf-b');
    polled = s;
    const snap = await adapter().snapshot();
    expect(snap.statuses.find((x) => x.paneKey === 'tab-1:leaf-b')).toBeUndefined();
  });

  it('ignores unknown states instead of breaking the feed', async () => {
    await a.connect();
    a.send({
      v: 1,
      type: 'agentStatus',
      paneKey: KEY_A,
      workspaceId: 'w',
      state: 'exploding',
      stateStartedAt: 5,
      receivedAt: 5,
    });
    advance(s, 10);
    setAgent(s, 'a', 'working');
    a.sendStatus(s, 'a');
    await until(() => feed.status(KEY_A)?.state === 'working');
  });
});

describe('connection lifecycle', () => {
  it('is degraded before A ever connected, live after, and stays live while A sleeps', async () => {
    const d = new DeckController(adapter(), new MappingStore());
    await d.refresh([]);
    expect(d.overview().mode).toBe('degraded');
    await a.connect();
    await new Promise((r) => setTimeout(r, 1600)); // info-key refresh throttle
    await d.refresh([]);
    expect(d.overview().mode).toBe('live');
    a.drop(); // worker idled out
    await until(() => !feed.connected);
    await new Promise((r) => setTimeout(r, 1600));
    await d.refresh([]);
    expect(d.overview().mode).toBe('live');
  }, 10_000);

  it('keeps the last pushed state while A is asleep and takes the replay on wake', async () => {
    await a.connect();
    advance(s, 1000);
    setAgent(s, 'a', 'waiting');
    a.sendStatus(s, 'a');
    await until(() => feed.status(KEY_A)?.state === 'waiting');
    a.drop();
    await until(() => !feed.connected);
    expect(feed.hasBridge).toBe(true);
    expect(feed.status(KEY_A)?.state).toBe('waiting');
    // CLI view is stale (still no agent state) but the pushed state stays
    polled = newState();
    addPane(polled, 'a');
    expect(await stateOf(KEY_A)).toBe('waiting');
    // wake: new connection replays the current world
    advance(s, 3000);
    setAgent(s, 'a', 'done');
    await a.connect();
    a.replay(s);
    await until(() => feed.status(KEY_A)?.state === 'done');
  });

  it('rejects a wrong token and an unsupported protocol version without affecting the feed', async () => {
    const bad = new BridgeSimulator(discoveryPath);
    await expect(bad.connect({ token: 'nope' })).rejects.toThrow();
    const old = new BridgeSimulator(discoveryPath);
    await expect(old.connect({ v: 9 })).rejects.toThrow();
    expect(feed.hasBridge).toBe(false);
    expect(server.connection).toBeNull();
  });

  it('notifies listeners on every status change so keys can refresh at once', async () => {
    let n = 0;
    feed.onChange(() => n++);
    await a.connect();
    const afterHello = n;
    advance(s, 10);
    setAgent(s, 'a', 'working');
    a.sendStatus(s, 'a');
    await until(() => n > afterHello);
  });

  it('does not need the CLI for status once connected (CLI calls only list panes)', async () => {
    await a.connect();
    advance(s, 10);
    setAgent(s, 'a', 'working');
    a.sendStatus(s, 'a');
    await until(() => feed.status(KEY_A) !== undefined);
    cliCalls = 0;
    expect(feed.status(KEY_A)?.state).toBe('working'); // reading the feed spawns nothing
    expect(cliCalls).toBe(0);
  });
});
