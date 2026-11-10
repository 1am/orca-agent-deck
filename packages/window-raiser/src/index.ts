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

/** Runs a command and resolves when it exits 0. Injectable for tests. */
export type Run = (cmd: string, args: string[]) => Promise<void>;

const ORCA_BUNDLE_ID = 'com.stablyai.orca';

const run: Run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 3000 }, (err) => (err ? reject(err) : resolve())),
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

/**
 * Linux on X11: tries each tool that is installed, in order, until one raises the window.
 * Presence is probed with a harmless call, so a missing tool costs one failed spawn per raise at
 * most and is remembered.
 */
class X11Raiser implements WindowRaiser {
  private readonly exec: Run;
  private readonly strategies = [
    {
      probe: ['xdotool', ['version']],
      // Anchored: the class is a regex and would also match other apps such as `orca-ide`.
      raise: ['xdotool', ['search', '--class', '^orca$', 'windowactivate']],
    },
    { probe: ['wmctrl', ['-m']], raise: ['wmctrl', ['-x', '-a', 'orca.orca']] },
  ] as const;
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
          await this.exec(s.probe[0], [...s.probe[1]]);
          this.usable = s;
          break;
        } catch {
          // not installed
        }
      }
    }
    if (!this.usable) return { ok: false, ms: ms(), error: 'no X11 raise tool (xdotool, wmctrl)' };
    try {
      await this.exec(this.usable.raise[0], [...this.usable.raise[1]]);
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
