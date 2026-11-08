import type { InfoModel } from './render.ts';
import type { SlotView } from './deck.ts';
import type { PairingState } from './pairing.ts';

type Waiting = Extract<PairingState, { phase: 'waitingForKey' }>;

/**
 * What a pane slot shows while pairing mode waits for a key (spec 7.2 step 4): the pane's label on
 * every free slot ("Assign here"), a replace marker on mapped slots, and the slots that already
 * show the pane pulse (`pulse` alternates per repaint tick).
 */
export function pairingSlotView(
  p: Waiting,
  slot: string,
  current: SlotView | undefined,
  label: string,
  pulse = false,
): SlotView {
  const mapped = !!current && current.state !== 'unmapped';
  if (p.existing.includes(slot) && current) {
    return { ...current, label: 'Already here', line2: 'already here', focused: pulse };
  }
  if (mapped) {
    return { ...current, label: `Replace: ${current.label}`, line2: 'replace' };
  }
  return {
    state: 'unmapped',
    stale: false,
    label: `Assign here: ${label}`,
    line2: 'assign here',
    assign: true,
    focused: true,
  };
}

/** Status and Attention keys turn into Cancel while pairing mode waits. */
export const pairingCancelInfo = (label: string): InfoModel => ({
  tone: 'needs_input',
  value: 'Cancel',
  caption: label,
});
