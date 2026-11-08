/** Orca plugin key of plugin A (`<publisher>.<id>`). */
export const PLUGIN_A_KEY = '1am.agent-deck';

/**
 * Is plugin A installed and not disabled, from `orca plugin list --json`? Orca starts a worker
 * lazily (on the first event or command), so an installed plugin that never connected is just
 * asleep, not missing.
 */
export function pluginAInstalled(stdout: string): boolean {
  try {
    const r = JSON.parse(stdout) as {
      result?: { plugins?: { pluginKey?: string; status?: string }[] };
    };
    const p = r.result?.plugins?.find((x) => x.pluginKey === PLUGIN_A_KEY);
    return !!p && p.status !== 'disabled';
  } catch {
    return false;
  }
}

const INSTALLED_TTL_MS = 60_000;

/**
 * Cached "is plugin A installed" answer. `installed` is null until a probe has answered (or when
 * it failed), which callers must not read as "missing". `refresh(true)` skips the cache and is
 * awaitable, for an explicit "Check again".
 */
export class PluginInstallProbe {
  private value: boolean | null = null;
  private at = -Infinity;
  private inflight: Promise<void> | null = null;

  private readonly exec: (args: string[]) => Promise<string>;
  private readonly now: () => number;

  constructor(exec: (args: string[]) => Promise<string>, now: () => number = Date.now) {
    this.exec = exec;
    this.now = now;
  }

  get installed(): boolean | null {
    return this.value;
  }

  /** Starts a probe unless a fresh answer exists (or one is running); `force` ignores the cache. */
  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!force && this.now() - this.at < INSTALLED_TTL_MS) return Promise.resolve();
    this.at = this.now();
    this.inflight = this.exec(['plugin', 'list', '--json'])
      .then((out) => void (this.value = pluginAInstalled(out)))
      .catch(() => void (this.value = null))
      .finally(() => (this.inflight = null));
    return this.inflight;
  }
}
