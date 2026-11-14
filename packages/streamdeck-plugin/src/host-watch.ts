export interface HostWatchOptions {
  /** Parent pid at start: the Stream Deck host that spawned this plugin. */
  parent: number;
  getPpid?: () => number;
  /** Signal 0 to a pid: does the process still exist? */
  alive?: (pid: number) => boolean;
  intervalMs?: number;
  onGone: (why: string) => void;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but is not ours.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Calls `onGone` once when the Stream Deck host that started this plugin is gone. The SDK does not report a
 * closed host socket, and a plugin whose host quit is reparented (ppid changes, 1 on macOS/Linux) and would
 * keep its bridge port and discovery file for good. Returns the stop function.
 */
export function watchHost(o: HostWatchOptions): () => void {
  const getPpid = o.getPpid ?? (() => process.ppid);
  const alive = o.alive ?? isAlive;
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    const now = getPpid();
    const why =
      now !== o.parent
        ? `parent changed ${o.parent} -> ${now}`
        : !alive(o.parent)
          ? `parent ${o.parent} is gone`
          : '';
    if (!why) return;
    done = true;
    clearInterval(timer);
    o.onGone(why);
  }, o.intervalMs ?? 2000);
  timer.unref?.();
  return () => {
    done = true;
    clearInterval(timer);
  };
}
