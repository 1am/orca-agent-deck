import { describe, expect, it } from 'vitest';
import { MappingStore, MemoryStorage, type SlotSettings } from './mapping.ts';

const slot = (paneKey: string, mode: 'pinned' | 'auto' = 'pinned'): SlotSettings => ({
  mode,
  pane: { paneKey, worktreeId: 'w', tabId: 't', leafId: 'l', lastKnown: {} },
});

it('indexes one pane on several slots', () => {
  const s = new MappingStore();
  s.set('s1', slot('a:b'));
  s.set('s2', slot('a:b'));
  s.set('s3', slot('c:d'));
  expect(s.slotsFor('a:b').sort()).toEqual(['s1', 's2']);
  s.remove('s1');
  expect(s.slotsFor('a:b')).toEqual(['s2']);
});

it('keeps a pinned mapping 24 h after the pane vanishes, then clears it', () => {
  let t = 0;
  const s = new MappingStore(new MemoryStorage(), () => t);
  s.set('s1', slot('a:b'));
  t = 23 * 3600_000;
  expect(s.reconcile(new Set())).toEqual([]);
  t = 25 * 3600_000;
  expect(s.reconcile(new Set())).toEqual(['s1']);
  expect(s.get('s1')?.pane).toBeUndefined();
});

it('refreshes retention while the pane is alive', () => {
  let t = 0;
  const s = new MappingStore(new MemoryStorage(), () => t);
  s.set('s1', slot('a:b'));
  t = 20 * 3600_000;
  s.reconcile(new Set(['a:b']));
  t = 40 * 3600_000;
  expect(s.reconcile(new Set())).toEqual([]);
});

it('keeps an auto slot through a brief gap, frees it after the grace period', () => {
  let t = 0;
  const s = new MappingStore(new MemoryStorage(), () => t, undefined, 60_000);
  s.set('s1', slot('a:b', 'auto'));
  t = 30_000;
  expect(s.reconcile(new Set())).toEqual([]);
  // The pane comes back: the grace period starts over.
  s.reconcile(new Set(['a:b']));
  t = 80_000;
  expect(s.reconcile(new Set())).toEqual([]);
  t = 95_000;
  expect(s.reconcile(new Set())).toEqual(['s1']);
});

it('persists through the storage abstraction', () => {
  const st = new MemoryStorage();
  new MappingStore(st).set('s1', slot('a:b'));
  expect(new MappingStore(st).get('s1')?.pane?.paneKey).toBe('a:b');
});

describe('locate (mapping survives a changed action context)', () => {
  const binding = (paneKey: string) => ({
    paneKey,
    worktreeId: 'w',
    tabId: 't',
    leafId: 'l',
    lastKnown: {},
  });
  const pos = { device: 'D1', column: 1, row: 0 };

  it('moves the mapping to a new key at the same position', () => {
    const m = new MappingStore();
    m.locate('old', pos, new Set());
    m.set('old', { mode: 'pinned', pane: binding('p1') });
    expect(m.locate('new', pos, new Set(['new']))).toBe(true);
    expect(m.get('new')?.pane?.paneKey).toBe('p1');
    expect(m.get('new')?.mode).toBe('pinned');
    expect(m.get('old')).toBeUndefined();
  });

  it('keeps settings of a known key and never takes from a live key', () => {
    const m = new MappingStore();
    m.locate('a', pos, new Set());
    m.set('a', { mode: 'pinned', pane: binding('p1') });
    expect(m.locate('b', pos, new Set(['a', 'b']))).toBe(false);
    expect(m.get('a')?.pane?.paneKey).toBe('p1');
    m.set('b', { mode: 'pinned', pane: binding('p2') });
    expect(m.locate('b', pos, new Set())).toBe(false);
    expect(m.get('b')?.pane?.paneKey).toBe('p2');
  });

  it('carries the mapping over when the other host names the device differently', () => {
    const m = new MappingStore();
    m.locate('old', pos, new Set());
    m.set('old', { mode: 'pinned', pane: binding('p1') });
    const other = { ...pos, device: 'sd-ABC' };
    expect(m.locate('new', other, new Set(['new']))).toBe(true);
    expect(m.get('new')?.pane?.paneKey).toBe('p1');
    expect(m.get('new')?.pos).toEqual(other);
    expect(m.get('old')).toBeUndefined();
  });

  it('prefers the exact device match over a key of another device', () => {
    const m = new MappingStore();
    for (const [k, device, p] of [
      ['same', 'D1', 'p-same'],
      ['other', 'D2', 'p-other'],
    ] as const) {
      m.locate(k, { ...pos, device }, new Set(['same', 'other']));
      m.set(k, { mode: 'pinned', pane: binding(p) });
    }
    expect(m.locate('new', pos, new Set(['new']))).toBe(true);
    expect(m.get('new')?.pane?.paneKey).toBe('p-same');
    expect(m.get('other')?.pane?.paneKey).toBe('p-other');
  });

  it('never takes from a device that still has live keys', () => {
    const m = new MappingStore();
    m.locate('gone', { ...pos, device: 'D2' }, new Set());
    m.set('gone', { mode: 'pinned', pane: binding('p2') });
    m.locate('here', { device: 'D2', column: 0, row: 0 }, new Set());
    expect(m.locate('new', pos, new Set(['new', 'here']))).toBe(false);
    expect(m.get('new')?.pane).toBeUndefined();
  });

  it('does not give a deck that went away to a new key on another live deck', () => {
    // Stream Deck Mobile maps (1,0), disconnects; a fresh key at the same position of the hardware deck must not adopt it.
    const m = new MappingStore();
    const mobile = { ...pos, device: 'MOBILE' };
    m.locate('m1', mobile, new Set());
    m.set('m1', { mode: 'pinned', pane: binding('p-mobile') });
    const seen = new Set(['MOBILE']); // it was live earlier in this run
    expect(m.locate('hw1', pos, new Set(['hw1']), seen)).toBe(false);
    expect(m.get('hw1')?.pane).toBeUndefined();
    expect(m.get('m1')?.pane?.paneKey).toBe('p-mobile');
  });

  it('still carries a mapping across a host switch, where the old device was never live in this run', () => {
    const m = new MappingStore();
    m.locate('old', pos, new Set());
    m.set('old', { mode: 'pinned', pane: binding('p1') });
    expect(m.locate('new', { ...pos, device: 'sd-ABC' }, new Set(['new']), new Set())).toBe(true);
  });

  it('does not inherit when another live deck has a key at that position', () => {
    const m = new MappingStore();
    m.locate('gone', { ...pos, device: 'D2' }, new Set());
    m.set('gone', { mode: 'pinned', pane: binding('p2') });
    m.locate('third', { ...pos, device: 'D3' }, new Set());
    expect(m.locate('new', { ...pos, device: 'D1' }, new Set(['new', 'third']))).toBe(false);
    expect(m.get('new')?.pane).toBeUndefined();
  });

  it('does not guess when two vanished keys share the position on different devices', () => {
    const m = new MappingStore();
    for (const [k, device] of [
      ['x', 'D2'],
      ['y', 'D3'],
    ] as const) {
      m.locate(k, { ...pos, device }, new Set(['x', 'y']));
      m.set(k, { mode: 'pinned', pane: binding(`p-${k}`) });
    }
    expect(m.locate('new', pos, new Set(['new']))).toBe(false);
    expect(m.get('new')?.pane).toBeUndefined();
  });

  it('does not guess when two vanished keys share the position', () => {
    const m = new MappingStore();
    for (const k of ['x', 'y']) {
      m.locate(k, pos, new Set(['x', 'y']));
      m.set(k, { mode: 'pinned', pane: binding(`p-${k}`) });
    }
    expect(m.locate('new', pos, new Set())).toBe(false);
    expect(m.get('new')?.pane).toBeUndefined();
  });
});

describe('a pane is on one key only', () => {
  const binding = (paneKey: string) => ({
    paneKey,
    worktreeId: 'w',
    tabId: 't',
    leafId: 'l',
    lastKnown: {},
  });

  it('loading a file with a pane on two keys keeps the most recently assigned', () => {
    const st = new MemoryStorage();
    st.save({
      key1: { mode: 'pinned', pane: binding('p1'), assignedAt: 100 },
      key8: { mode: 'pinned', pane: binding('p1'), assignedAt: 200 },
      key3: { mode: 'pinned', pane: binding('p2'), assignedAt: 50 },
    });
    const m = new MappingStore(st);
    expect(m.slotsFor('p1')).toEqual(['key8']);
    expect(m.get('key3')?.pane?.paneKey).toBe('p2');
    expect(m.dedupedOnLoad).toEqual([{ paneKey: 'p1', kept: 'key8', removed: ['key1'] }]);
    // Cleaned on disk too, so the next load has nothing to report.
    expect(new MappingStore(st).dedupedOnLoad).toEqual([]);
  });

  it('a file from before assignedAt keeps the later key of the file', () => {
    const st = new MemoryStorage();
    st.save({
      a: { mode: 'pinned', pane: binding('p1') },
      b: { mode: 'pinned', pane: binding('p1') },
    });
    expect(new MappingStore(st).slotsFor('p1')).toEqual(['b']);
  });

  it('assignedAt is set on assignment and kept while the same pane stays', () => {
    let t = 10;
    const m = new MappingStore(new MemoryStorage(), () => t);
    m.set('s', { mode: 'pinned', pane: binding('p1') });
    t = 99;
    m.set('s', { ...m.get('s')!, mode: 'pinned' });
    expect(m.get('s')?.assignedAt).toBe(10);
    m.set('s', { mode: 'pinned', pane: binding('p2') });
    expect(m.get('s')?.assignedAt).toBe(99);
  });
});
