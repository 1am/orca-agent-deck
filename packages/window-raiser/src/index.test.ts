import { describe, expect, it } from 'vitest';
import { makeRaiser, noopRaiser, openAppRaiser, type Run } from './index.js';

describe('window-raiser', () => {
  it('opens the Orca bundle id on macOS', async () => {
    const calls: string[][] = [];
    const exec: Run = async (cmd, args) => void calls.push([cmd, ...args]);
    const r = await makeRaiser('darwin', exec).raise();
    expect(r.ok).toBe(true);
    expect(calls).toEqual([['open', '-b', 'com.stablyai.orca']]);
  });

  it('reports failure with timing instead of throwing', async () => {
    const r = await openAppRaiser(async () => {
      throw new Error('boom');
    }).raise();
    expect(r).toMatchObject({ ok: false, error: 'boom' });
  });

  it('is a no-op on Windows, on Wayland and without a display', () => {
    expect(makeRaiser('win32')).toBe(noopRaiser);
    expect(makeRaiser('linux', undefined, { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe(
      noopRaiser,
    );
    expect(makeRaiser('linux', undefined, {})).toBe(noopRaiser);
  });

  describe('Linux X11', () => {
    const env = { DISPLAY: ':0' };
    const recorder = (missing: string[] = [], failRaise = false) => {
      const calls: string[][] = [];
      const exec: Run = async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (missing.includes(cmd)) throw new Error(`spawn ${cmd} ENOENT`);
        if (failRaise && args.includes('windowactivate')) throw new Error('no window');
      };
      return { calls, exec };
    };

    it('uses xdotool when installed', async () => {
      const { calls, exec } = recorder();
      expect((await makeRaiser('linux', exec, env).raise()).ok).toBe(true);
      expect(calls).toEqual([
        ['xdotool', 'version'],
        ['xdotool', 'search', '--class', 'orca', 'windowactivate'],
      ]);
    });

    it('falls back to wmctrl and remembers the choice', async () => {
      const { calls, exec } = recorder(['xdotool']);
      const r = makeRaiser('linux', exec, env);
      await r.raise();
      calls.length = 0;
      await r.raise();
      expect(calls).toEqual([['wmctrl', '-x', '-a', 'orca']]);
    });

    it('reports a missing tool instead of throwing', async () => {
      const { exec } = recorder(['xdotool', 'wmctrl']);
      expect(await makeRaiser('linux', exec, env).raise()).toMatchObject({
        ok: false,
        error: expect.stringContaining('xdotool'),
      });
    });

    it('reports a failed raise', async () => {
      const { exec } = recorder([], true);
      expect(await makeRaiser('linux', exec, env).raise()).toMatchObject({ ok: false });
    });
  });
});
