import type { DeckState } from './status.ts';

export type AckSource = 'press' | 'focus' | 'dismiss';

export interface AckView {
  /** State to show; an acknowledged `completed` is shown as `idle`. Everything else stays until the agent moves on. */
  state: DeckState;
  /** Highlighted until acknowledged (needs_input, awaiting_reply, error, completed). */
  unread: boolean;
  /** Animation allowed (error blinks only until acknowledged). */
  animate: boolean;
  /** "waiting Xm" badge minutes, when needs_input is unacknowledged past the threshold. */
  waitingMinutes: number | null;
  /** Minutes since an acknowledged completion, for "done 12m". */
  doneMinutes: number | null;
  /** The state before acknowledgement (what the episode really was). */
  from: DeckState;
}

interface Entry {
  state: DeckState;
  since: number;
  acked: boolean;
  ackedBy?: AckSource;
}

const HIGHLIGHTED = new Set<DeckState>(['needs_input', 'awaiting_reply', 'error', 'completed']);

/** Tracks acknowledgement per pane. The agent leaving a state resets it. */
export class AckTracker {
  private readonly entries = new Map<string, Entry>();

  private readonly waitingBadgeAfterMs: number;

  constructor(waitingBadgeAfterMs = 5 * 60_000) {
    this.waitingBadgeAfterMs = waitingBadgeAfterMs;
  }

  /** Feed the derived state; a change of state starts a new, unacknowledged episode. */
  update(paneKey: string, state: DeckState, now: number): void {
    const e = this.entries.get(paneKey);
    if (!e || e.state !== state) this.entries.set(paneKey, { state, since: now, acked: false });
  }

  /** Any source acknowledges the current episode (press, focus in Orca, Orca dismiss). */
  ack(paneKey: string, source: AckSource): void {
    const e = this.entries.get(paneKey);
    if (e) {
      e.acked = true;
      e.ackedBy = source;
    }
  }

  view(paneKey: string, now: number): AckView | undefined {
    const e = this.entries.get(paneKey);
    if (!e) return undefined;
    const highlighted = HIGHLIGHTED.has(e.state);
    const unread = highlighted && !e.acked;
    const mins = Math.floor((now - e.since) / 60_000);
    const waiting = e.state === 'needs_input' && unread && now - e.since > this.waitingBadgeAfterMs;
    // Only a completion can be read away; a question, like a permission prompt, stays until answered.
    const ackedDone = e.state === 'completed' && e.acked;
    return {
      state: ackedDone ? 'idle' : e.state,
      unread,
      animate: e.state === 'error' ? unread : true,
      waitingMinutes: waiting ? mins : null,
      doneMinutes: ackedDone ? mins : null,
      from: e.state,
    };
  }
}
