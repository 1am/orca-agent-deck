import type { PaneInfo } from './adapter.ts';
import type { DeckState } from './status.ts';
import { rank } from './priority.ts';

/** Spec 7.5. Every field narrows the eligible panes; absent means no restriction. */
export interface AutoFilter {
  agents?: string[];
  /** executionHostId patterns; `local` is this machine. A `*` matches any run of characters. */
  hosts?: string[];
  repos?: string[];
  /** Matched against the worktree path; `*` any run, `?` one character. */
  worktreeGlob?: string;
  /** Default true. False leaves out panes whose agent is idle (or finished and read). */
  includeIdle?: boolean;
}

export interface AutoCandidate {
  pane: PaneInfo;
  state: DeckState;
  /** A completed pane that is no longer unread counts as idle. */
  unread?: boolean;
  lastActivityAt: number;
}

export interface AutoSlot {
  slot: string;
  /** Per-slot filter; overrides `profileFilter`. */
  filter?: AutoFilter;
}

const globToRegExp = (glob: string) =>
  new RegExp(
    `^${glob
      .split(/([*?])/)
      .map((p) => (p === '*' ? '.*' : p === '?' ? '.' : p.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
  );

const isIdle = (c: AutoCandidate) =>
  c.state === 'idle' || (c.state === 'completed' && c.unread === false);

/** Whether a pane may be auto-filled at all, ignoring filters: an agent runs in it and it is alive. */
export const baseEligible = (p: PaneInfo) => !!p.agentType && !p.orphaned;

export function matchesFilter(c: AutoCandidate, f: AutoFilter | undefined): boolean {
  if (!f) return true;
  const p = c.pane;
  if (f.agents?.length && !f.agents.includes(p.agentType ?? '')) return false;
  if (f.hosts?.length) {
    const host = p.hostId || 'local';
    if (!f.hosts.some((h) => globToRegExp(h).test(host))) return false;
  }
  if (f.repos?.length && !f.repos.includes(p.repo ?? '')) return false;
  if (f.worktreeGlob && !globToRegExp(f.worktreeGlob).test(p.worktreePath ?? '')) return false;
  if (f.includeIdle === false && isIdle(c)) return false;
  return true;
}

/** Urgency first (needs_input > awaiting_reply > error > completed-unread > working > idle), then most recent. */
export const byUrgency = (a: AutoCandidate, b: AutoCandidate) =>
  rank(a) - rank(b) ||
  b.lastActivityAt - a.lastActivityAt ||
  a.pane.paneKey.localeCompare(b.pane.paneKey);

/**
 * Chooses which panes fill the free auto slots. `freeSlots` are the empty auto slots in key order;
 * slots that already hold a live pane are not passed in, which is what keeps placement stable: a
 * re-ranking only decides who gets the slots that are free right now. `excluded` holds panes that
 * are pinned somewhere or were released by the user. Returns slot -> paneKey.
 */
export function planAutoFill(o: {
  freeSlots: AutoSlot[];
  candidates: AutoCandidate[];
  excluded: ReadonlySet<string>;
  profileFilter?: AutoFilter;
}): Map<string, string> {
  const pool = o.candidates
    .filter((c) => baseEligible(c.pane) && !o.excluded.has(c.pane.paneKey))
    .sort(byUrgency);
  const out = new Map<string, string>();
  for (const s of o.freeSlots) {
    const f = s.filter ?? o.profileFilter;
    const i = pool.findIndex((c) => matchesFilter(c, f));
    if (i < 0) continue;
    out.set(s.slot, pool.splice(i, 1)[0]!.pane.paneKey);
  }
  return out;
}

/** Eligible panes that no slot got, most urgent first: what the Attention key counts as +N. */
export function overflow(o: {
  candidates: AutoCandidate[];
  excluded: ReadonlySet<string>;
  placed: ReadonlySet<string>;
}): AutoCandidate[] {
  return o.candidates
    .filter(
      (c) =>
        baseEligible(c.pane) && !o.excluded.has(c.pane.paneKey) && !o.placed.has(c.pane.paneKey),
    )
    .sort(byUrgency);
}

export interface CompactSlot {
  slot: string;
  paneKey?: string;
  /** ms epoch since which the slot has been empty. */
  emptySince?: number;
}

/**
 * Optional compaction: an auto slot empty for at least `afterMs` is filled by moving the pane
 * from the last occupied auto slot after it. Returns moves in order; slots in key order.
 * Never moves anything when `afterMs` is not set, so keys do not shift under the finger.
 */
export function planCompact(
  slots: CompactSlot[],
  now: number,
  afterMs: number | undefined,
): { from: string; to: string }[] {
  if (afterMs === undefined) return [];
  const work = slots.map((s) => ({ ...s }));
  const moves: { from: string; to: string }[] = [];
  for (let i = 0; i < work.length; i++) {
    const gap = work[i]!;
    if (gap.paneKey || gap.emptySince === undefined || now - gap.emptySince < afterMs) continue;
    let j = work.length - 1;
    while (j > i && !work[j]!.paneKey) j--;
    if (j <= i) break;
    const src = work[j]!;
    gap.paneKey = src.paneKey;
    gap.emptySince = undefined;
    src.paneKey = undefined;
    src.emptySince = now;
    moves.push({ from: src.slot, to: gap.slot });
  }
  return moves;
}
