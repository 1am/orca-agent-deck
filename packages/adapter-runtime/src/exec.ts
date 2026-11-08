import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliAdapter, type Exec } from '@orca-agent-deck/adapter-cli';
import { RuntimeClient, RuntimeUnavailableError, defaultMetaPath } from './client.ts';

export interface RuntimeExecOptions {
  client: RuntimeClient;
  /** Real CLI, used for what the runtime socket cannot answer and when the socket is down. */
  fallback: Exec;
  /** Path of Orca's saved-environments file. Only its mtime is read, never its content (tokens). */
  environmentsFile?: string;
  /** Minimum time between `--environment` CLI polls of a paired server. */
  environmentPollMs?: number;
  now?: () => number;
  /** Called once when calls start using the CLI because the socket is unusable (and when the reason changes). */
  onFallback?: (reason: string) => void;
  /** Called once when the socket answers again after a fallback. */
  onRecover?: () => void;
  /** Set on every call: true when the socket answered, false when the CLI had to. */
  served?: { socket: boolean };
}

const envelope = (result: unknown) => JSON.stringify({ id: 'runtime', ok: true, result });

/** `-- json` is appended by the adapter; strip it to route on the command words. */
const words = (args: string[]) => args.filter((a) => a !== '--json');
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * An `Exec` that answers the CLI calls the adapter makes from the runtime socket (about 5 ms
 * instead of a 230 ms process spawn) and uses the real CLI only for paired servers
 * (`--environment`, throttled), the environment list (refreshed when Orca's file changes) and as
 * the degraded fallback when the socket is unusable. Reuses CliAdapter's parsing and mapping.
 */
export function makeRuntimeExec(opts: RuntimeExecOptions): Exec {
  const now = opts.now ?? Date.now;
  const envInterval = opts.environmentPollMs ?? 5000;
  const envCache = new Map<string, { at: number; out?: string; error?: unknown }>();
  const refreshing = new Set<string>();
  let envList: { mtime: number; hosts: Array<{ id: string; name: string }> } | null = null;
  /** Why the socket is unusable, or null while it answers; every poll fails the same way while Orca is down. */
  let degraded: string | null = null;

  async function environments(): Promise<Array<{ id: string; name: string }>> {
    let mtime = 0;
    try {
      mtime = (await stat(opts.environmentsFile ?? '')).mtimeMs;
    } catch {
      return []; // no file: no paired servers, nothing to spawn
    }
    if (envList && envList.mtime === mtime) return envList.hosts;
    const out = await opts.fallback(['environment', 'list', '--json']);
    const parsed = JSON.parse(out) as {
      result?: { environments?: Array<{ id: string; name: string }> };
    };
    const hosts = (parsed.result?.environments ?? []).map((e) => ({ id: e.id, name: e.name }));
    envList = { mtime, hosts };
    return hosts;
  }

  async function viaRuntime(args: string[]): Promise<string | null> {
    const w = words(args);
    const [a, b] = w;
    const c = opts.client;
    if (a === 'status' && w.length === 1) {
      const s = await c.call<{ graphStatus?: string; appVersion?: string }>('status.get');
      return envelope({
        app: { running: true },
        runtime: {
          state: s.graphStatus === 'ready' ? 'ready' : (s.graphStatus ?? 'unknown'),
          appVersion: s.appVersion ?? null,
        },
      });
    }
    if (a === 'terminal' && b === 'list') return envelope(await c.call('terminal.list'));
    if (a === 'worktree' && b === 'ps') return envelope(await c.call('worktree.ps'));
    if (a === 'terminal' && b === 'switch') {
      const terminal = flag(w, '--terminal');
      return envelope(await c.call('terminal.focus', terminal ? { terminal } : {}));
    }
    if (a === 'terminal' && b === 'reveal') {
      // Not a CLI command: the adapter's direct route to a paired-server pane (see CliAdapter.focus).
      return envelope(
        await c.call('terminal.reveal', {
          worktreeId: flag(w, '--worktree'),
          tabId: flag(w, '--tab'),
          leafId: flag(w, '--leaf'),
          executionHostId: flag(w, '--execution-host'),
        }),
      );
    }
    if (a === 'terminal' && b === 'show') {
      const { handle } = await c.call<{ handle: string }>('terminal.resolveActive');
      return envelope(await c.call('terminal.show', { terminal: handle }));
    }
    if (a === 'worktree' && b === 'set' && (w.includes('--read') || w.includes('--unread'))) {
      const worktree = flag(w, '--worktree');
      if (!worktree) return null;
      return envelope(await c.call('worktree.set', { worktree, isUnread: w.includes('--unread') }));
    }
    if (a === 'host' && b === 'list') {
      const { targets } = await c.call<{
        targets: Array<{ id: string; label: string; connected: boolean }>;
      }>('ssh.listTargets');
      const envs = await environments();
      return envelope({
        hosts: [
          { kind: 'local', name: 'this machine', id: 'local' },
          ...targets.map((t) => ({ kind: 'ssh', name: t.label, id: t.id, connected: t.connected })),
          ...envs.map((e) => ({ kind: 'environment', name: e.name, id: e.id })),
        ],
      });
    }
    return null;
  }

  return async (args) => {
    const env = flag(args, '--environment');
    if (env !== undefined) {
      // Paired servers are other runtimes: only the CLI reaches them. Poll them slowly, but never
      // cache a focus call.
      const isSwitch = args[0] === 'terminal' && args[1] === 'switch';
      const key = args.join('\0');
      const fetchEnv = async (): Promise<string> => {
        try {
          const out = await opts.fallback(args);
          if (!isSwitch) envCache.set(key, { at: now(), out });
          return out;
        } catch (error) {
          // An unreachable server is cached too, otherwise every refresh pays the CLI timeout.
          if (!isSwitch) envCache.set(key, { at: now(), error });
          throw error;
        }
      };
      const hit = isSwitch ? undefined : envCache.get(key);
      if (hit) {
        // Stale data is served at once and refreshed in the background: a slow paired server
        // (a CLI spawn plus a network round trip) must not hold up every poll of the local panes.
        if (now() - hit.at >= envInterval && !refreshing.has(key)) {
          refreshing.add(key);
          void fetchEnv()
            .catch(() => {})
            .finally(() => refreshing.delete(key));
        }
        if (hit.error !== undefined) throw hit.error;
        return hit.out ?? '';
      }
      return fetchEnv();
    }
    try {
      const out = await viaRuntime(args);
      if (out !== null) {
        if (opts.served) opts.served.socket = true;
        if (degraded !== null) {
          degraded = null;
          opts.onRecover?.();
        }
        return out;
      }
    } catch (e) {
      if (!(e instanceof RuntimeUnavailableError)) throw e;
      if (e.message !== degraded) opts.onFallback?.(e.message);
      degraded = e.message;
    }
    if (opts.served) opts.served.socket = false;
    // The CLI has no `terminal reveal`; the adapter then focuses through `terminal switch`.
    if (args[0] === 'terminal' && args[1] === 'reveal')
      throw new Error('reveal needs the runtime socket');
    return opts.fallback(args);
  };
}

export interface RuntimeAdapterOptions {
  client?: RuntimeClient;
  fallback: Exec;
  environmentPollMs?: number;
  /** Orca's environments file (default: next to the runtime file). Only its mtime is read. */
  environmentsFile?: string;
  onFallback?: (reason: string) => void;
  onRecover?: () => void;
}

/** The adapter used in steady state: runtime socket first, CLI only as degraded fallback. */
export function createRuntimeAdapter(opts: RuntimeAdapterOptions): CliAdapter {
  const metaPath = defaultMetaPath();
  const client = opts.client ?? new RuntimeClient({ metaPath });
  const served = { socket: false };
  const adapter = new CliAdapter(
    makeRuntimeExec({
      client,
      fallback: opts.fallback,
      environmentsFile: opts.environmentsFile ?? join(dirname(metaPath), 'orca-environments.json'),
      environmentPollMs: opts.environmentPollMs,
      onFallback: opts.onFallback,
      onRecover: opts.onRecover,
      served,
    }),
  );
  // Cheap reads (socket) let the controller read the focused pane on every refresh.
  const health = adapter.health.bind(adapter);
  adapter.health = async () => ({ ...(await health()), fast: served.socket });
  return adapter;
}
