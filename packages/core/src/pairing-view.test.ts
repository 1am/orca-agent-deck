import { describe, expect, it } from 'vitest';
import type { SlotView } from './deck.ts';
import { pairingCancelInfo, pairingSlotView } from './pairing-view.ts';
import { Pairing, type PairingState } from './pairing.ts';
import { MappingStore } from './mapping.ts';

const waiting = (existing: string[]): Extract<PairingState, { phase: 'waitingForKey' }> => ({
  phase: 'waitingForKey',
  requestId: 'r1',
  existing,
  pane: { paneKey: 'a:b', worktreeId: 'w', tabId: 't', leafId: 'l', lastKnown: {} },
});
const view = (state: SlotView['state'], label = ''): SlotView => ({
  state,
  stale: false,
  label,
  line2: '',
});

describe('pairingSlotView', () => {
  it('free slots say Assign here with the pane label', () => {
    const v = pairingSlotView(waiting([]), 's1', view('unmapped'), 'feature > claude');
    expect(v).toMatchObject({ state: 'unmapped', label: 'Assign here: feature > claude' });
  });
  it('slots without any view yet are free too', () => {
    expect(pairingSlotView(waiting([]), 's1', undefined, 'x').label).toBe('Assign here: x');
  });
  it('mapped slots keep their status and get a replace marker', () => {
    const v = pairingSlotView(waiting([]), 's2', view('working', 'other'), 'x');
    expect(v).toMatchObject({ state: 'working', label: 'Replace: other' });
  });
  it('slots already showing the pane pulse', () => {
    const w = waiting(['s3']);
    const on = pairingSlotView(w, 's3', view('working', 'x'), 'x', true);
    const off = pairingSlotView(w, 's3', view('working', 'x'), 'x', false);
    expect(on.focused).toBe(true);
    expect(off.focused).toBe(false);
    expect(on.label).toBe('Already here');
  });
});

it('the system keys read Cancel', () => {
  expect(pairingCancelInfo('Mapping')).toMatchObject({ value: 'Cancel' });
});

it('shows pairing mode synchronously from the request (feedback well under 200 ms)', () => {
  const mapping = new MappingStore();
  let seen = -1;
  const p = new Pairing(mapping, { onState: () => (seen = Date.now()) });
  const t0 = Date.now();
  p.start('r1', waiting([]).pane, true);
  expect(seen).toBeGreaterThanOrEqual(t0);
  expect(seen - t0).toBeLessThan(50);
});
