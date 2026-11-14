import { keyNumber } from './keynumber.ts';

/** What sits at one position of the deck, as far as a plugin can tell. */
export type CellKind = 'pane' | 'status' | 'attention' | 'other';

export interface LayoutCell {
  /** 1-based, row-major, as everywhere else (`keyNumber`). */
  key: number;
  kind: CellKind;
}

/**
 * Every position of a `cols` x `rows` deck: ours where an Agent Deck action is, else `other`. The Stream Deck SDK
 * shows a plugin only its own actions, so empty and another plugin's are not told apart.
 */
export function deckLayout(
  cols: number,
  rows: number,
  ours: { kind: Exclude<CellKind, 'other'>; coordinates: { column: number; row: number } }[],
): LayoutCell[] {
  const cells: LayoutCell[] = Array.from({ length: cols * rows }, (_, i) => ({
    key: i + 1,
    kind: 'other',
  }));
  for (const o of ours) {
    const { column, row } = o.coordinates;
    if (column < 0 || row < 0 || column >= cols || row >= rows) continue;
    cells[keyNumber(o.coordinates, cols) - 1]!.kind = o.kind;
  }
  return cells;
}
