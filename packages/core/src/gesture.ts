export interface GestureOptions {
  /** How long a key must be held before the hold action fires. */
  holdMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * One hold delay, acting while the key is still down (like iOS home-screen editing: hold until
 * something changes). A release before the delay is a tap; a release after the hold fired is
 * swallowed so it does not also count as a press.
 */
export class HoldGestures {
  private readonly pending = new Map<string, unknown>();
  private readonly fired = new Set<string>();
  private readonly holdMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly onHold: (slot: string) => void;

  constructor(onHold: (slot: string) => void, o: GestureOptions = {}) {
    this.onHold = onHold;
    this.holdMs = o.holdMs ?? 1000;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  keyDown(slot: string): void {
    this.cancel(slot);
    this.fired.delete(slot);
    this.pending.set(
      slot,
      this.setTimer(() => {
        this.pending.delete(slot);
        this.fired.add(slot);
        this.onHold(slot);
      }, this.holdMs),
    );
  }

  /** True when the release ends a plain tap (the hold never fired). */
  keyUp(slot: string): boolean {
    this.cancel(slot);
    return !this.fired.delete(slot);
  }

  private cancel(slot: string): void {
    const t = this.pending.get(slot);
    if (t !== undefined) this.clearTimer(t);
    this.pending.delete(slot);
  }
}
