import { createHash } from 'node:crypto';

/**
 * Stream Deck host profiles: exactly the inputs plugin B's `detectHost` reads (registration info) plus how the host
 * behaves toward property inspectors, from the OpenDeck source review (docs/compatibility.md). B reads the real
 * `process.platform`, so a profile only runs on the OS it names (CI covers the others).
 */
export interface Profile {
  id: string;
  /** `process.platform` this profile can run on. */
  os: NodeJS.Platform;
  version: string;
  platform: string;
  platformVersion: string;
  devicePixelRatio: number;
  /** What `detectHost` must conclude. */
  expect: { host: 'elgato' | 'opendeck'; basis: string };
  /** OpenDeck mounts one hidden PI per action at profile load; they send `load` before any propertyInspectorDidAppear. */
  hiddenPis: boolean;
  deviceId: string;
  /** The action context of a key (row-major, 1-based). */
  context(key: number): string;
}

const hex = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 32).toUpperCase();

const elgato = (
  id: string,
  os: NodeJS.Platform,
  platform: string,
  pv: string,
  dpr: number,
): Profile => ({
  id,
  os,
  version: '7.1.1.22340',
  platform,
  platformVersion: pv,
  devicePixelRatio: dpr,
  expect: { host: 'elgato', basis: 'build-version' },
  hiddenPis: false,
  deviceId: '@(1)[4057/128/FAKE0001]',
  context: (key) => hex(`${id}/${key}`),
});

// OpenDeck 2.14.2 registers every Node plugin as version 7.1.0, platform windows, pixel ratio 0, on every OS.
const opendeck = (id: string, os: NodeJS.Platform, basis: string): Profile => ({
  id,
  os,
  version: '7.1.0',
  platform: 'windows',
  platformVersion: '10.0.19045.4474',
  devicePixelRatio: 0,
  expect: { host: 'opendeck', basis },
  hiddenPis: true,
  deviceId: 'sd-FAKE0001',
  context: (key) => `sd-FAKE0001.Default.Keypad.${key - 1}.0`,
});

export const PROFILES: Record<string, Profile> = Object.fromEntries(
  [
    elgato('elgato-mac', 'darwin', 'mac', '15.1', 2),
    elgato('elgato-windows', 'win32', 'windows', '10.0.19045', 1),
    opendeck('opendeck-mac', 'darwin', 'version-pixel-ratio'),
    opendeck('opendeck-windows', 'win32', 'version-pixel-ratio'),
    opendeck('opendeck-linux', 'linux', 'linux'),
  ].map((p) => [p.id, p]),
);
