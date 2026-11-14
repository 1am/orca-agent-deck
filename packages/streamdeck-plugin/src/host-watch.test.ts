import { describe, expect, it, vi } from 'vitest';
import { watchHost } from './host-watch.ts';

describe('watchHost', () => {
  it('stays quiet while the host lives', () => {
    vi.useFakeTimers();
    const onGone = vi.fn();
    watchHost({ parent: 10, getPpid: () => 10, alive: () => true, intervalMs: 10, onGone });
    vi.advanceTimersByTime(100);
    expect(onGone).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('reports once when the plugin is reparented', () => {
    vi.useFakeTimers();
    const onGone = vi.fn();
    let ppid = 10;
    watchHost({ parent: 10, getPpid: () => ppid, alive: () => true, intervalMs: 10, onGone });
    ppid = 1;
    vi.advanceTimersByTime(100);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onGone.mock.calls[0]![0]).toContain('10 -> 1');
    vi.useRealTimers();
  });
  it('reports a parent that no longer exists (Windows does not reparent)', () => {
    vi.useFakeTimers();
    const onGone = vi.fn();
    let up = true;
    watchHost({ parent: 10, getPpid: () => 10, alive: () => up, intervalMs: 10, onGone });
    up = false;
    vi.advanceTimersByTime(20);
    expect(onGone).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
