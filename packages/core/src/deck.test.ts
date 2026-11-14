import { describe, expect, it } from 'vitest';
import type { OrcaAdapter, PaneInfo, Snapshot } from './adapter.ts';
import { DeckController } from './deck.ts';
import { MappingStore, MemoryStorage } from './mapping.ts';

const pane = (paneKey: string, over: Partial<PaneInfo> = {}): PaneInfo => ({
  paneKey,
  hostId: 'local',
  handle: `h-${paneKey}`,
  worktreeId: 'w',
  title: `t-${paneKey}`,
  connected: true,
  agentType: 'claude',
  ...over,
});

function fake(snap: Snapshot, running = true) {
  const focused: string[] = [];
  const a: OrcaAdapter = {
    health: async () => ({ orcaRunning: running, version: '1.4.0' }),
    snapshot: async () => snap,
    listHosts: async () => [],
    focus: async (p) => {
      focused.push(p.handle);
      return { ok: p.handle !== 'bad' };
    },
  };
  return { a, focused };
}

it('autofills free agent panes into empty slots and shows their state', async () => {
  const snap: Snapshot = {
    panes: [pane('b:1'), pane('a:1'), pane('c:1', { agentType: null })],
    statuses: [{ paneKey: 'a:1', state: 'waiting', toolName: 'Bash', stateStartedAt: 0 }],
    omittedHostIds: [],
  };
  const { a } = fake(snap);
  const d = new DeckController(a, new MappingStore());
  const v = await d.refresh(['s1', 's2', 's3']);
  expect(v.get('s1')).toMatchObject({ state: 'needs_input', label: 't-a:1' });
  expect(v.get('s2')?.state).toBe('idle');
  expect(v.get('s3')?.state).toBe('unmapped');
});

it('with autofill off, keys show pinned panes only and lose earlier auto-filled ones', async () => {
  const snap: Snapshot = { panes: [pane('a:1'), pane('b:1')], statuses: [], omittedHostIds: [] };
  const store = new MappingStore();
  // An earlier version auto-filled s1.
  await new DeckController(fake(snap).a, store).refresh(['s1']);
  expect(store.get('s1')?.pane?.paneKey).toBe('a:1');
  const d = new DeckController(fake(snap).a, store, undefined, { autofill: false });
  await d.refresh(['s1', 's2', 's3']);
  expect(store.get('s1')?.pane).toBeUndefined();
  d.configure('s2', { paneKey: 'b:1' });
  const v = await d.refresh(['s1', 's2', 's3']);
  expect(v.get('s1')?.state).toBe('unmapped');
  expect(v.get('s2')?.label).toBe('t-b:1');
  expect(v.get('s3')?.state).toBe('unmapped');
  expect(d.slotConfig('s1')).toEqual({ mode: 'auto', paneKey: null, autofill: false });
});

it('keeps a mapping when its host is down and shows unreachable', async () => {
  const store = new MappingStore();
  const snap: Snapshot = {
    panes: [pane('a:1', { hostId: 'ssh:x' })],
    statuses: [],
    omittedHostIds: [],
  };
  const d = new DeckController(fake(snap).a, store);
  await d.refresh(['s1']);
  snap.panes = [];
  snap.omittedHostIds = ['ssh:x'];
  expect((await d.refresh(['s1'])).get('s1')?.state).toBe('unreachable');
  expect(store.get('s1')?.pane?.paneKey).toBe('a:1');
});

it('keeps a key on a host only one listing omitted, without counting it down', async () => {
  const store = new MappingStore();
  const snap: Snapshot = {
    panes: [pane('a:1', { hostId: 'ssh:x' })],
    statuses: [],
    omittedHostIds: [],
    downHostIds: [],
  };
  const d = new DeckController(fake(snap).a, store);
  await d.refresh(['s1']);
  snap.panes = [];
  snap.omittedHostIds = ['ssh:x'];
  snap.downHostIds = [];
  expect((await d.refresh(['s1'])).get('s1')?.state).toBe('unreachable');
  expect(store.get('s1')?.pane?.paneKey).toBe('a:1');
  expect(d.overview().hostsDown).toBe(0);

  // No listing reached it: the same key stays and the count reports it.
  snap.downHostIds = ['ssh:x'];
  expect((await d.refresh(['s1'])).get('s1')?.state).toBe('unreachable');
  expect(store.get('s1')?.pane?.paneKey).toBe('a:1');
  expect(d.overview().hostsDown).toBe(1);
  expect(d.overview().hostsDownNames).toEqual(['x']);
});

it('names a down host by alias, then Orca name, then its id', async () => {
  const snap: Snapshot = {
    panes: [
      pane('a:1', { hostId: 'ssh:box', hostName: 'build box' }),
      pane('b:1', { hostId: 'env:E1' }),
    ],
    statuses: [],
    omittedHostIds: [],
    downHostIds: [],
  };
  const d = new DeckController(fake(snap).a, new MappingStore());
  d.hostAliases = { 'env:E1': 'silver' };
  await d.refresh(['s1']);
  snap.panes = [];
  snap.omittedHostIds = ['ssh:box', 'env:E1', 'ssh:gone%201'];
  snap.downHostIds = ['ssh:box', 'env:E1', 'ssh:gone%201'];
  await d.refresh(['s1']);
  expect(d.overview().hostsDownNames).toEqual(['build box', 'silver', 'gone 1']);
});

it('counts a down host only when it showed something the last time it answered', async () => {
  const snap: Snapshot = {
    panes: [],
    statuses: [],
    omittedHostIds: [],
    downHostIds: [],
    // ssh:busy has a worktree but no terminal; ssh:idle is configured and answered with nothing.
    busyHostIds: ['local', 'ssh:busy'],
  };
  const d = new DeckController(fake(snap).a, new MappingStore());
  await d.refresh([], { force: true });
  snap.omittedHostIds = ['ssh:busy', 'ssh:idle', 'ssh:never'];
  snap.downHostIds = ['ssh:busy', 'ssh:idle', 'ssh:never'];
  snap.busyHostIds = ['local'];
  await d.refresh([], { force: true });
  expect(d.overview().hostsDownNames).toEqual(['busy']);
  // Still down on later reads: it keeps its mark.
  await d.refresh([], { force: true });
  expect(d.overview().hostsDown).toBe(1);

  // Back with nothing on it, then down again: no longer counted.
  snap.omittedHostIds = [];
  snap.downHostIds = [];
  await d.refresh([], { force: true });
  snap.omittedHostIds = ['ssh:busy'];
  snap.downHostIds = ['ssh:busy'];
  await d.refresh([], { force: true });
  expect(d.overview().hostsDown).toBe(0);
});

it('counts a down host a key is mapped to, even when it was never seen up', async () => {
  const store = new MappingStore();
  store.set('s1', {
    mode: 'pinned',
    pane: {
      paneKey: 'a:1',
      worktreeId: 'w',
      tabId: 'a',
      leafId: '1',
      executionHostId: 'ssh:x',
      lastKnown: {},
    },
  });
  const snap: Snapshot = {
    panes: [],
    statuses: [],
    omittedHostIds: ['ssh:x', 'ssh:y'],
    downHostIds: ['ssh:x', 'ssh:y'],
    busyHostIds: ['local'],
  };
  const d = new DeckController(fake(snap).a, store);
  await d.refresh(['s1']);
  expect(d.overview().hostsDownNames).toEqual(['x']);
});

it('counts every down host for an adapter that does not report busy hosts', async () => {
  const snap: Snapshot = {
    panes: [],
    statuses: [],
    omittedHostIds: ['ssh:y'],
    downHostIds: ['ssh:y'],
  };
  const d = new DeckController(fake(snap).a, new MappingStore());
  await d.refresh([], { force: true });
  expect(d.overview().hostsDown).toBe(1);
});

it('press focuses the mapped pane and reports failures', async () => {
  const snap: Snapshot = {
    panes: [pane('a:1'), pane('b:1', { handle: 'bad' })],
    statuses: [],
    omittedHostIds: [],
  };
  const { a, focused } = fake(snap);
  const d = new DeckController(a, new MappingStore());
  await d.refresh(['s1', 's2', 's3']);
  expect(await d.press('s1')).toBe('focused');
  expect(focused).toEqual(['h-a:1']);
  expect(await d.press('s2')).toBe('failed');
  expect(await d.press('s3')).toBe('unmapped');
});

it('shows every slot empty while Orca is not running and keeps the mapping for the recovery', async () => {
  const store = new MappingStore();
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, store);
  await d.refresh(['s1']);
  const d2 = new DeckController(fake(snap, false).a, store);
  expect((await d2.refresh(['s1'])).get('s1')).toMatchObject({ state: 'unmapped', label: '' });
  expect(store.get('s1')?.pane?.paneKey).toBe('a:1');
  const d3 = new DeckController(fake(snap).a, store);
  expect((await d3.refresh(['s1'])).get('s1')).toMatchObject({ state: 'idle', label: 't-a:1' });
});

it('follows pane title changes of a mapped pane', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, new MappingStore());
  expect((await d.refresh(['s1'])).get('s1')?.label).toBe('t-a:1');
  snap.panes = [pane('a:1', { title: 'renamed' })];
  expect((await d.refresh(['s1'])).get('s1')?.label).toBe('renamed');
});

it('press raises the window only for mapped panes', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const { a } = fake(snap);
  let raised = 0;
  const d = new DeckController(a, new MappingStore(), async () => void raised++);
  await d.refresh(['s1', 's2']);
  await d.press('s1');
  await d.press('s2');
  expect(raised).toBe(1);
});

it('overview counts urgent panes and press cycles through them, oldest first', async () => {
  const snap: Snapshot = {
    panes: [pane('a:1'), pane('b:1'), pane('c:1'), pane('d:1')],
    statuses: [
      { paneKey: 'a:1', state: 'waiting', stateStartedAt: 200 },
      { paneKey: 'b:1', state: 'waiting', stateStartedAt: 100 },
      { paneKey: 'c:1', state: 'working', stateStartedAt: 50 },
    ],
    omittedHostIds: [],
  };
  const { a, focused } = fake(snap);
  const d = new DeckController(a, new MappingStore());
  await d.refresh([]);
  expect(d.overview()).toMatchObject({
    mode: 'degraded',
    urgent: 2,
    topState: 'needs_input',
    offDeck: 2,
  });
  await d.refresh(['s1']); // auto-fill puts a:1 (first by pane key) on the key
  expect(d.overview().offDeck).toBe(1);
  await d.pressAttention();
  await d.pressAttention();
  await d.pressAttention();
  expect(focused).toEqual(['h-b:1', 'h-a:1', 'h-b:1']);
});

it('overview is down and attention is empty when Orca is not running', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap, false).a, new MappingStore());
  await d.refresh([]);
  expect(d.overview()).toMatchObject({ mode: 'down', urgent: 0, topState: null });
  expect(await d.pressAttention()).toBe('unmapped');
});

it('configure pins a pane to one slot and can reset to auto', async () => {
  const snap: Snapshot = { panes: [pane('a:1'), pane('b:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, new MappingStore());
  await d.refresh(['s1', 's2']);
  expect(d.listPanes().map((p) => p.paneKey)).toEqual(['a:1', 'b:1']);
  d.configure('s2', { paneKey: 'a:1' });
  expect(d.slotConfig('s1').paneKey).toBeNull();
  expect(d.slotConfig('s2')).toEqual({ mode: 'pinned', paneKey: 'a:1', autofill: true });
  expect((await d.refresh(['s1', 's2'])).get('s2')?.label).toBe('t-a:1');
  // s1 is refilled with the remaining free pane; unmapping s2 frees it again.
  expect(d.slotConfig('s1').paneKey).toBe('b:1');
  d.configure('s2', { paneKey: null });
  await d.refresh(['s1', 's2']);
  expect(d.slotConfig('s2')).toMatchObject({ mode: 'auto', paneKey: 'a:1' });
});

it('picker names remote hosts and keeps listing them while a poll drops the host', async () => {
  const snap: Snapshot = {
    panes: [pane('a:1'), pane('r:1', { hostId: 'env:u-u-i-d', hostName: 'devbox' })],
    statuses: [],
    omittedHostIds: [],
  };
  const d = new DeckController(fake(snap).a, new MappingStore());
  await d.refresh([]);
  expect(d.listPanes().find((p) => p.paneKey === 'r:1')).toMatchObject({
    host: 'devbox',
    remote: true,
  });
  snap.panes = [pane('a:1')];
  snap.omittedHostIds = ['env:u-u-i-d'];
  // A refresh with no slots right after another is skipped; use a slot refresh to poll again.
  await d.refresh(['s1']);
  expect(d.listPanes().map((p) => p.paneKey)).toEqual(['a:1', 'r:1']);
  expect(d.listPanes()[1]?.state).toBe('unreachable');
});

it('a released pane stays off auto-fill until it is pinned again', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const { a } = fake(snap);
  a.focusedPaneKey = async () => 'a:1';
  const d = new DeckController(a, new MappingStore());
  await d.refresh(['s1', 's2']);
  expect(d.slotConfig('s1').paneKey).toBe('a:1');
  d.unmapSlot('r', 's1');
  // s2 is an empty auto key: it must not grab the pane that was just taken off s1.
  await d.refresh(['s1', 's2']);
  expect(d.slotConfig('s2').paneKey).toBeNull();
  d.configure('s2', { paneKey: 'a:1' });
  expect(d.slotConfig('s2').paneKey).toBe('a:1');
});

it('a released pane that goes away and comes back is auto-filled again', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, new MappingStore());
  await d.refresh(['s1', 's2']);
  d.clear('s1');
  await d.refresh(['s1', 's2']);
  expect(d.slotConfig('s2').paneKey).toBeNull();
  snap.panes = [];
  await d.refresh(['s1', 's2']);
  snap.panes = [pane('a:1')];
  await d.refresh(['s1', 's2']);
  expect(d.slotConfig('s2').paneKey).toBe('a:1');
});

it('overlapping refreshes do not hit Orca concurrently, and an info refresh rides on a running one', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const { a } = fake(snap);
  let inFlight = 0;
  let maxInFlight = 0;
  let healthCalls = 0;
  a.health = async () => {
    healthCalls++;
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { orcaRunning: true, version: '1.4.0' };
  };
  const d = new DeckController(a, new MappingStore());
  await Promise.all([d.refresh(['s1']), d.refresh([]), d.refresh([]), d.refresh(['s1'])]);
  expect(maxInFlight).toBe(1);
  expect(healthCalls).toBe(2);
});

it('pressing a key whose pane is missing for now still raises Orca', async () => {
  const snap: Snapshot = {
    panes: [pane('a:1', { hostId: 'env:E1' })],
    statuses: [],
    omittedHostIds: [],
  };
  let raised = 0;
  const d = new DeckController(fake(snap).a, new MappingStore(), async () => void raised++);
  await d.refresh(['s1']);
  snap.panes = [];
  snap.omittedHostIds = ['env:E1'];
  await d.refresh(['s1']);
  expect(await d.press('s1')).toBe('failed');
  expect(raised).toBe(1);
  expect(d.slotHost('s1')).toBe('env:E1');
});

it('keeps the pressed key highlighted while Orca cannot report focus (paired server shown)', async () => {
  const snap: Snapshot = {
    panes: [pane('a:1'), pane('r:1', { hostId: 'env:E', environment: 'E' })],
    statuses: [],
    omittedHostIds: [],
  };
  const { a } = fake(snap);
  let focused: string | null = 'a:1';
  a.focusedPaneKey = async () => focused;
  a.health = async () => ({ orcaRunning: true, version: '1.4.0', fast: true });
  const d = new DeckController(a, new MappingStore());
  await d.refresh(['s1', 's2']);
  expect((await d.refresh(['s1', 's2'])).get('s1')?.focused).toBe(true);
  // Press the remote key: Orca now shows the paired server and reports no focus.
  await d.press('s2');
  focused = null;
  let v = await d.refresh(['s1', 's2']);
  expect([v.get('s1')?.focused, v.get('s2')?.focused]).toEqual([false, true]);
  v = await d.refresh(['s1', 's2']);
  expect(v.get('s2')?.focused).toBe(true);
  // The user clicks a local pane: Orca's focus wins again.
  focused = 'a:1';
  v = await d.refresh(['s1', 's2']);
  expect([v.get('s1')?.focused, v.get('s2')?.focused]).toEqual([true, false]);
});

it('traces auto-fill and a freed slot through diag, without pane content', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const lines: string[] = [];
  const d = new DeckController(
    fake(snap).a,
    new MappingStore(new MemoryStorage(), Date.now, undefined, 0),
  );
  d.diag = (m) => lines.push(m);
  await d.refresh(['s1']);
  expect(lines.some((l) => l.includes('auto-filled with a:1'))).toBe(true);
  snap.panes = [];
  await d.refresh(['s1']);
  expect(lines.some((l) => l.includes('freed: pane a:1 gone'))).toBe(true);
});

describe('shell activity', () => {
  it('shows a plain shell pane as working while it keeps printing, then done, and never counts it as urgent', async () => {
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const sh = pane('s:1', { agentType: null, lastOutputAt: now - 500 });
      const snap: Snapshot = { panes: [sh], statuses: [], omittedHostIds: [] };
      const d = new DeckController(fake(snap).a, new MappingStore());
      await d.refresh(['s1']);
      d.configure('s1', { paneKey: 's:1' });
      const states: string[] = [];
      for (let i = 0; i < 7; i++) {
        sh.lastOutputAt = now - 500;
        states.push((await d.refresh(['s1'])).get('s1')?.state ?? '');
        now += 2000;
      }
      expect(states).toEqual(['idle', 'idle', 'idle', 'idle', 'working', 'working', 'working']);
      now += 10_000;
      expect((await d.refresh(['s1'])).get('s1')?.state).toBe('completed');
      expect(d.overview().urgent).toBe(0);
      // Pressing the key reads the finish away, like an agent's completion.
      await d.press('s1');
      expect((await d.refresh(['s1'])).get('s1')?.state).toBe('idle');
    } finally {
      Date.now = realNow;
    }
  });

  it('leaves agent panes to their own status', async () => {
    const a = pane('a:1', { lastOutputAt: Date.now() - 100 });
    const snap: Snapshot = {
      panes: [a],
      statuses: [{ paneKey: 'a:1', state: 'idle', stateStartedAt: 1 }],
      omittedHostIds: [],
    };
    const d = new DeckController(fake(snap).a, new MappingStore());
    await d.refresh(['s1']);
    d.configure('s1', { paneKey: 'a:1' });
    expect((await d.refresh(['s1'])).get('s1')?.state).toBe('idle');
  });
});

it('clear empties a slot for good, while configure(null) returns it to auto-fill', async () => {
  const { a } = fake({ panes: [pane('a:1')], statuses: [], omittedHostIds: [] });
  const d = new DeckController(a, new MappingStore());
  expect((await d.refresh(['s1'])).get('s1')?.state).not.toBe('unmapped');
  d.clear('s1');
  expect((await d.refresh(['s1'])).get('s1')?.state).toBe('unmapped');
  expect((await d.refresh(['s1'])).get('s1')?.state).toBe('unmapped');
  d.configure('s1', { paneKey: null });
  expect((await d.refresh(['s1'])).get('s1')?.state).not.toBe('unmapped');
});

it('badge follows the live agent: exit becomes a shell, offline keeps the last known agent', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, new MappingStore());
  expect((await d.refresh(['s1'])).get('s1')?.agent).toBe('claude');
  snap.panes = [pane('a:1', { agentType: null })];
  expect((await d.refresh(['s1'])).get('s1')?.agent).toBeNull();
  snap.panes = [];
  snap.omittedHostIds = ['local'];
  expect((await d.refresh(['s1'])).get('s1')?.state).toBe('unreachable');
});

it('a tmux pane without a detected agent shows as tmux, never as its last harness', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, new MappingStore());
  expect((await d.refresh(['s1'])).get('s1')).toMatchObject({ agent: 'claude', line2: 'claude' });
  // The agent exits and the pane runs tmux: Orca drops the identity and titles it "tmux".
  snap.panes = [pane('a:1', { agentType: null, title: 'tmux' })];
  expect((await d.refresh(['s1'])).get('s1')).toMatchObject({ agent: 'tmux', line2: 'tmux' });
  // An agent inside tmux reports through hooks: its harness wins again.
  snap.panes = [pane('a:1', { agentType: 'codex', title: 'tmux' })];
  expect((await d.refresh(['s1'])).get('s1')).toMatchObject({ agent: 'codex' });
  // A plain shell: no badge name, no stale harness on line 2.
  snap.panes = [pane('a:1', { agentType: null, title: 'zsh' })];
  expect((await d.refresh(['s1'])).get('s1')).toMatchObject({ agent: null, line2: 'idle' });
});

describe('acknowledgement', () => {
  function ackWorld(opts: { fast?: boolean; focused?: () => string | null } = {}) {
    const snap: Snapshot = {
      panes: [
        pane('a:1', { worktreeId: 'w1' }),
        pane('b:1', { worktreeId: 'w1' }),
        pane('c:1', { worktreeId: 'w2' }),
      ],
      statuses: [
        { paneKey: 'a:1', state: 'done', outcome: 'success', stateStartedAt: 1 },
        { paneKey: 'b:1', state: 'done', outcome: 'success', awaiting: 'text', stateStartedAt: 2 },
        { paneKey: 'c:1', state: 'done', outcome: 'success', stateStartedAt: 3 },
      ],
      omittedHostIds: [],
    };
    const read: string[] = [];
    const focused: string[] = [];
    const a: OrcaAdapter = {
      health: async () => ({ orcaRunning: true, version: '1.4.0', fast: opts.fast ?? true }),
      snapshot: async () => snap,
      listHosts: async () => [],
      focus: async (p) => (focused.push(p.paneKey), { ok: true }),
      focusedPaneKey: async () => opts.focused?.() ?? null,
      markWorktreeRead: async (w) => void read.push(w),
    };
    return { snap, a, read, focused };
  }
  const slots = ['s1', 's2', 's3'];

  it('marks the pane Orca has selected as focused, and none when reads are slow or unknown', async () => {
    let at: string | null = 'b:1';
    const { a } = ackWorld({ focused: () => at });
    const d = new DeckController(a, new MappingStore());
    const v = await d.refresh(slots);
    expect([...v.values()].map((x) => !!x.focused)).toEqual([false, true, false]);
    at = null;
    expect([...(await d.refresh(slots)).values()].some((x) => x.focused)).toBe(false);
    const slow = ackWorld({ fast: false, focused: () => 'b:1' });
    const d2 = new DeckController(slow.a, new MappingStore());
    expect([...(await d2.refresh(slots)).values()].some((x) => x.focused)).toBe(false);
  });

  it('shows "asks you" and done until acknowledged', async () => {
    const { a } = ackWorld();
    const d = new DeckController(a, new MappingStore());
    const v = await d.refresh(slots);
    expect(v.get('s1')?.state).toBe('completed');
    expect(v.get('s2')?.state).toBe('awaiting_reply');
    expect(v.get('s2')?.line2).toBe('asks you');
  });

  it('pressing a key reads a done pane ("done 0m") but a question stays until answered', async () => {
    const { a } = ackWorld();
    const d = new DeckController(a, new MappingStore());
    await d.refresh(slots);
    await d.press('s2');
    await d.press('s1');
    const v = await d.refresh(slots);
    expect(v.get('s2')).toMatchObject({ state: 'awaiting_reply', line2: 'asks you' });
    expect(v.get('s1')).toMatchObject({ state: 'idle', line2: 'done 0m' });
    expect(v.get('s3')?.state).toBe('completed');
  });

  it('an acknowledged pane shows empty when Orca quits, not "done", and "done" again after', async () => {
    const { a } = ackWorld();
    let running = true;
    const d = new DeckController(
      { ...a, health: async () => ({ orcaRunning: running, version: '1.4.0', fast: true }) },
      new MappingStore(),
    );
    await d.refresh(slots);
    await d.press('s1');
    running = false;
    expect((await d.refresh(slots)).get('s1')?.state).toBe('unmapped');
    running = true;
    expect((await d.refresh(slots)).get('s1')).toMatchObject({ state: 'idle', line2: 'done 0m' });
  });

  it('focusing the pane in Orca acknowledges it without a press (works with notifications off)', async () => {
    let focus: string | null = null;
    const { a } = ackWorld({ focused: () => focus });
    const d = new DeckController(a, new MappingStore());
    await d.refresh(slots);
    focus = 'a:1';
    expect((await d.refresh(slots)).get('s1')?.state).toBe('idle');
    focus = 'b:1';
    expect((await d.refresh(slots)).get('s2')?.state).toBe('awaiting_reply');
  });

  it('a pane that stays focused (or Orca in the background) is not acknowledged', async () => {
    const { a, snap } = ackWorld({ focused: () => 'b:1' });
    const d = new DeckController(a, new MappingStore());
    // Already focused at startup and while the agent works, then asks: stays highlighted.
    snap.statuses[1] = { paneKey: 'b:1', state: 'working', stateStartedAt: 10 };
    await d.refresh(slots);
    snap.statuses[1] = {
      paneKey: 'b:1',
      state: 'done',
      outcome: 'success',
      awaiting: 'text',
      stateStartedAt: 11,
    };
    expect((await d.refresh(slots)).get('s2')?.state).toBe('awaiting_reply');
    expect((await d.refresh(slots)).get('s2')?.state).toBe('awaiting_reply');
  });

  it('switching away and back to the pane acknowledges it', async () => {
    let focus: string | null = 'a:1';
    const { a } = ackWorld({ focused: () => focus });
    const d = new DeckController(a, new MappingStore());
    await d.refresh(slots);
    focus = 'c:1';
    await d.refresh(slots);
    focus = 'a:1';
    expect((await d.refresh(slots)).get('s1')?.state).toBe('idle');
  });

  it('does not read the focused pane when reads are expensive (CLI fallback)', async () => {
    let calls = 0;
    const { a } = ackWorld({
      fast: false,
      focused: () => (calls++, 'b:1'),
    });
    const d = new DeckController(a, new MappingStore());
    expect((await d.refresh(slots)).get('s2')?.state).toBe('awaiting_reply');
    expect(calls).toBe(0);
  });

  it('a new episode (agent works and asks again) is unacknowledged again', async () => {
    const { a, snap } = ackWorld();
    const d = new DeckController(a, new MappingStore());
    await d.refresh(slots);
    await d.press('s2');
    snap.statuses[1] = { paneKey: 'b:1', state: 'working', stateStartedAt: 10 };
    await d.refresh(slots);
    snap.statuses[1] = {
      paneKey: 'b:1',
      state: 'done',
      outcome: 'success',
      awaiting: 'text',
      stateStartedAt: 20,
    };
    expect((await d.refresh(slots)).get('s2')?.state).toBe('awaiting_reply');
  });

  it('clears the Orca unread dot only when the last unread pane of the worktree is acknowledged', async () => {
    const { a, read } = ackWorld();
    const d = new DeckController(a, new MappingStore());
    await d.refresh(slots);
    await d.press('s1'); // a:1 acked, b:1 (same worktree) still asks
    expect(read).toEqual([]);
    await d.press('s2');
    expect(read).toEqual(['w1']);
    await d.press('s3');
    expect(read).toEqual(['w1', 'w2']);
  });

  it('never marks a remote worktree read', async () => {
    const { a, snap, read } = ackWorld();
    snap.panes = [pane('r:1', { hostId: 'ssh:x', worktreeId: 'wr' })];
    snap.statuses = [{ paneKey: 'r:1', state: 'done', outcome: 'success', stateStartedAt: 1 }];
    const d = new DeckController(a, new MappingStore());
    await d.refresh(['s1']);
    await d.press('s1');
    expect(read).toEqual([]);
  });

  it('a failing markWorktreeRead never breaks a press', async () => {
    const { a } = ackWorld();
    a.markWorktreeRead = async () => {
      throw new Error('boom');
    };
    const d = new DeckController(a, new MappingStore());
    await d.refresh(slots);
    expect(await d.press('s1')).toBe('focused');
  });

  it('the Attention key keeps permission prompts and questions until answered, permission first', async () => {
    const { a, snap, focused } = ackWorld();
    snap.statuses.push({ paneKey: 'a:1', state: 'waiting', toolName: 'Bash', stateStartedAt: 99 });
    snap.statuses = snap.statuses.filter((s, i) => !(s.paneKey === 'a:1' && i === 0));
    const d = new DeckController(a, new MappingStore());
    await d.refresh(slots);
    expect(d.overview().urgent).toBe(2);
    await d.pressAttention(); // permission first
    await d.pressAttention(); // then the question
    expect(focused.slice(0, 2)).toEqual(['a:1', 'b:1']);
    await d.refresh(slots);
    expect(d.overview().urgent).toBe(2); // visiting either one answers nothing
    expect(d.overview().topState).toBe('needs_input');
  });
});

it('pairing: names the pane A sent, pins it on the pressed slot and un-releases it', async () => {
  const snap: Snapshot = { panes: [pane('a:1'), pane('b:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, new MappingStore());
  const results: unknown[] = [];
  d.onPairingResult = (r) => results.push(r);
  await d.refresh(['s1', 's2']);
  const target = await d.pairingTarget('b:1');
  expect(target?.paneKey).toBe('b:1');
  d.pairing.start('r1', target, true);
  expect(d.pairing.press('s1', 'tap')).toBe(true);
  // Auto-fill had put b:1 on s2: it moves to s1.
  expect(results).toEqual([{ requestId: 'r1', ok: true, slot: 's1', action: 'moved' }]);
  expect((await d.refresh(['s1', 's2'])).get('s1')).toMatchObject({ label: 't-b:1' });
});

it('pairing: a named pane that is not listed resolves to null', async () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, new MappingStore());
  await d.refresh(['s1']);
  expect(await d.pairingTarget('nope:1')).toBeNull();
});

it('a host alias replaces the host name on the key and in the picker, and clears with the alias', async () => {
  const remote = pane('r:1', { hostId: 'ssh:b1', hostName: 'build-server-01' });
  const snap: Snapshot = { panes: [remote], statuses: [], omittedHostIds: [] };
  const d = new DeckController(fake(snap).a, new MappingStore());
  expect((await d.refresh(['s1'])).get('s1')?.host).toBe('build-server-01');
  d.hostAliases = { 'ssh:b1': 'build' };
  expect((await d.refresh(['s1'])).get('s1')?.host).toBe('build');
  expect(d.listPanes()[0]?.host).toBe('build');
  d.hostAliases = { 'ssh:b1': '  ' };
  expect((await d.refresh(['s1'])).get('s1')?.host).toBe('build-server-01');
});

describe('press after Orca rotated the terminal handles', () => {
  const setup = (failure: { error: string; code?: string }) => {
    let gen = 1;
    const calls: string[] = [];
    let snapshots = 0;
    const a: OrcaAdapter = {
      health: async () => ({ orcaRunning: true, version: '1.4.0' }),
      snapshot: async () => (
        snapshots++,
        { panes: [pane('a:1', { handle: `g${gen}` })], statuses: [], omittedHostIds: [] }
      ),
      listHosts: async () => [],
      focus: async (p) => {
        calls.push(p.handle);
        return p.handle === 'g2' ? { ok: true } : { ok: false, ...failure };
      },
    };
    const d = new DeckController(a, new MappingStore());
    return {
      d,
      calls,
      snapshots: () => snapshots,
      restart: () => void (gen = 2),
    };
  };

  it('retries once with the fresh handle when Orca says the handle is stale', async () => {
    const t = setup({ error: 'terminal_handle_stale: gone', code: 'terminal_handle_stale' });
    await t.d.refresh(['s1']);
    t.d.configure('s1', { paneKey: 'a:1' });
    await t.d.refresh(['s1']);
    t.restart();
    expect(await t.d.press('s1')).toBe('focused');
    expect(t.calls).toEqual(['g1', 'g2']);
  });

  it('does not re-read the panes for an unrelated failure', async () => {
    const t = setup({ error: 'method_not_found: nope', code: 'method_not_found' });
    await t.d.refresh(['s1']);
    t.d.configure('s1', { paneKey: 'a:1' });
    await t.d.refresh(['s1']);
    const before = t.snapshots();
    t.restart();
    expect(await t.d.press('s1')).toBe('failed');
    expect(t.calls).toEqual(['g1']);
    expect(t.snapshots()).toBe(before);
  });

  it('reads the code from the text on the CLI path, which has no code field', async () => {
    const t = setup({ error: 'Command failed: terminal_not_found' });
    await t.d.refresh(['s1']);
    t.d.configure('s1', { paneKey: 'a:1' });
    await t.d.refresh(['s1']);
    t.restart();
    expect(await t.d.press('s1')).toBe('focused');
  });
});

describe('pairing target from the settings view', () => {
  const setup = (focus: () => string | null) => {
    const snap: Snapshot = { panes: [pane('a:1'), pane('b:1')], statuses: [], omittedHostIds: [] };
    const a: OrcaAdapter = {
      health: async () => ({ orcaRunning: true, version: '1.4.0', live: true, fast: true }),
      snapshot: async () => snap,
      listHosts: async () => [],
      focus: async () => ({ ok: true }),
      focusedPaneKey: async () => focus(),
    };
    return new DeckController(a, new MappingStore());
  };

  it('uses the last pane Orca reported focused when it reports none now', async () => {
    let focus: string | null = 'b:1';
    const d = setup(() => focus);
    await d.refresh([]);
    focus = null;
    expect((await d.pairingTarget(null))?.paneKey).toBe('b:1');
  });

  it('is null when no pane was ever focused', async () => {
    const d = setup(() => null);
    await d.refresh([]);
    expect(await d.pairingTarget(null)).toBeNull();
  });
});

it('a pane whose process crashed counts on the Attention key even though its agent is gone', async () => {
  const snap: Snapshot = {
    panes: [
      pane('a:1', { agentType: null, connected: false, exitCause: 'crash' }),
      pane('b:1', { agentType: null, connected: false, exitCause: 'clean' }),
    ],
    statuses: [],
    omittedHostIds: [],
  };
  const d = new DeckController(fake(snap).a, new MappingStore());
  await d.refresh([]);
  expect(d.overview()).toMatchObject({ urgent: 1, topState: 'error' });
});

describe('clicks in the Orca panel', () => {
  const world = () => {
    const snap: Snapshot = { panes: [pane('a:1'), pane('b:1')], statuses: [], omittedHostIds: [] };
    const { a } = fake(snap);
    a.focusedPaneKey = async () => 'b:1';
    // Auto-fill is off in the shipped plugin: keys hold pinned panes only.
    const d = new DeckController(a, new MappingStore(), undefined, { autofill: false });
    const results: unknown[] = [];
    d.onPairingResult = (r) => results.push(r);
    return { d, results };
  };

  it('assign puts the focused pane on the key, as pairing followed by a tap does', async () => {
    const { d, results } = world();
    await d.refresh(['s1', 's2']);
    await d.assignFocusedTo('r1', 's2', false, true);
    expect(results).toEqual([{ requestId: 'r1', ok: true, slot: 's2', action: 'mapped' }]);
    expect((await d.refresh(['s1', 's2'])).get('s2')).toMatchObject({ label: 't-b:1' });
  });

  it('a key that shows a pane needs replace, and the pane stays untouched without it', async () => {
    const { d, results } = world();
    await d.refresh(['s1']);
    await d.assignFocusedTo('r1', 's1', false, true);
    await d.assignFocusedTo('r2', 's1', false, true);
    expect(results[1]).toEqual({ requestId: 'r2', ok: false, reason: 'occupied' });
    d.configure('s1', { paneKey: 'a:1' });
    await d.assignFocusedTo('r3', 's1', true, true);
    expect(results[2]).toMatchObject({ requestId: 'r3', ok: true, slot: 's1' });
    expect((await d.refresh(['s1'])).get('s1')).toMatchObject({ label: 't-b:1' });
  });

  it('answers a key that does not exist, a deck that is offline and no focused pane', async () => {
    const { d, results } = world();
    await d.refresh(['s1']);
    await d.assignFocusedTo('r1', null, false, true);
    await d.assignFocusedTo('r2', 's1', false, false);
    d.unmapSlot('r3', null);
    expect(results).toEqual([
      { requestId: 'r1', ok: false, reason: 'noSuchKey' },
      { requestId: 'r2', ok: false, reason: 'deckOffline' },
      { requestId: 'r3', ok: false, reason: 'noSuchKey' },
    ]);
    const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
    const { a } = fake(snap);
    a.focusedPaneKey = async () => null;
    const none = new DeckController(a, new MappingStore(), undefined, { autofill: false });
    const got: unknown[] = [];
    none.onPairingResult = (r) => got.push(r);
    await none.assignFocusedTo('r4', 's1', false, true);
    expect(got).toEqual([{ requestId: 'r4', ok: false, reason: 'noFocusedPane' }]);
  });

  it('a pane already on another key moves: the old key empties', async () => {
    const { d, results } = world();
    await d.refresh(['s1', 's2']);
    await d.assignFocusedTo('r1', 's1', false, true);
    await d.assignFocusedTo('r2', 's2', false, true);
    expect(results[1]).toEqual({ requestId: 'r2', ok: true, slot: 's2', action: 'moved' });
    const v = await d.refresh(['s1', 's2']);
    expect(v.get('s2')).toMatchObject({ label: 't-b:1' });
    expect(v.get('s1')?.state).toBe('unmapped');
  });

  it('assign puts the pane the panel chose on the key, not the focused one', async () => {
    const { d, results } = world();
    await d.refresh(['s1', 's2']);
    await d.assignFocusedTo('r1', 's2', false, true, 'a:1');
    expect(results).toEqual([{ requestId: 'r1', ok: true, slot: 's2', action: 'mapped' }]);
    expect((await d.refresh(['s1', 's2'])).get('s2')).toMatchObject({ label: 't-a:1' });
  });

  it('a chosen pane that is on another key moves, and one that is gone is refused', async () => {
    const { d, results } = world();
    await d.refresh(['s1', 's2']);
    await d.assignFocusedTo('r1', 's1', false, true, 'a:1');
    await d.assignFocusedTo('r2', 's2', false, true, 'a:1');
    await d.assignFocusedTo('r3', 's1', false, true, 'zz:9');
    expect(results[1]).toEqual({ requestId: 'r2', ok: true, slot: 's2', action: 'moved' });
    expect(results[2]).toEqual({ requestId: 'r3', ok: false, reason: 'noSuchPane' });
    const v = await d.refresh(['s1', 's2']);
    expect(v.get('s1')?.state).toBe('unmapped');
    expect(v.get('s2')).toMatchObject({ label: 't-a:1' });
  });

  it('lists the panes for the panel: the focused one first, with the key each is on', async () => {
    const { d } = world();
    await d.refresh(['s1', 's2']);
    await d.assignFocusedTo('r1', 's2', false, true, 'a:1');
    await d.pairingTarget(null); // reads the focus: b:1
    const keyOf = (slot: string) => (slot === 's2' ? 2 : null);
    const panes = d.panelPanes(keyOf);
    expect(panes.map((p) => [p.paneKey, p.focused, p.onKey])).toEqual([
      ['b:1', true, undefined],
      ['a:1', false, 2],
    ]);
  });

  it('the key settings picker carries the key a pane is on when it can tell', async () => {
    const { d } = world();
    await d.refresh(['s1', 's2']);
    await d.assignFocusedTo('r1', 's2', false, true, 'a:1');
    const keyOf = (slot: string) => (slot === 's2' ? 2 : null);
    expect(d.listPanes(keyOf).map((p) => [p.paneKey, p.onKey])).toEqual([
      ['a:1', 2],
      ['b:1', undefined],
    ]);
    expect(d.listPanes().every((p) => p.onKey === undefined)).toBe(true);
  });

  it('unmap empties the key and keeps its pane off auto-fill', async () => {
    const { d, results } = world();
    await d.refresh(['s1']);
    await d.assignFocusedTo('r1', 's1', false, true);
    d.unmapSlot('r2', 's1');
    expect(results[1]).toEqual({ requestId: 'r2', ok: true, slot: 's1', action: 'unmapped' });
    expect((await d.refresh(['s1'])).get('s1')?.state).toBe('unmapped');
  });
});

describe('focus on a remote host', () => {
  const remote = (key: string) => pane(key, { hostId: 'ssh:box', hostName: 'box' });
  type Focus = { key: string | null; host: string | null };
  function world(panes: PaneInfo[], focus: { current: Focus }) {
    const { a } = fake({ panes, statuses: [], omittedHostIds: [] });
    a.health = async () => ({ orcaRunning: true, version: '1.4.0', fast: true });
    a.focusedPaneKey = async () => focus.current.key;
    Object.defineProperty(a, 'focusHostId', { get: () => focus.current.host });
    return new DeckController(a, new MappingStore(), undefined, { autofill: false });
  }

  it('the panel marks the focused pane of the focused host only', async () => {
    const focus = { current: { key: 't:1', host: 'ssh:box' } };
    const d = world([pane('t:1'), remote('t:1')], focus);
    await d.refresh([]);
    const marked = d.panelPanes(() => null).filter((p) => p.focused);
    expect(marked.map((p) => p.remote)).toEqual([true]);
  });

  it('a remote host shown with no readable pane drops the last local focus', async () => {
    const focus = { current: { key: 'a:1' as string | null, host: 'local' as string | null } };
    const d = world([pane('a:1'), remote('r:1')], focus);
    await d.refresh([]);
    expect(d.panelPanes(() => null).find((p) => p.focused)?.paneKey).toBe('a:1');
    focus.current = { key: null, host: 'ssh:box' };
    await d.refresh([], { force: true });
    expect(d.currentFocusKey()).toBeNull();
    expect(d.panelPanes(() => null).some((p) => p.focused)).toBe(false);
    // "Use the focused pane" has nothing to fall back on: it must not take the local pane.
    expect(await d.pairingTarget(null)).toBeNull();
  });

  it('with no worktree shown (settings open) the last focus is still the one meant', async () => {
    const focus = { current: { key: 'a:1' as string | null, host: 'local' as string | null } };
    const d = world([pane('a:1')], focus);
    await d.refresh([]);
    focus.current = { key: null, host: null };
    await d.refresh([], { force: true });
    expect((await d.pairingTarget(null))?.paneKey).toBe('a:1');
  });

  it('with no worktree shown and paired-server panes around, the last local focus is dropped', async () => {
    const focus = { current: { key: 'a:1' as string | null, host: 'local' as string | null } };
    const paired = pane('e:1', { hostId: 'env:srv', hostName: 'srv', environment: 'srv' });
    const d = world([pane('a:1'), paired], focus);
    await d.refresh([]);
    focus.current = { key: null, host: null };
    Object.assign(d['adapter'], { focusNote: 'worktrees=1 active=0 layouts=1 no-active-worktree' });
    await d.refresh([], { force: true });
    expect(d.currentFocusKey()).toBeNull();
    expect(d.panelPanes(() => null).some((p) => p.focused)).toBe(false);
    expect(await d.pairingTarget(null)).toBeNull();
  });

  it('on a paired server the pane last opened from the deck is offered, never taken by the deck itself', async () => {
    const focus = { current: { key: 'a:1' as string | null, host: 'local' as string | null } };
    const paired = (key: string) =>
      pane(key, { hostId: 'env:srv', hostName: 'srv', environment: 'srv' });
    const d = world([pane('a:1'), paired('e:1'), paired('e:2')], focus);
    await d.refresh(['s1']);
    d.configure('s1', { paneKey: 'e:2', hostId: 'env:srv' });
    focus.current = { key: null, host: null };
    Object.assign(d['adapter'], { focusNote: 'worktrees=1 active=0 layouts=1 no-active-worktree' });
    expect(await d.press('s1')).toBe('focused');
    await d.refresh(['s1'], { force: true });
    const panes = d.panelPanes(() => null);
    expect(panes[0]).toMatchObject({ paneKey: 'e:2', focused: false, lastPressed: true });
    expect(panes.filter((p) => p.lastPressed)).toHaveLength(1);
    expect(await d.pairingTarget(null)).toBeNull();
    // Back on a local pane Orca reports: no guess.
    focus.current = { key: 'a:1', host: 'local' };
    Object.assign(d['adapter'], { focusNote: 'worktrees=1 active=1 layouts=1' });
    await d.refresh(['s1'], { force: true });
    expect(d.panelPanes(() => null).some((p) => p.lastPressed)).toBe(false);
  });

  it('a pane the panel names with its host is the one mapped, when ids repeat across hosts', async () => {
    const focus = { current: { key: null as string | null, host: null as string | null } };
    const d = world(
      [pane('t:1', { title: 'local' }), { ...remote('t:1'), title: 'remote' }],
      focus,
    );
    const results: unknown[] = [];
    d.onPairingResult = (r) => results.push(r);
    await d.refresh(['s1', 's2']);
    await d.assignFocusedTo('r1', 's1', false, true, 't:1', 'ssh:box');
    await d.assignFocusedTo('r2', 's2', false, true, 't:1', 'local');
    expect(results).toMatchObject([{ ok: true }, { ok: true }]);
    const v = await d.refresh(['s1', 's2']);
    expect(v.get('s1')).toMatchObject({ label: 'remote' });
    expect(d.slotHost('s1')).toBe('ssh:box');
    expect(v.get('s2')).toMatchObject({ label: 'local' });
  });

  it('the panel line puts the pane title first and the host apart', async () => {
    const focus = { current: { key: null as string | null, host: null as string | null } };
    const d = world(
      [{ ...remote('t:1'), title: 'build', repo: 'r', branch: 'main', tabTitle: 'Tab 1' }],
      focus,
    );
    await d.refresh([]);
    expect(d.panelPanes(() => null)[0]).toMatchObject({
      hostId: 'ssh:box',
      label: 'r / main',
      detail: 'build · Tab 1',
      host: 'box',
    });
  });
});

describe('an Orca reply that does not parse', () => {
  const snap: Snapshot = { panes: [pane('a:1')], statuses: [], omittedHostIds: [] };
  const unparsable = (err: Error) => {
    let fail = false;
    const a: OrcaAdapter = {
      ...fake(snap).a,
      snapshot: async () => {
        if (fail) throw err;
        return snap;
      },
    };
    return { a, breakIt: () => (fail = true), fix: () => (fail = false) };
  };
  const zodError = () =>
    Object.assign(new Error('[{"secret":"x"}]'), {
      name: 'ZodError',
      issues: [{ path: ['terminals', 0, 'title'], code: 'invalid_type' }],
    });

  it('is not "down" while health answers: the last good snapshot stays, and the paths are logged once', async () => {
    const { a, breakIt, fix } = unparsable(zodError());
    const d = new DeckController(a, new MappingStore());
    const logs: string[] = [];
    d.diag = (m) => logs.push(m);
    expect((await d.refresh(['s1'])).get('s1')?.state).toBe('idle');
    breakIt();
    const v = await d.refresh(['s1']);
    await d.refresh(['s1']);
    expect(v.get('s1')?.state).toBe('idle');
    expect(d.overview()).toMatchObject({ mode: 'degraded', badResponse: true });
    expect(logs.filter((m) => m.includes('did not parse'))).toEqual([
      'orca answered, but the response did not parse: terminals.0.title invalid_type',
    ]);
    fix();
    await d.refresh(['s1']);
    expect(d.overview().badResponse).toBe(false);
  });

  it('still reports "down" when the snapshot fails for another reason', async () => {
    const { a, breakIt } = unparsable(new Error('timeout'));
    const d = new DeckController(a, new MappingStore());
    await d.refresh(['s1']);
    breakIt();
    await d.refresh(['s1']);
    expect(d.overview()).toMatchObject({ mode: 'down', badResponse: false });
  });
});

describe('pane names', () => {
  const split = (key: string, over: Partial<PaneInfo> = {}) =>
    pane(key, { title: '', tabTitle: 'Terminal', repo: 'repo', branch: 'main', ...over });
  async function names(panes: PaneInfo[], slots: string[] = []) {
    const { a } = fake({ panes, statuses: [], omittedHostIds: [] });
    const d = new DeckController(a, new MappingStore(), undefined, { autofill: true });
    const views = await d.refresh(slots);
    return { list: d.listPanes(), panel: d.panelPanes(() => null), views };
  }

  it('two untitled panes of one tab get their position in the tab, everywhere', async () => {
    const { list, panel, views } = await names([split('t:1'), split('t:2')], ['s1', 's2']);
    expect(list.map((p) => p.title)).toEqual(['Terminal · pane 1', 'Terminal · pane 2']);
    expect(panel.map((p) => p.name)).toEqual(['Terminal · pane 1', 'Terminal · pane 2']);
    expect(panel.map((p) => p.detail)).toEqual(['Terminal · pane 1', 'Terminal · pane 2']);
    expect([...views.values()].map((v) => v.label)).toEqual(['main · pane 1', 'main · pane 2']);
    expect(panel[0]).toMatchObject({ repo: 'repo', branch: 'main', tab: 'Terminal' });
  });

  it('panes titled alike are told apart, a pane with its own title is not touched', async () => {
    const { list } = await names([
      split('t:1', { title: 'vim' }),
      split('t:2', { title: 'vim' }),
      split('t:3', { title: 'logs' }),
    ]);
    expect(list.map((p) => p.title)).toEqual(['vim · pane 1', 'vim · pane 2', 'logs']);
  });

  it('a pane alone in its tab gets no suffix and an untitled one reads as its tab', async () => {
    const { list, views } = await names(
      [split('t:1'), split('u:1', { tabTitle: 'Other' })],
      ['s1'],
    );
    expect(list.map((p) => p.title)).toEqual(['Terminal', 'Other']);
    expect(views.get('s1')?.label).toBe('main');
  });

  it('the same tab id on another host is another tab', async () => {
    const { list } = await names([split('t:1'), split('t:2', { hostId: 'ssh:box' })]);
    expect(list.map((p) => p.title)).toEqual(['Terminal', 'Terminal']);
  });
});
