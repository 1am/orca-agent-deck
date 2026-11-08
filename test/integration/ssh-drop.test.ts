import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeckController, MappingStore } from '../../packages/core/src/index.ts';
import { CliAdapter, type Exec } from '../../packages/adapter-cli/src/index.ts';
import {
  hostList,
  runScenario,
  status,
  terminalList,
  worktreePs,
  type SimState,
} from '../../packages/fake-orca/src/index.ts';

/** Like real Orca: panes of a host that is down are left out of the list, the host is in omittedHostIds. */
const execFor =
  (get: () => SimState): Exec =>
  async (args) => {
    const st = get();
    const [x, y] = args;
    if (x === 'terminal' && y === 'list') {
      const list = terminalList({ ...st, panes: st.panes.filter((p) => p.connected) });
      return JSON.stringify(list);
    }
    if (x === 'worktree' && y === 'ps') return JSON.stringify(worktreePs(st));
    if (x === 'host' && y === 'list') return JSON.stringify(hostList(st));
    if (x === 'status') return JSON.stringify(status(st));
    throw new Error(`unsupported ${args.join(' ')}`);
  };

// The CLI fallback reads Orca at most every 4 s (NFR-2): move the clock past that between refreshes.
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());
const poll = (d: DeckController, slots: string[]) => {
  vi.setSystemTime(Date.now() + 4001);
  return d.refresh(slots);
};

it('ssh-drop-reconnect: the remote key goes unreachable, keeps its mapping, and recovers', async () => {
  const steps: SimState[] = [];
  runScenario('ssh-drop-reconnect', (s) => steps.push(structuredClone(s)));
  expect(steps).toHaveLength(3);

  let current = steps[0]!;
  const store = new MappingStore();
  const d = new DeckController(new CliAdapter(execFor(() => current)), store);

  const up = (await poll(d, ['s1'])).get('s1')!;
  expect(up.state).toBe('completed');
  const key = store.get('s1')?.pane?.paneKey;
  expect(key).toBeTruthy();

  current = steps[1]!;
  const down = (await poll(d, ['s1'])).get('s1')!;
  expect(down.state).toBe('unreachable');
  expect(down.stale).toBe(true);
  // Never offline or auto-refilled with another pane while the host is merely unreachable.
  expect(store.get('s1')?.pane?.paneKey).toBe(key);

  current = steps[2]!;
  const back = (await poll(d, ['s1'])).get('s1')!;
  expect(back.state).toBe('completed');
  expect(store.get('s1')?.pane?.paneKey).toBe(key);
});
