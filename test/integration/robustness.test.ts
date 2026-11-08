import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeckController,
  MappingStore,
  type SlotSettings,
  type SlotStorage,
} from '../../packages/core/src/index.ts';
import { CliAdapter, type Exec } from '../../packages/adapter-cli/src/index.ts';
import {
  addPane,
  advance,
  hostList,
  newState,
  restart,
  setAgent,
  status,
  terminalList,
  worktreePs,
  type SimState,
} from '../../packages/fake-orca/src/index.ts';

const execFor =
  (get: () => SimState, down: () => boolean = () => false): Exec =>
  async (args) => {
    if (down()) throw new Error('ECONNREFUSED');
    const st = get();
    const [x, y] = args;
    if (x === 'terminal' && y === 'list') return JSON.stringify(terminalList(st));
    if (x === 'worktree' && y === 'ps') return JSON.stringify(worktreePs(st));
    if (x === 'host' && y === 'list') return JSON.stringify(hostList(st));
    if (x === 'status') return JSON.stringify(status(st));
    if (x === 'terminal' && y === 'switch')
      return JSON.stringify({ ok: true, result: { focus: { navigated: true } } });
    throw new Error(`unsupported ${args.join(' ')}`);
  };

/** Survives the controller, like the plugin's global settings / mappings file. */
class SharedStorage implements SlotStorage {
  data: Record<string, SlotSettings> = {};
  load = () => structuredClone(this.data);
  save = (slots: Record<string, SlotSettings>) => void (this.data = structuredClone(slots));
}

function world() {
  const s = newState();
  addPane(s, 'a');
  addPane(s, 'b');
  const storage = new SharedStorage();
  let orcaDown = false;
  const deck = () =>
    new DeckController(
      new CliAdapter(
        execFor(
          () => s,
          () => orcaDown,
        ),
      ),
      new MappingStore(storage),
    );
  return { s, storage, deck, setDown: (v: boolean) => (orcaDown = v) };
}

/**
 * The CLI fallback reads Orca at most every 4 s (NFR-2), so a refresh sooner than that shows the
 * last snapshot. Tests that change Orca between refreshes move the clock past that first.
 */
const poll = (d: DeckController, slots: string[]) => {
  vi.setSystemTime(Date.now() + 4001);
  return d.refresh(slots);
};

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('recovery without manual steps (NFR-3, FR-S3, FR-S4)', () => {
  it('Stream Deck app restart: a new controller shows the same panes on the same keys', async () => {
    const w = world();
    const before = await w.deck().refresh(['s1', 's2']);
    const after = await w.deck().refresh(['s1', 's2']);
    expect([...after].map(([k, v]) => [k, v.label])).toEqual(
      [...before].map(([k, v]) => [k, v.label]),
    );
    expect(after.get('s1')?.state).not.toBe('unmapped');
  });

  it('Orca quits and comes back: keys go empty/offline, mappings stay, state returns', async () => {
    const w = world();
    const d = w.deck();
    const up = await poll(d, ['s1', 's2']);
    const paneOnS1 = w.storage.data.s1?.pane?.paneKey;
    w.setDown(true);
    const down = await poll(d, ['s1', 's2']);
    expect(down.get('s1')?.state).toBe('unmapped');
    expect(w.storage.data.s1?.pane?.paneKey).toBe(paneOnS1);
    w.setDown(false);
    const back = await poll(d, ['s1', 's2']);
    expect(back.get('s1')?.label).toBe(up.get('s1')?.label);
  });

  it('Orca restart rotates handles: the keys keep their panes and focus uses the new handle', async () => {
    const w = world();
    const d = w.deck();
    await poll(d, ['s1']);
    restart(w.s);
    const v = await poll(d, ['s1']);
    expect(v.get('s1')?.state).not.toBe('unmapped');
    expect(await d.press('s1')).toBe('focused');
  });

  it('sleep/wake: a long gap with Orca unreachable, then a refresh recovers with fresh state', async () => {
    const w = world();
    const d = w.deck();
    await poll(d, ['s1', 's2']);
    // The Mac sleeps 8 h: no refreshes, Orca (also asleep) is unreachable at first.
    w.setDown(true);
    advance(w.s, 8 * 3600_000);
    expect((await poll(d, ['s1', 's2'])).get('s1')?.state).toBe('unmapped');
    // Wake: Orca answers, an agent finished meanwhile.
    w.setDown(false);
    setAgent(w.s, 'a', 'working');
    const v = await poll(d, ['s1', 's2']);
    const states = [...v.values()].map((x) => x.state);
    expect(states).toContain('working');
    expect(w.storage.data.s1?.pane).toBeDefined();
  });

  it('Orca update to a version below the minimum is reported, and clears after the update', async () => {
    const w = world();
    const d = w.deck();
    w.s.appVersion = '1.4.200';
    await poll(d, ['s1']);
    expect(d.overview().unsupported).toBe(true);
    w.s.appVersion = '1.4.245';
    await poll(d, ['s1']);
    expect(d.overview().unsupported).toBe(false);
  });
});
