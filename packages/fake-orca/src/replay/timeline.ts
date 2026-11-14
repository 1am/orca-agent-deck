import type { SlotView } from '@orca-agent-deck/core';

/** One row per change of a key's view, in the order they happen: the committed snapshot and the failure diff. */
export const HEADER = 't(ms)  key  orca event                  state          label | line 2';

export function row(at: number, key: number, event: string, v: SlotView | undefined): string {
  const what = v ? `${v.state.padEnd(14)} ${v.label} | ${v.line2}` : '(no view)';
  return `${String(at).padStart(6)}  ${String(key).padEnd(3)}  ${event.slice(0, 26).padEnd(26)} ${what}`;
}

/** Line diff with the row number, readable enough to see which key changed at which time. */
export function diffTimeline(expected: string[], actual: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] === actual[i]) continue;
    if (expected[i] !== undefined) out.push(`  line ${i + 1} - ${expected[i]}`);
    if (actual[i] !== undefined) out.push(`  line ${i + 1} + ${actual[i]}`);
  }
  return out;
}
