import { expect, it } from 'vitest';
import { PaneRegistry } from '@orca-agent-deck/core';
import {
  addPane,
  focus,
  hostList,
  newState,
  restart,
  terminalList,
  worktreePs,
} from '../../fake-orca/src/index.ts';
import { CliAdapter, type Exec } from './index.ts';

it('mapping still focuses the right pane after Orca restart rotates handles', async () => {
  const s = newState();
  addPane(s, 'a');
  addPane(s, 'b');
  const exec: Exec = async (args) => {
    const k = args.slice(0, 2).join(' ');
    if (k === 'terminal list') return JSON.stringify(terminalList(s));
    if (k === 'worktree ps') return JSON.stringify(worktreePs(s));
    if (k === 'host list') return JSON.stringify(hostList(s));
    if (k === 'terminal switch') {
      focus(s, args[args.indexOf('--terminal') + 1] ?? '');
      return JSON.stringify({ ok: true, result: { focus: { navigated: true } } });
    }
    throw new Error(k);
  };
  const adapter = new CliAdapter(exec);
  const registry = new PaneRegistry();
  registry.update((await adapter.snapshot()).panes);
  const target = registry.resolve({ paneKey: 'tab-1:leaf-b' });
  expect(target).toBeDefined();
  const oldHandle = target?.pane.handle;

  restart(s);
  // stale handle fails, rebuilt registry succeeds
  expect(
    (await adapter.focus({ paneKey: 'tab-1:leaf-b', hostId: 'local', handle: oldHandle ?? '' })).ok,
  ).toBe(false);
  registry.update((await adapter.snapshot()).panes);
  const fresh = registry.resolve({ paneKey: 'tab-1:leaf-b' })?.pane;
  expect(fresh?.handle).not.toBe(oldHandle);
  expect(
    (
      await adapter.focus({
        paneKey: fresh?.paneKey ?? '',
        hostId: 'local',
        handle: fresh?.handle ?? '',
      })
    ).ok,
  ).toBe(true);
  expect(s.focusedHandle).toBe(fresh?.handle);
});
