import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MappingStore, MemoryStorage, type SlotSettings } from '@orca-agent-deck/core';
import { FileSlotStorage } from './mapping-file.ts';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'mappings-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const slot = (paneKey: string, column = 0): SlotSettings => ({
  mode: 'pinned',
  pos: { device: 'D1', column, row: 0 },
  pane: { paneKey, worktreeId: 'w', tabId: 't', leafId: 'l', lastKnown: {} },
});

it('saves privately and loads what it saved, also into the host cache', () => {
  const path = join(dir, 'sub', 'mappings.json');
  const cache = new MemoryStorage();
  const f = new FileSlotStorage(path, cache);
  f.save({ a: slot('p:1') });
  // Windows has no POSIX mode bits; the privacy check does not apply there.
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0);
  expect(new FileSlotStorage(path, new MemoryStorage()).load()).toEqual({ a: slot('p:1') });
  expect(cache.load()).toEqual({ a: slot('p:1') });
});

it('migrates from the host settings when there is no file, and writes the file', () => {
  const path = join(dir, 'mappings.json');
  const cache = new MemoryStorage();
  cache.save({ a: slot('p:1') });
  const log: string[] = [];
  expect(new FileSlotStorage(path, cache, (m) => log.push(m)).load()).toEqual({ a: slot('p:1') });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ v: 1 });
  expect(log[0]).toContain('migrated 1');
});

it('prefers the file over a stale host cache (the other host saved last)', () => {
  const path = join(dir, 'mappings.json');
  new FileSlotStorage(path, new MemoryStorage()).save({ new: slot('p:2') });
  const stale = new MemoryStorage();
  stale.save({ old: slot('p:1') });
  expect(Object.keys(new FileSlotStorage(path, stale).load())).toEqual(['new']);
});

it('falls back to the cache for a damaged file, a symlink or a file others can read', () => {
  const path = join(dir, 'mappings.json');
  const cache = new MemoryStorage();
  cache.save({ a: slot('p:1') });
  writeFileSync(path, '{not json', { mode: 0o600 });
  expect(Object.keys(new FileSlotStorage(path, cache).load())).toEqual(['a']);

  // Windows has no private-mode bits, and creating symlinks needs extra rights.
  if (process.platform === 'win32') return;

  const link = join(dir, 'link.json');
  writeFileSync(join(dir, 'real.json'), JSON.stringify({ v: 1, slots: { x: slot('p:9') } }), {
    mode: 0o600,
  });
  symlinkSync(join(dir, 'real.json'), link);
  expect(Object.keys(new FileSlotStorage(link, cache).load())).toEqual(['a']);

  const open = join(dir, 'open.json');
  writeFileSync(open, JSON.stringify({ v: 1, slots: { x: slot('p:9') } }), { mode: 0o644 });
  expect(Object.keys(new FileSlotStorage(open, cache).load())).toEqual(['a']);
});

it('a host switch keeps the mappings: new action contexts inherit by key position', () => {
  const path = join(dir, 'mappings.json');
  // Elgato app: contexts e1, e2
  const elgato = new MappingStore(new FileSlotStorage(path, new MemoryStorage()));
  elgato.set('e1', slot('p:1', 0));
  elgato.set('e2', slot('p:2', 1));
  // OpenDeck: other contexts at the same positions, empty host cache
  const open = new MappingStore(new FileSlotStorage(path, new MemoryStorage()));
  const live = new Set(['o1', 'o2']);
  expect(open.locate('o1', { device: 'D1', column: 0, row: 0 }, live)).toBe(true);
  expect(open.locate('o2', { device: 'D1', column: 1, row: 0 }, live)).toBe(true);
  expect(open.get('o1')?.pane?.paneKey).toBe('p:1');
  expect(open.get('o2')?.pane?.paneKey).toBe('p:2');
});
