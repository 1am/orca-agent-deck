import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types, run with node in the public repository
import { withRelease } from './catalog.mjs';

const entry = (version: string) => ({ version, commit: version, contentHash: 'h' });

it('creates the catalog, puts new releases first and replaces a re-run of the same version', () => {
  const first = withRelease(null, {
    pluginKey: '1am.agent-deck',
    entry: entry('0.2.0'),
  });
  expect(first).toMatchObject({ catalogVersion: 2, owner: '1am' });
  expect(first.plugins[0].source).toEqual({
    kind: 'git',
    url: 'https://github.com/1am/orca-agent-deck.git',
    ref: 'main',
  });
  const second = withRelease(first, {
    pluginKey: '1am.agent-deck',
    entry: entry('0.3.0'),
  });
  const again = withRelease(second, {
    pluginKey: '1am.agent-deck',
    entry: { ...entry('0.3.0'), commit: 'new' },
  });
  expect(again.plugins).toHaveLength(1);
  expect(again.plugins[0].releases.map((r: { commit: string }) => r.commit)).toEqual([
    'new',
    '0.2.0',
  ]);
});

it('drops the releases made under another source path', () => {
  const old = withRelease(null, {
    pluginKey: '1am.agent-deck',
    entry: entry('0.1.0'),
    sourcePath: 'orca-plugin',
  });
  const moved = withRelease(old, { pluginKey: '1am.agent-deck', entry: entry('0.2.0') });
  expect(moved.plugins[0].source).not.toHaveProperty('path');
  expect(moved.plugins[0].releases.map((r: { version: string }) => r.version)).toEqual(['0.2.0']);
});
