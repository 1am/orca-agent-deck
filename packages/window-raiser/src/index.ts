import { execFile } from 'node:child_process';

export interface RaiseResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/** Brings the Orca window to the front. */
export interface WindowRaiser {
  raise(): Promise<RaiseResult>;
}

/** Runs a command and resolves with its stdout when it exits 0. Injectable for tests. */
export type Run = (cmd: string, args: string[]) => Promise<string | void>;

const ORCA_BUNDLE_ID = 'com.stablyai.orca';
/** X11 window class of Orca (xdotool matches it case-insensitively, so the wmctrl path does too). */
const WM_CLASS = 'orca';

const run: Run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

class CommandRaiser implements WindowRaiser {
  private readonly cmd: string;
  private readonly args: string[];
  private readonly exec: Run;

  constructor(cmd: string, args: string[], exec: Run) {
    this.cmd = cmd;
    this.args = args;
    this.exec = exec;
  }

  async raise(): Promise<RaiseResult> {
    const t0 = performance.now();
    try {
      await this.exec(this.cmd, this.args);
      return { ok: true, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, ms: Math.round(performance.now() - t0), error: (e as Error).message };
    }
  }
}

/** Default on macOS: needs no permission. */
export const openAppRaiser = (exec: Run = run): WindowRaiser =>
  new CommandRaiser('open', ['-b', ORCA_BUNDLE_ID], exec);

/** Platforms without a raise strategy (Windows, Wayland): focusing the pane inside Orca still works. */
export const noopRaiser: WindowRaiser = { raise: async () => ({ ok: true, ms: 0 }) };

/** Id of the first window in `wmctrl -lx` output whose class (the part after the instance dot) is Orca's. */
function findWindowId(listing: string): string | undefined {
  for (const line of listing.split('\n')) {
    // `<id> <desktop> <instance>.<class> <host> <title>`
    const [id, , wmClass] = line.trim().split(/\s+/);
    if (id && wmClass?.slice(wmClass.lastIndexOf('.') + 1).toLowerCase() === WM_CLASS) return id;
  }
  return undefined;
}

/**
 * Linux on X11: tries each tool that is installed, in order, until one raises the window.
 * Presence is probed with a harmless call, so a missing tool costs one failed spawn per raise at
 * most and is remembered.
 */
class X11Raiser implements WindowRaiser {
  private readonly exec: Run;
  private readonly strategies: ReadonlyArray<{
    probe: [string, string[]];
    raise: () => Promise<void>;
  }> = [
    {
      probe: ['xdotool', ['version']],
      // Anchored: the class is a regex and would also match other apps such as `orca-ide`.
      // Visible only and one hit: Electron also keeps a hidden leader window of the same class.
      raise: async () => {
        await this.exec('xdotool', [
          'search',
          '--onlyvisible',
          '--limit',
          '1',
          '--class',
          `^${WM_CLASS}$`,
          'windowactivate',
        ]);
      },
    },
    {
      probe: ['wmctrl', ['-m']],
      // `wmctrl -a` matches substrings of the class and needs the instance name: pick the window
      // by its exact class from the listing and activate it by id.
      raise: async () => {
        const id = findWindowId((await this.exec('wmctrl', ['-lx'])) || '');
        if (!id) throw new Error(`no ${WM_CLASS} window`);
        await this.exec('wmctrl', ['-i', '-a', id]);
      },
    },
  ];
  private usable: (typeof this.strategies)[number] | null | undefined;

  constructor(exec: Run) {
    this.exec = exec;
  }

  async raise(): Promise<RaiseResult> {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    if (this.usable === undefined) {
      this.usable = null;
      for (const s of this.strategies) {
        try {
          await this.exec(s.probe[0], s.probe[1]);
          this.usable = s;
          break;
        } catch {
          // not installed
        }
      }
    }
    if (!this.usable) return { ok: false, ms: ms(), error: 'no X11 raise tool (xdotool, wmctrl)' };
    try {
      await this.usable.raise();
      return { ok: true, ms: ms() };
    } catch (e) {
      return { ok: false, ms: ms(), error: (e as Error).message };
    }
  }
}

export function makeRaiser(
  platform: NodeJS.Platform = process.platform,
  exec: Run = run,
  env: Record<string, string | undefined> = process.env,
): WindowRaiser {
  if (platform === 'darwin') return openAppRaiser(exec);
  if (platform === 'linux') {
    // Wayland compositors do not let a client raise another's window: no tool to try.
    const wayland = !!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11';
    return wayland || !env.DISPLAY ? noopRaiser : new X11Raiser(exec);
  }
  return noopRaiser;
}
