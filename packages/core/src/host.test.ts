import { describe, expect, it } from 'vitest';
import { detectHost, type RegistrationInfo } from './host.ts';

const elgato = (platform: string, dpr = 2): RegistrationInfo => ({
  application: { version: '7.1.1.22340', platform },
  devicePixelRatio: dpr,
});
// What OpenDeck 2.14.2 registers Node plugins with, on every OS.
const openDeck: RegistrationInfo = {
  application: { version: '7.1.0', platform: 'windows' },
  devicePixelRatio: 0,
};

describe('detectHost', () => {
  it.each([
    ['Elgato on mac', elgato('mac'), 'darwin', {}, 'mac', 'elgato', 'build-version'],
    ['Elgato on windows', elgato('windows', 1), 'win32', {}, 'windows', 'elgato', 'build-version'],
    ['OpenDeck on mac', openDeck, 'darwin', {}, 'mac', 'opendeck', 'version-pixel-ratio'],
    ['OpenDeck on windows', openDeck, 'win32', {}, 'windows', 'opendeck', 'version-pixel-ratio'],
    ['OpenDeck on linux', openDeck, 'linux', {}, 'linux', 'opendeck', 'linux'],
    [
      'platform windows on a non-Windows OS',
      { application: { version: '7.2.0', platform: 'windows' }, devicePixelRatio: 2 },
      'darwin',
      {},
      'mac',
      'opendeck',
      'platform-mismatch',
    ],
    [
      'env forces elgato over the signals',
      openDeck,
      'darwin',
      { ORCA_DECK_HOST: 'Elgato' },
      'mac',
      'elgato',
      'env',
    ],
    [
      'env forces opendeck',
      elgato('mac'),
      'darwin',
      { ORCA_DECK_HOST: 'opendeck' },
      'mac',
      'opendeck',
      'env',
    ],
    [
      'an unrecognised env value is ignored',
      elgato('mac'),
      'darwin',
      { ORCA_DECK_HOST: 'x' },
      'mac',
      'elgato',
      'build-version',
    ],
    [
      '3-part version with a real pixel ratio',
      { application: { version: '7.1.0', platform: 'mac' }, devicePixelRatio: 2 },
      'darwin',
      {},
      'mac',
      'unknown',
      'none',
    ],
    ['empty info', {}, 'darwin', {}, 'mac', 'unknown', 'none'],
    ['other OS', {}, 'freebsd', {}, 'other', 'unknown', 'none'],
  ] as const)('%s', (_name, info, platform, env, os, host, basis) => {
    expect(detectHost(info, platform, env)).toMatchObject({ os, host, basis });
  });

  it('keeps the registered version', () => {
    expect(detectHost(elgato('mac'), 'darwin', {}).version).toBe('7.1.1.22340');
  });
});
