import { describe, expect, it } from 'vitest';
import { AckTracker, type AckSource } from './ack.ts';

const MIN = 60_000;

describe('AckTracker', () => {
  it.each<AckSource>(['press', 'focus', 'dismiss'])('completed -> idle after %s', (src) => {
    const t = new AckTracker();
    t.update('p', 'completed', 0);
    expect(t.view('p', 0)).toMatchObject({ state: 'completed', unread: true });
    t.ack('p', src);
    expect(t.view('p', 12 * MIN)).toMatchObject({ state: 'idle', unread: false, doneMinutes: 12 });
  });

  it('error stays red but stops blinking after ack', () => {
    const t = new AckTracker();
    t.update('p', 'error', 0);
    expect(t.view('p', 1)).toMatchObject({ state: 'error', animate: true });
    t.ack('p', 'press');
    expect(t.view('p', 2)).toMatchObject({ state: 'error', unread: false, animate: false });
  });

  it('agent leaving the state resets the episode', () => {
    const t = new AckTracker();
    t.update('p', 'completed', 0);
    t.ack('p', 'press');
    t.update('p', 'working', 10);
    t.update('p', 'completed', 20);
    expect(t.view('p', 20)).toMatchObject({ state: 'completed', unread: true });
  });

  it('repeated updates with the same state keep the ack', () => {
    const t = new AckTracker();
    t.update('p', 'completed', 0);
    t.ack('p', 'press');
    t.update('p', 'completed', 5);
    expect(t.view('p', 5)?.unread).toBe(false);
  });

  it('shows waiting badge only after the threshold and while unacked', () => {
    const t = new AckTracker();
    t.update('p', 'needs_input', 0);
    expect(t.view('p', 5 * MIN)?.waitingMinutes).toBeNull();
    expect(t.view('p', 6 * MIN)?.waitingMinutes).toBe(6);
    t.ack('p', 'press');
    expect(t.view('p', 7 * MIN)?.waitingMinutes).toBeNull();
  });

  it('threshold is configurable', () => {
    const t = new AckTracker(1 * MIN);
    t.update('p', 'needs_input', 0);
    expect(t.view('p', 2 * MIN)?.waitingMinutes).toBe(2);
  });

  it('non-highlighted states are never unread', () => {
    const t = new AckTracker();
    t.update('p', 'working', 0);
    expect(t.view('p', 1)?.unread).toBe(false);
  });
});

describe('awaiting_reply acknowledgement', () => {
  it('stays "asks you" after acknowledgement, like a permission prompt, until the agent moves on', () => {
    const t = new AckTracker();
    t.update('p', 'awaiting_reply', 0);
    expect(t.view('p', 1000)).toMatchObject({ state: 'awaiting_reply', unread: true });
    t.ack('p', 'focus');
    expect(t.view('p', 120_000)).toMatchObject({
      state: 'awaiting_reply',
      unread: false,
      doneMinutes: null,
    });
  });
  it('a new episode (agent works again, then asks again) is unacknowledged again', () => {
    const t = new AckTracker();
    t.update('p', 'awaiting_reply', 0);
    t.ack('p', 'press');
    t.update('p', 'working', 10);
    t.update('p', 'awaiting_reply', 20);
    expect(t.view('p', 30)?.unread).toBe(true);
  });
});
