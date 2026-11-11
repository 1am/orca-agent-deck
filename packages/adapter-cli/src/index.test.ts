import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CliAdapter, unreachableHostIds, type Exec } from './index.ts';

const fx = (n: string) => readFileSync(`test/fixtures/orca/${n}`, 'utf8');

const fixtureExec: Exec = async (args) => {
  const k = args.slice(0, 2).join(' ');
  if (k === 'terminal list') return fx('terminal-list.json');
  if (k === 'worktree ps') return fx('worktree-ps.json');
  if (k === 'terminal switch')
    return JSON.stringify({ ok: true, result: { focus: { navigated: true } } });
  throw new Error(`unexpected ${k}`);
};

it('builds a snapshot from terminal list + worktree ps', async () => {
  const s = await new CliAdapter(fixtureExec).snapshot();
  expect(s.panes.length).toBeGreaterThan(0);
  expect(s.panes[0]?.paneKey).toMatch(/^[\w-]+:[\w-]+$/);
  const claude = s.statuses.find(
    (x) => x.paneKey === s.panes.find((p) => p.agentType === 'claude')?.paneKey,
  );
  expect(claude?.state).toBe('done');
});

it('focus returns ok', async () => {
  expect(
    await new CliAdapter(fixtureExec).focus({ paneKey: 'a:b', hostId: 'local', handle: 'h' }),
  ).toEqual({ ok: true });
});

it('revealLocal focuses a local pane through terminal reveal, without an execution host', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    return JSON.stringify({ ok: true, result: { reveal: { navigated: true } } });
  };
  const a = new CliAdapter(exec);
  a.revealLocal = true;
  const pane = { paneKey: 't1:l1', hostId: 'local', handle: 'h', worktreeId: 'w1' };
  expect(await a.focus(pane)).toEqual({ ok: true });
  expect(calls).toEqual([
    ['terminal', 'reveal', '--worktree', 'w1', '--tab', 't1', '--leaf', 'l1', '--json'],
  ]);
});

it('revealLocal falls back to terminal switch when reveal is not available', async () => {
  const calls: string[] = [];
  const exec: Exec = async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[1] === 'reveal') throw new Error('reveal needs the runtime socket');
    return fixtureExec(args);
  };
  const a = new CliAdapter(exec);
  a.revealLocal = true;
  const pane = { paneKey: 't1:l1', hostId: 'local', handle: 'h', worktreeId: 'w1' };
  expect(await a.focus(pane)).toEqual({ ok: true });
  expect(calls).toEqual(['terminal reveal', 'terminal switch']);
});

it('focus of a local pane uses terminal switch unless revealLocal is set', async () => {
  const calls: string[] = [];
  const exec: Exec = async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    return fixtureExec(args);
  };
  await new CliAdapter(exec).focus({
    paneKey: 't1:l1',
    hostId: 'local',
    handle: 'h',
    worktreeId: 'w1',
  });
  expect(calls).toEqual(['terminal switch']);
});

it('focus reports errors instead of throwing', async () => {
  const bad: Exec = async () => {
    throw new Error('boom');
  };
  expect(
    (await new CliAdapter(bad).focus({ paneKey: 'a:b', hostId: 'local', handle: 'h' })).ok,
  ).toBe(false);
});

it('counts a host as down only when no listing covered it', () => {
  const scope = (hostIds: string[], omittedHostIds: string[]) => ({ hostIds, omittedHostIds });
  // An SSH host with worktrees but no terminals: covered by worktree ps, absent from terminal list.
  expect(
    unreachableHostIds(
      scope(['local'], ['ssh:build', 'runtime:peer']),
      scope(['local', 'ssh:build'], ['runtime:peer']),
    ),
  ).toEqual(['runtime:peer']);
  // No listing reached it: down.
  expect(
    unreachableHostIds(scope(['local'], ['ssh:build']), scope(['local'], ['ssh:build'])),
  ).toEqual(['ssh:build']);
  // `local` answered the call it came from.
  expect(unreachableHostIds(scope([], ['local']), scope([], ['local']))).toEqual([]);
});

it('keeps the gaps of the only scope a listing publishes', () => {
  const scope = { hostIds: ['local'], omittedHostIds: ['ssh:build'] };
  expect(unreachableHostIds(scope, undefined)).toEqual(['ssh:build']);
  expect(unreachableHostIds(undefined, scope)).toEqual(['ssh:build']);
  expect(unreachableHostIds(undefined, undefined)).toEqual([]);
});

it('keeps the union of omissions for state, and counts only hosts no listing reached', async () => {
  const exec: Exec = async (args) => {
    const o = JSON.parse(await fixtureExec(args));
    if (args[0] === 'terminal' && args[1] === 'list')
      o.result.hostScope = { hostIds: ['local'], omittedHostIds: ['ssh:build', 'runtime:peer'] };
    if (args[0] === 'worktree' && args[1] === 'ps')
      o.result.hostScope = {
        hostIds: ['local', 'ssh:build'],
        omittedHostIds: ['runtime:peer'],
      };
    return JSON.stringify(o);
  };
  const s = await new CliAdapter(exec).snapshot();
  // The key keeps its last known state for both.
  expect(s.omittedHostIds).toEqual(['ssh:build', 'runtime:peer']);
  // Only the host no listing reached counts as down.
  expect(s.downHostIds).toEqual(['runtime:peer']);
});

it('reports the hosts a read shows a worktree or terminal on as busy', async () => {
  const exec: Exec = async (args) => {
    const k = args.slice(0, 2).join(' ');
    if (k === 'host list') return JSON.stringify({ ok: true, result: { hosts: [] } });
    if (k === 'worktree ps')
      return JSON.stringify({
        ok: true,
        result: {
          worktrees: [{ worktreeId: 'w', hostId: 'ssh:box', agents: [] }],
          hostScope: { hostIds: ['local', 'ssh:box', 'ssh:idle'], omittedHostIds: [] },
        },
      });
    if (k === 'terminal list') return JSON.stringify({ ok: true, result: { terminals: [] } });
    throw new Error(`unexpected ${k}`);
  };
  const s = await new CliAdapter(exec).snapshot();
  expect(s.busyHostIds).toEqual(['ssh:box']);
});

it('health is down when orca is unreachable', async () => {
  const bad: Exec = async () => {
    throw new Error('ECONNREFUSED');
  };
  expect(await new CliAdapter(bad).health()).toEqual({ orcaRunning: false, version: null });
});

const statusWith =
  (appVersion: string): Exec =>
  async () =>
    JSON.stringify({
      ok: true,
      result: { app: { running: true }, runtime: { state: 'ready', appVersion } },
    });

it('accepts the minimum Orca version and flags the one before it', async () => {
  expect((await new CliAdapter(statusWith('1.4.245')).health()).unsupported).toBe(false);
  expect((await new CliAdapter(statusWith('1.4.244')).health()).unsupported).toBe(true);
});

it('flags old Orca versions and refuses further calls', async () => {
  let calls = 0;
  const old: Exec = async (...args) => {
    calls++;
    return statusWith('1.3.9')(...args);
  };
  const a = new CliAdapter(old);
  expect((await a.health()).unsupported).toBe(true);
  const before = calls;
  await expect(a.snapshot()).rejects.toThrow(/unsupported/);
  expect(calls).toBe(before);
});

it('never reports the local host as omitted and hides stale toolName', async () => {
  const withOmitted: Exec = async (args) => {
    const o = JSON.parse(await fixtureExec(args));
    o.result.hostScope = { hostIds: [], omittedHostIds: ['local', 'ssh-1'] };
    return JSON.stringify(o);
  };
  const s = await new CliAdapter(withOmitted).snapshot();
  expect(s.omittedHostIds).toEqual(['ssh-1']);
  expect(s.downHostIds).toEqual(['ssh-1']);
  expect(s.statuses.every((x) => x.toolName === null)).toBe(true);
});

it('queries paired environments with --environment and focuses with it', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    const env = args.includes('--environment');
    const k = args.slice(0, 2).join(' ');
    if (k === 'host list')
      return JSON.stringify({
        ok: true,
        result: { hosts: [{ id: 'E1', kind: 'environment', name: 'remote' }] },
      });
    if (k === 'terminal list') {
      const o = JSON.parse(await fixtureExec(args));
      if (env) o.result.terminals = o.result.terminals.slice(0, 1);
      o.result.hostScope = { hostIds: ['local'], omittedHostIds: env ? [] : ['runtime:E1'] };
      return JSON.stringify(o);
    }
    if (k === 'terminal switch')
      return JSON.stringify({ ok: true, result: { focus: { navigated: true } } });
    return fixtureExec(args);
  };
  const a = new CliAdapter(exec);
  const s = await a.snapshot();
  const remote = s.panes.filter((p) => p.environment === 'E1');
  expect(remote).toHaveLength(1);
  expect(remote[0]?.hostId).toBe('env:E1');
  expect(s.omittedHostIds).toEqual([]);
  expect(s.downHostIds).toEqual([]);
  // The server's own `local` rows are the server's.
  expect(s.busyHostIds).toContain('env:E1');
  await a.focus(remote[0]!);
  expect(calls.at(-1)).toContain('E1');
});

it('takes agentType from hook status when the pane has no agent identity', async () => {
  const s = await new CliAdapter(async (args) => {
    const o = JSON.parse(await fixtureExec(args));
    if (args[0] === 'terminal' && args[1] === 'list') {
      for (const t of o.result.terminals) t.agentIdentity = null;
    }
    return JSON.stringify(o);
  }).snapshot();
  expect(s.panes.some((p) => p.agentType === 'claude')).toBe(true);
});

const ps = (isActive: boolean) =>
  JSON.stringify({ ok: true, result: { worktrees: [{ worktreeId: 'w', isActive, agents: [] }] } });

const terms = (layouts?: unknown) =>
  JSON.stringify({ ok: true, result: { terminals: [], visualLayouts: layouts } });

const layout = (activeTabId: string) => [
  {
    worktreeId: 'w',
    root: {
      type: 'group',
      activeTabId,
      tabs: [
        { tabId: 't1', activeLeafId: 'l1', panes: {} },
        { tabId: 't2', activeLeafId: 'l2', panes: {} },
      ],
    },
  },
];

it('focusedPaneKey follows the selected tab of the layout, not the first one', async () => {
  const exec: Exec = async (args) => (args[0] === 'worktree' ? ps(true) : terms(layout('t2')));
  expect(await new CliAdapter(exec).focusedPaneKey()).toBe('t2:l2');
});

it('focusedPaneKey falls back to terminal show when the layout has no active tab', async () => {
  const exec: Exec = async (args) =>
    args[0] === 'worktree'
      ? ps(true)
      : args[1] === 'list'
        ? terms()
        : JSON.stringify({ ok: true, result: { terminal: { tabId: 't1', leafId: 'l1' } } });
  expect(await new CliAdapter(exec).focusedPaneKey()).toBe('t1:l1');
});

it('focusedPaneKey refuses to guess when no local worktree is active', async () => {
  expect(await new CliAdapter(async () => ps(false)).focusedPaneKey()).toBeNull();
});

it('focusedPaneKey answers from the snapshot it just made, and reads again once that is old', async () => {
  const calls: string[] = [];
  let now = 1000;
  const exec: Exec = async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'host') throw new Error('no hosts');
    return args[0] === 'worktree' ? ps(true) : terms(layout('t2'));
  };
  const a = new CliAdapter(exec, () => now);
  await a.snapshot();
  const before = calls.length;
  expect(await a.focusedPaneKey(300)).toBe('t2:l2');
  expect(calls.length).toBe(before);
  now += 300;
  expect(await a.focusedPaneKey(300)).toBe('t2:l2');
  expect(calls.length).toBe(before + 2);
  // Without a max age (hold-to-assign) the read is always fresh.
  expect(await a.focusedPaneKey()).toBe('t2:l2');
  expect(calls.length).toBe(before + 4);
});

it('a failing host list keeps the last paired servers and marks them down instead of dropping them', async () => {
  let hostsFail = false;
  const exec: Exec = async (args) => {
    const k = args.slice(0, 2).join(' ');
    if (k === 'host list') {
      if (hostsFail) throw new Error('timeout');
      return JSON.stringify({
        ok: true,
        result: { hosts: [{ id: 'E1', kind: 'environment', name: 'remote' }] },
      });
    }
    return fixtureExec(args);
  };
  const a = new CliAdapter(exec);
  expect((await a.snapshot()).omittedHostIds).toEqual([]);
  hostsFail = true;
  const s = await a.snapshot();
  expect(s.omittedHostIds).toContain('env:E1');
  expect(s.downHostIds).toContain('env:E1');
  expect(s.panes.some((p) => p.hostId === 'env:E1')).toBe(false);
});

/** Snapshot with one paired environment; each listing says which hosts it left out. */
async function pairedSnapshot(o: {
  envId: string;
  local: string[];
  paired: string[];
  hostListFails?: boolean;
}) {
  const exec: Exec = async (args) => {
    const env = args.includes('--environment');
    const k = args.slice(0, 2).join(' ');
    if (k === 'host list') {
      if (o.hostListFails) throw new Error('host list failed');
      return JSON.stringify({
        ok: true,
        result: { hosts: [{ id: o.envId, kind: 'environment', name: 'remote' }] },
      });
    }
    if (k === 'terminal list' || k === 'worktree ps') {
      const out = JSON.parse(await fixtureExec(args));
      out.result.hostScope = { hostIds: ['local'], omittedHostIds: env ? o.paired : o.local };
      return JSON.stringify(out);
    }
    return fixtureExec(args);
  };
  return new CliAdapter(exec).snapshot();
}

it('ignores the runtime peers a paired server lists, its own census', async () => {
  const s = await pairedSnapshot({
    envId: 'E1',
    local: ['runtime:E1'],
    paired: ['runtime:retired'],
  });
  expect(s.omittedHostIds).toContain('runtime:retired');
  expect(s.downHostIds).toEqual([]);
});

it('still counts a local-runtime peer with no matching environment as down', async () => {
  const known = await pairedSnapshot({ envId: 'E1', local: ['runtime:gone'], paired: [] });
  expect(known.downHostIds).toEqual(['runtime:gone']);
  const unknown = await pairedSnapshot({
    envId: 'E1',
    local: ['runtime:gone'],
    paired: [],
    hostListFails: true,
  });
  expect(unknown.downHostIds).toContain('runtime:gone');
});

it('matches runtime ids by the URL-encoded environment id', async () => {
  const s = await pairedSnapshot({ envId: 'env 1', local: ['runtime:env%201'], paired: [] });
  expect(s.omittedHostIds).toEqual([]);
  expect(s.downHostIds).toEqual([]);
});
