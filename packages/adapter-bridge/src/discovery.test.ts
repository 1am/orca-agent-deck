import { describe, expect, it, vi } from 'vitest';
type PathEnv = { platform: string; env: Record<string, string>; homedir: string };
import { deckDataDir, portsFromEnv } from './discovery.ts';

describe('portsFromEnv', () => {
  it('is empty when the variable is unset or empty', () => {
    expect(portsFromEnv(undefined)).toEqual({});
    expect(portsFromEnv('')).toEqual({});
  });
  it('reads a list of ports, 0 meaning any free port', () => {
    expect(portsFromEnv('0')).toEqual({ ports: [0] });
    expect(portsFromEnv('47810, 47811')).toEqual({ ports: [47810, 47811] });
  });
  it.each(['abc', '47800,', ',47800', '47800,,47801', 'NaN', '-1', '65536', '1.5', '47800;47801'])(
    'ignores the whole value %j and reports it',
    (value) => {
      expect(portsFromEnv(value)).toEqual({ bad: value });
    },
  );
});

const plugin = '../../../orca-plugin/main.mjs'; // plain JS, no types

describe('plugin A and plugin B agree on the discovery file', () => {
  // B writes bridge.json where deckDataDir() says and A reads it where main.mjs's deckDataDir says: on Windows both
  // are %APPDATA%\\orca-deck (home\\AppData\\Roaming\\orca-deck without APPDATA), elsewhere ~/.orca-deck.
  const slashes = (p: string) => p.replaceAll('\\', '/');
  const asPlatform = (platform: NodeJS.Platform, run: () => void) => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      run();
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
  };

  it.each([
    {
      name: 'win32 with APPDATA',
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming' },
    },
    { name: 'win32 without APPDATA', platform: 'win32', env: {} },
    { name: 'darwin', platform: 'darwin', env: {} },
    { name: 'linux', platform: 'linux', env: { APPDATA: 'ignored' } },
  ] as const)('$name', async ({ platform, env }) => {
    const a = (await import(/* @vite-ignore */ plugin)) as {
      deckDataDir: (h: {
        platform: string;
        env: Record<string, string>;
        homedir: string;
      }) => string;
    };
    const { homedir } = await import('node:os');
    vi.stubEnv('APPDATA', (env as { APPDATA?: string }).APPDATA ?? '');
    asPlatform(platform, () => {
      const fromB = deckDataDir();
      const fromA = a.deckDataDir({
        platform,
        env: { ...(env as Record<string, string>) },
        homedir: homedir(),
      });
      expect(slashes(fromB)).toBe(slashes(fromA));
    });
    vi.unstubAllEnvs();
  });
});

describe('plugin A data dir', () => {
  it('is the per-user folder of each OS, like adapter-bridge', async () => {
    const plugin = '../../../orca-plugin/main.mjs'; // plain JS, no types
    const a = (await import(/* @vite-ignore */ plugin)) as {
      deckDataDir: (e: {
        platform: string;
        env: Record<string, string>;
        homedir: string;
      }) => string;
    };
    expect(
      a.deckDataDir({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming' },
        homedir: 'C:\\Users\\Ann',
      }),
    ).toBe('C:\\Users\\Ann\\AppData\\Roaming\\orca-deck');
    expect(a.deckDataDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\Ann' })).toBe(
      'C:\\Users\\Ann\\AppData\\Roaming\\orca-deck',
    );
    expect(a.deckDataDir({ platform: 'darwin', env: {}, homedir: '/Users/ann' })).toBe(
      '/Users/ann/.orca-deck',
    );
    expect(
      a.deckDataDir({ platform: 'linux', env: { APPDATA: 'ignored' }, homedir: '/home/ann' }),
    ).toBe('/home/ann/.orca-deck');
  });
});

describe('plugin A uninstall', () => {
  it('removes exactly the data dir and refuses anything else', async () => {
    const plugin = '../../../orca-plugin/main.mjs';
    const a = (await import(/* @vite-ignore */ plugin)) as {
      removeDeckData: (
        target: string,
        h: PathEnv,
        remove: (p: string, o: unknown) => Promise<void>,
      ) => Promise<string>;
      uninstallText: (dir: string) => string;
    };
    const h: PathEnv = { platform: 'darwin', env: {}, homedir: '/Users/ann' };
    const removed: string[] = [];
    const remove = async (p: string) => void removed.push(p);
    expect(await a.removeDeckData('/Users/ann/.orca-deck', h, remove)).toBe(
      '/Users/ann/.orca-deck',
    );
    expect(removed).toEqual(['/Users/ann/.orca-deck']);
    for (const target of [
      '/Users/ann',
      '/',
      '/Users/ann/.orca-deck/',
      '/Users/ann/.orca-deck/x',
      '/tmp/.orca-deck',
      '',
    ])
      await expect(a.removeDeckData(target, h, remove)).rejects.toThrow(/refusing/);
    // The data dir must never be the home dir itself.
    await expect(
      a.removeDeckData('/Users/ann/.orca-deck', { ...h, homedir: '/Users/ann/.orca-deck' }, remove),
    ).rejects.toThrow(/refusing/);
    const win: PathEnv = {
      platform: 'win32',
      env: { APPDATA: 'C:\\U\\AppData\\Roaming' },
      homedir: 'C:\\U',
    };
    expect(await a.removeDeckData('C:\\U\\AppData\\Roaming\\orca-deck', win, remove)).toBe(
      'C:\\U\\AppData\\Roaming\\orca-deck',
    );
    await expect(a.removeDeckData('C:\\U\\AppData\\Roaming', win, remove)).rejects.toThrow(
      /refusing/,
    );
    expect(a.uninstallText('/Users/ann/.orca-deck').length).toBeLessThanOrEqual(200);
    expect(a.uninstallText('/Users/ann/.orca-deck')).toMatch(
      /recreates your mappings.*Elgato app.*OpenDeck.*Orca Settings/,
    );
    // A long Windows path still leaves the warning in the toast.
    const long = a.uninstallText(`C:\\Users\\${'a'.repeat(40)}\\AppData\\Roaming\\orca-deck`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long).toContain('recreates your mappings');
  });
});
