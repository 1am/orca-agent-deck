import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SDK_CALLS, canUse, detectHost } from './host.ts';

const mac = { application: { version: '7.1.0', platform: 'mac' } };

describe('detectHost', () => {
  it('Linux can only be OpenDeck', () => {
    expect(detectHost({ application: { version: '1', platform: 'linux' } }, {}).kind).toBe(
      'opendeck',
    );
  });
  it('mac and windows cannot be told apart from the registration info: unknown unless forced', () => {
    expect(detectHost(mac, {})).toMatchObject({ kind: 'unknown', basis: 'none' });
    expect(detectHost(mac, { ORCA_DECK_HOST: 'OpenDeck' })).toMatchObject({
      kind: 'opendeck',
      basis: 'env',
    });
    expect(detectHost(mac, { ORCA_DECK_HOST: 'elgato' }).kind).toBe('elgato');
  });
});

describe('canUse', () => {
  it('non-portable features need the Elgato app; unknown hosts get the portable subset', () => {
    const el = detectHost(mac, { ORCA_DECK_HOST: 'elgato' });
    const od = detectHost(mac, { ORCA_DECK_HOST: 'opendeck' });
    const un = detectHost(mac, {});
    for (const f of ['bundledProfiles', 'switchToProfile', 'deviceDidChange'] as const) {
      expect(canUse(el, f)).toBe(true);
      expect(canUse(od, f)).toBe(false);
      expect(canUse(un, f)).toBe(false);
    }
  });
});

it('the sources call only SDK members listed in the allowlist', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(join(d, e.name));
    }
  };
  walk(dir);
  const used = new Set<string>();
  for (const f of files)
    for (const m of readFileSync(f, 'utf8').matchAll(/\bstreamDeck\.([a-zA-Z]+(?:\.[a-zA-Z]+)?)/g))
      used.add(m[1]!);
  const listed = new Set(Object.keys(SDK_CALLS));
  const unlisted = [...used].filter((u) => !listed.has(u) && !listed.has(u.split('.')[0]!));
  expect(unlisted, 'add these to SDK_CALLS in host.ts after checking both hosts').toEqual([]);
});
