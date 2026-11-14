import { expect, it } from 'vitest';
import { deckLayout } from './deck-layout.ts';

const at = (column: number, row: number) => ({ column, row });

it.each([
  ['MK.2', 5, 3],
  ['XL', 8, 4],
  ['Mini', 3, 2],
  ['Neo', 4, 2],
  ['+', 4, 2],
  ['Mobile', 3, 2],
])('%s: every position is listed once, row-major, empty ones as other', (_m, cols, rows) => {
  const l = deckLayout(cols, rows, []);
  expect(l).toHaveLength(cols * rows);
  expect(l.map((c) => c.key)).toEqual(Array.from({ length: cols * rows }, (_, i) => i + 1));
  expect(l.every((c) => c.kind === 'other')).toBe(true);
});

it('puts our actions at their coordinates and ignores ones outside the deck', () => {
  const l = deckLayout(5, 3, [
    { kind: 'pane', coordinates: at(0, 0) },
    { kind: 'status', coordinates: at(3, 2) },
    { kind: 'attention', coordinates: at(4, 2) },
    { kind: 'pane', coordinates: at(5, 0) },
    { kind: 'pane', coordinates: at(0, 3) },
  ]);
  expect(l.filter((c) => c.kind !== 'other')).toEqual([
    { key: 1, kind: 'pane' },
    { key: 14, kind: 'status' },
    { key: 15, kind: 'attention' },
  ]);
});
