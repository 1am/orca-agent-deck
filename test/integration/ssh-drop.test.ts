import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeckController, MappingStore } from '../../packages/core/src/index.ts';
import { CliAdapter } from '../../packages/adapter-cli/src/index.ts';
import { execFor, loadScenario, play, type SimState } from '../../packages/fake-orca/src/index.ts';

// The CLI fallback reads Orca at most every 4 s (NFR-2): move the clock past that between refreshes.
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());
const poll = (d: DeckController, slots: string[]) => {
  vi.setSystemTime(Date.now() + 4001);
  return d.refresh(slots);
};

it('ssh-drop-reconnect: the remote key goes unreachable, keeps its mapping, and recovers', async () => {
  const steps: SimState[] = [];
  play(
    loadScenario(new URL('../replay/ssh-drop-reconnect.ndjson', import.meta.url).pathname),
    (s) => steps.push(structuredClone(s)),
  );
  // host.add, pane.add, host down, host up
  expect(steps).toHaveLength(4);

  let current = steps[1]!;
  const store = new MappingStore();
  const d = new DeckController(new CliAdapter(execFor(() => current)), store);

  const up = (await poll(d, ['s1'])).get('s1')!;
  expect(up.state).toBe('completed');
  const key = store.get('s1')?.pane?.paneKey;
  expect(key).toBeTruthy();

  current = steps[2]!;
  const down = (await poll(d, ['s1'])).get('s1')!;
  expect(down.state).toBe('unreachable');
  expect(down.stale).toBe(true);
  // Never offline or auto-refilled with another pane while the host is merely unreachable.
  expect(store.get('s1')?.pane?.paneKey).toBe(key);

  current = steps[3]!;
  const back = (await poll(d, ['s1'])).get('s1')!;
  expect(back.state).toBe('completed');
  expect(store.get('s1')?.pane?.paneKey).toBe(key);
});
