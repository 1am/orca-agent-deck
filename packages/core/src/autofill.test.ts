import { describe, expect, it } from 'vitest';
import type { PaneInfo } from './adapter.ts';
import {
  planAutoFill,
  planCompact,
  overflow,
  matchesFilter,
  type AutoCandidate,
} from './autofill.ts';
import type { DeckState } from './status.ts';

const cand = (
  paneKey: string,
  state: DeckState = 'working',
  lastActivityAt = 0,
  p: Partial<PaneInfo> = {},
): AutoCandidate => ({
  state,
  lastActivityAt,
  pane: {
    paneKey,
    hostId: 'local',
    handle: paneKey,
    worktreeId: 'w',
    title: '',
    connected: true,
    agentType: 'claude',
    ...p,
  },
});
const free = (...slots: string[]) => slots.map((slot) => ({ slot }));
const none = new Set<string>();

describe('planAutoFill', () => {
  it('orders by urgency, then by most recent activity', () => {
    const plan = planAutoFill({
      freeSlots: free('s1', 's2', 's3', 's4'),
      excluded: none,
      candidates: [
        cand('idle', 'idle', 99),
        cand('work-old', 'working', 1),
        cand('work-new', 'working', 5),
        cand('ask', 'needs_input', 0),
      ],
    });
    expect([...plan]).toEqual([
      ['s1', 'ask'],
      ['s2', 'work-new'],
      ['s3', 'work-old'],
      ['s4', 'idle'],
    ]);
  });

  it('skips panes without an agent, orphaned, pinned or released', () => {
    const plan = planAutoFill({
      freeSlots: free('s1', 's2'),
      excluded: new Set(['pinned']),
      candidates: [
        cand('shell', 'idle', 0, { agentType: null }),
        cand('gone', 'working', 0, { orphaned: true }),
        cand('pinned'),
        cand('ok'),
      ],
    });
    expect([...plan]).toEqual([['s1', 'ok']]);
  });

  it('applies the per-slot filter over the profile filter', () => {
    const plan = planAutoFill({
      freeSlots: [{ slot: 's1', filter: { agents: ['codex'] } }, { slot: 's2' }],
      profileFilter: { agents: ['claude'] },
      excluded: none,
      candidates: [cand('c1', 'working', 2), cand('x1', 'working', 1, { agentType: 'codex' })],
    });
    expect([...plan]).toEqual([
      ['s1', 'x1'],
      ['s2', 'c1'],
    ]);
  });

  it('leaves a slot empty when nothing matches its filter', () => {
    const plan = planAutoFill({
      freeSlots: [{ slot: 's1', filter: { repos: ['nope'] } }],
      excluded: none,
      candidates: [cand('a')],
    });
    expect(plan.size).toBe(0);
  });

  it('keeps placement stable under re-ranking: only free slots are decided', () => {
    // s1 already holds "old" (not passed in as free); a more urgent pane must not displace it.
    const plan = planAutoFill({
      freeSlots: free('s2'),
      excluded: new Set(['old']),
      candidates: [cand('old', 'idle'), cand('urgent', 'needs_input'), cand('mid', 'working')],
    });
    expect([...plan]).toEqual([['s2', 'urgent']]);
  });

  it('never assigns a pane twice and is deterministic for any input order', () => {
    const base = Array.from({ length: 12 }, (_, i) =>
      cand(`p${i}`, (['idle', 'working', 'error', 'needs_input'] as DeckState[])[i % 4], i % 3),
    );
    const want = [
      ...planAutoFill({
        freeSlots: free('a', 'b', 'c', 'd', 'e'),
        excluded: none,
        candidates: base,
      }),
    ];
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled = [...base].sort(
        (x, y) =>
          ((x.pane.paneKey.length * seed + x.lastActivityAt) % 7) -
            ((y.pane.paneKey.length * seed + y.lastActivityAt) % 7) || (seed % 2 ? 1 : -1),
      );
      const got = [
        ...planAutoFill({
          freeSlots: free('a', 'b', 'c', 'd', 'e'),
          excluded: none,
          candidates: shuffled,
        }),
      ];
      expect(got).toEqual(want);
      expect(new Set(got.map(([, k]) => k)).size).toBe(got.length);
    }
  });
});

describe('matchesFilter', () => {
  it('filters hosts with patterns, repos, worktree globs and idle', () => {
    const c = cand('a', 'idle', 0, {
      hostId: 'ssh:build-1',
      repo: 'deck',
      worktreePath: '/w/deck/feature-x',
    });
    expect(matchesFilter(c, { hosts: ['local'] })).toBe(false);
    expect(matchesFilter(c, { hosts: ['ssh:*'] })).toBe(true);
    expect(matchesFilter(c, { repos: ['deck'] })).toBe(true);
    expect(matchesFilter(c, { repos: ['other'] })).toBe(false);
    expect(matchesFilter(c, { worktreeGlob: '/w/deck/feature-*' })).toBe(true);
    expect(matchesFilter(c, { worktreeGlob: '/w/deck/fix-*' })).toBe(false);
    expect(matchesFilter(c, { includeIdle: false })).toBe(false);
    expect(matchesFilter({ ...c, state: 'completed', unread: false }, { includeIdle: false })).toBe(
      false,
    );
    expect(matchesFilter({ ...c, state: 'completed', unread: true }, { includeIdle: false })).toBe(
      true,
    );
    expect(matchesFilter(c, undefined)).toBe(true);
  });

  it('treats regex characters in a glob literally', () => {
    const c = cand('a', 'working', 0, { worktreePath: '/w/a.b' });
    expect(matchesFilter(c, { worktreeGlob: '/w/a.b' })).toBe(true);
    expect(matchesFilter(c, { worktreeGlob: '/w/aXb' })).toBe(false);
  });
});

describe('overflow', () => {
  it('lists eligible panes with no slot, most urgent first', () => {
    const o = overflow({
      candidates: [cand('a', 'idle'), cand('b', 'needs_input'), cand('c', 'working'), cand('d')],
      excluded: new Set(['d']),
      placed: new Set(['c']),
    });
    expect(o.map((x) => x.pane.paneKey)).toEqual(['b', 'a']);
  });
});

describe('planCompact', () => {
  const slots = [
    { slot: 's1', paneKey: 'a' },
    { slot: 's2', emptySince: 0 },
    { slot: 's3', paneKey: 'c' },
    { slot: 's4', paneKey: 'd' },
  ];
  it('does nothing unless configured', () => {
    expect(planCompact(slots, 1e9, undefined)).toEqual([]);
  });
  it('waits for the idle time, then fills the gap from the last occupied slot', () => {
    expect(planCompact(slots, 9_000, 10_000)).toEqual([]);
    expect(planCompact(slots, 10_000, 10_000)).toEqual([{ from: 's4', to: 's2' }]);
  });
  it('closes several gaps and stops when nothing is left to move', () => {
    const many = [
      { slot: 's1', emptySince: 0 },
      { slot: 's2', emptySince: 0 },
      { slot: 's3', paneKey: 'c' },
      { slot: 's4', paneKey: 'd' },
    ];
    expect(planCompact(many, 5, 1)).toEqual([
      { from: 's4', to: 's1' },
      { from: 's3', to: 's2' },
    ]);
  });
});
