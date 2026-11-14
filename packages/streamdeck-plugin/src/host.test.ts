import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectHost } from '@orca-agent-deck/core';
import { SDK_CALLS, canUse } from './host.ts';

const mac = { application: { version: '7.1.0', platform: 'mac' } };
const host = (env: Record<string, string>) => detectHost(mac, 'darwin', env);

describe('canUse', () => {
  it('non-portable features need the Elgato app; unknown hosts get the portable subset', () => {
    const el = host({ ORCA_DECK_HOST: 'elgato' });
    const od = host({ ORCA_DECK_HOST: 'opendeck' });
    const un = host({});
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
