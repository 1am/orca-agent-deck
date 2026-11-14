import { describe, expect, it } from 'vitest';
import { portsFromEnv } from './discovery.ts';

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
