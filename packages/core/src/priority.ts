import type { DeckState } from './status.ts';

const ORDER: DeckState[] = [
  'needs_input',
  'awaiting_reply',
  'error',
  'completed',
  'working',
  'cancelled',
  'idle',
  'unreachable',
  'offline',
  'unmapped',
];

export interface Ranked {
  state: DeckState;
  /** Completed panes only count as urgent while unread. */
  unread?: boolean;
  /** Time of the most recent activity (ms), used as tie-break. */
  lastActivityAt: number;
}

/** Lower rank = more urgent. An acknowledged `completed` ranks like `idle`. */
export function rank(r: Pick<Ranked, 'state' | 'unread'>): number {
  if (r.state === 'completed' && r.unread === false) return ORDER.indexOf('idle');
  return ORDER.indexOf(r.state);
}
