import { describe, expect, it } from 'vitest';
import { rank, type Ranked } from './priority.ts';
import type { DeckState } from './status.ts';

const r = (state: DeckState, lastActivityAt = 0, unread?: boolean): Ranked =>
  unread === undefined ? { state, lastActivityAt } : { state, lastActivityAt, unread };

describe('rank', () => {
  it('orders most urgent first', () => {
    const order = [
      'needs_input',
      'error',
      'completed',
      'working',
      'cancelled',
      'idle',
      'unreachable',
      'offline',
      'unmapped',
    ] as const;
    const ranks = order.map((state) => rank({ state }));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(new Set(ranks).size).toBe(order.length);
  });

  it('ranks acknowledged completed like idle, below working', () => {
    expect(rank(r('completed', 9, false))).toBe(rank(r('idle')));
    expect(rank(r('completed', 9, false))).toBeGreaterThan(rank(r('working')));
  });

  it('ranks unread completed above working', () => {
    expect(rank(r('completed', 1, true))).toBeLessThan(rank(r('working')));
  });
});

describe('awaiting_reply priority', () => {
  it('ranks right after needs_input and ahead of error and completed', () => {
    const order = ['needs_input', 'awaiting_reply', 'error', 'completed'] as const;
    const ranks = order.map((state) => rank({ state }));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(4);
  });
});
