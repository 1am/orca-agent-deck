import { afterEach, expect, it, vi } from 'vitest';
import { DeckController, MappingStore } from '../../packages/core/src/index.ts';
import { CliAdapter, type Exec } from '../../packages/adapter-cli/src/index.ts';
import {
  addPane,
  hostList,
  newState,
  status,
  terminalList,
  worktreePs,
} from '../../packages/fake-orca/src/index.ts';

/** NFR-2: pane keys refresh every 2 s (PaneSlot), and the CLI fallback reads Orca at most every 4 s. */
const REFRESH_MS = 2000;
/** NFR-2: at most 1 `orca` call per second in steady state. */
const MAX_CALLS_PER_SECOND = 1;

afterEach(() => vi.useRealTimers());

it('the CLI fallback polls at most 1 call per second (NFR-2) in steady state', async () => {
  vi.useFakeTimers();
  const s = newState();
  addPane(s, 'a');
  addPane(s, 'b');
  const calls: string[] = [];
  const cli: Exec = async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    const [x, y] = args;
    if (x === 'terminal' && y === 'list') return JSON.stringify(terminalList(s));
    if (x === 'worktree' && y === 'ps') return JSON.stringify(worktreePs(s));
    if (x === 'host' && y === 'list') return JSON.stringify(hostList(s));
    if (x === 'status') return JSON.stringify(status(s));
    throw new Error(`unsupported ${args.join(' ')}`);
  };
  const d = new DeckController(new CliAdapter(cli), new MappingStore());
  await d.refresh(['s1', 's2']); // first refresh warms caches (host list)
  calls.length = 0;
  const refreshes = 10;
  for (let i = 0; i < refreshes; i++) {
    vi.advanceTimersByTime(REFRESH_MS);
    await d.refresh(['s1', 's2']);
  }
  const perSecond = calls.length / ((refreshes * REFRESH_MS) / 1000);
  expect(calls.length).toBeGreaterThan(0);
  expect(perSecond, `calls: ${[...new Set(calls)].join(', ')}`).toBeLessThanOrEqual(
    MAX_CALLS_PER_SECOND,
  );
});

it('key images are re-sent only on change, so an idle deck costs no SDK traffic', async () => {
  // PaneSlot repaints every 500 ms (2 fps, far under 10 fps) and skips an identical image.
  const { renderKey } = await import('../../packages/core/src/index.ts');
  const view = { state: 'idle' as const, label: 'x', line2: '', stale: false };
  expect(renderKey(view, { size: 144 })).toBe(renderKey(view, { size: 144 }));
  expect(renderKey({ ...view, state: 'working' }, { spin: 0 })).not.toBe(
    renderKey({ ...view, state: 'working' }, { spin: 1 }),
  );
});
