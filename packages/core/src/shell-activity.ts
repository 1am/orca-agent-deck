/**
 * Activity indicator for panes without an agent (plain shells, tmux, long builds). Orca reports
 * no foreground process and no exit status for a shell, only when the pane last produced output,
 * so this is a heuristic: a pane that keeps printing for a while is "working", and when the
 * output stops after that it is "done". Short bursts (a prompt redraw, `ls`, the tmux clock)
 * never count. Success and failure cannot be told apart, so an ending is always "done"; a
 * process that exits non-zero ends its pane and Orca reports that separately.
 * Works on timestamps only, never on terminal content.
 */

export interface ShellActivityOptions {
  /** No output for this long ends a streak. */
  quietMs?: number;
  /** A streak shows as working only after this long, so quick commands stay invisible. */
  minBusyMs?: number;
}

export type ShellState = 'working' | 'done' | null;

interface Entry {
  streakStart: number | null;
  busy: boolean;
  done: boolean;
  doneAt: number | null;
}

export class ShellActivity {
  private readonly entries = new Map<string, Entry>();
  private readonly quietMs: number;
  private readonly minBusyMs: number;

  constructor(o: ShellActivityOptions = {}) {
    this.quietMs = o.quietMs ?? 4000;
    this.minBusyMs = o.minBusyMs ?? 8000;
  }

  /** Feed one poll; returns what the pane shows now. `done` stays until the next busy streak. */
  observe(paneKey: string, lastOutputAt: number | null | undefined, now: number): ShellState {
    let e = this.entries.get(paneKey);
    if (!e)
      this.entries.set(
        paneKey,
        (e = { streakStart: null, busy: false, done: false, doneAt: null }),
      );
    const active = typeof lastOutputAt === 'number' && now - lastOutputAt < this.quietMs;
    if (active) {
      e.streakStart ??= now;
      if (now - e.streakStart >= this.minBusyMs) {
        e.busy = true;
        e.done = false;
      }
    } else if (e.streakStart !== null) {
      if (e.busy) {
        e.busy = false;
        e.done = true;
        e.doneAt = now;
      }
      e.streakStart = null;
    }
    return e.busy ? 'working' : e.done ? 'done' : null;
  }

  /** Seconds the current busy streak has run, for the key's "working 42s". */
  busyFor(paneKey: string, now: number): number {
    const e = this.entries.get(paneKey);
    return e?.busy && e.streakStart !== null ? now - e.streakStart : 0;
  }

  /** Forget panes that are gone. */
  prune(live: Set<string>): void {
    for (const k of this.entries.keys()) if (!live.has(k)) this.entries.delete(k);
  }
}
