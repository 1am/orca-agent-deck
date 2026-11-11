import type { MappingStore, PaneBinding } from './mapping.ts';

export const DEFAULT_PAIRING_MS = 15_000;

export type PairingReason =
  | 'timeout'
  | 'cancelled'
  | 'noFocusedPane'
  | 'deckOffline'
  /** A panel click named a key that does not exist on the deck. */
  | 'noSuchKey'
  /** A panel click named a key that already shows a pane, without asking to replace it. */
  | 'occupied';

export type PairingState =
  | { phase: 'idle' }
  | {
      phase: 'waitingForKey';
      requestId: string;
      pane: PaneBinding;
      /** Slots that already show this pane (the deck pulses them). */
      existing: string[];
    };

export type PairingResult =
  | {
      requestId: string;
      ok: true;
      slot: string;
      /** `moved`: the pane was on other slots and left them (a pane is on one key only). `unmapped`: a panel click emptied the key. */
      action: 'mapped' | 'moved' | 'unmapped';
    }
  | { requestId: string; ok: false; reason: PairingReason };

export interface PairingOptions {
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  onState?: (state: PairingState) => void;
  onResult?: (result: PairingResult) => void;
}

/**
 * Pairing mode (spec 7.2 steps 4-7, 7.8) for pane keys: a request names a pane, then the next
 * slot press binds it. A pane already on another slot moves here: it is on one key only.
 * A mapped slot is replaced and an auto slot becomes pinned. Pure: the deck feeds `press` and
 * renders `state`, the bridge turns results into `pairResult`.
 */
export class Pairing {
  private current: PairingState = { phase: 'idle' };
  private timer: unknown = null;
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly onState: (state: PairingState) => void;
  private readonly onResult: (result: PairingResult) => void;

  private readonly mapping: MappingStore;

  constructor(mapping: MappingStore, o: PairingOptions = {}) {
    this.mapping = mapping;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_PAIRING_MS;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.onState = o.onState ?? (() => {});
    this.onResult = o.onResult ?? (() => {});
  }

  get state(): PairingState {
    return this.current;
  }

  /**
   * Enters pairing mode. `pane` is the pane named by A or resolved as focused; null when none
   * could be resolved. A pending request is cancelled first.
   */
  start(requestId: string, pane: PaneBinding | null, deckConnected: boolean): void {
    this.finish({ requestId: this.pendingId(), ok: false, reason: 'cancelled' });
    if (!deckConnected) return this.onResult({ requestId, ok: false, reason: 'deckOffline' });
    if (!pane) return this.onResult({ requestId, ok: false, reason: 'noFocusedPane' });
    this.current = {
      phase: 'waitingForKey',
      requestId,
      pane,
      existing: this.mapping.slotsFor(pane.paneKey),
    };
    this.timer = this.setTimer(
      () => this.finish({ requestId, ok: false, reason: 'timeout' }),
      this.timeoutMs,
    );
    this.onState(this.current);
  }

  /** Cancel the pending request (all of them when `requestId` is omitted). */
  cancel(requestId?: string): void {
    if (this.current.phase !== 'waitingForKey') return;
    if (requestId !== undefined && requestId !== this.current.requestId) return;
    this.finish({ requestId: this.current.requestId, ok: false, reason: 'cancelled' });
  }

  /** The deck went away while waiting. */
  deckOffline(): void {
    if (this.current.phase !== 'waitingForKey') return;
    this.finish({ requestId: this.current.requestId, ok: false, reason: 'deckOffline' });
  }

  /**
   * A slot was pressed (`tap`) or held. Returns true when pairing consumed the press, so the
   * caller must not also run the normal key action.
   */
  // The gesture no longer changes the outcome (a pane moves on both); callers still say which it was.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  press(slot: string, _gesture: 'tap' | 'hold'): boolean {
    const cur = this.current;
    if (cur.phase !== 'waitingForKey') return false;
    const others = cur.existing.filter((s) => s !== slot);
    const prev = this.mapping.get(slot);
    for (const s of others) this.mapping.set(s, { mode: 'auto', pos: this.mapping.get(s)?.pos });
    this.mapping.set(slot, { ...prev, mode: 'pinned', pane: cur.pane });
    const action = others.length > 0 ? 'moved' : 'mapped';
    this.finish({ requestId: cur.requestId, ok: true, slot, action });
    return true;
  }

  private pendingId(): string {
    return this.current.phase === 'waitingForKey' ? this.current.requestId : '';
  }

  private finish(result: PairingResult): void {
    if (this.current.phase !== 'waitingForKey') return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.current = { phase: 'idle' };
    this.onResult(result);
    this.onState(this.current);
  }
}
