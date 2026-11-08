import { describe, expect, it } from 'vitest';
import { MappingStore, type PaneBinding } from './mapping.ts';
import { Pairing, type PairingResult, type PairingState } from './pairing.ts';

const pane = (paneKey: string): PaneBinding => ({
  paneKey,
  worktreeId: 'w',
  tabId: 't',
  leafId: 'l',
  lastKnown: {},
});

function setup() {
  const mapping = new MappingStore();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const results: PairingResult[] = [];
  const states: PairingState[] = [];
  const p = new Pairing(mapping, {
    setTimer: (fn, ms) => timers.push({ fn, ms, live: true }) - 1,
    clearTimer: (t) => void (timers[t as number]!.live = false),
    onResult: (r) => results.push(r),
    onState: (s) => states.push(s),
  });
  const fire = () => timers.filter((t) => t.live).forEach((t) => t.fn());
  return { mapping, p, timers, results, states, fire };
}

describe('Pairing', () => {
  it('waits 15 s for a key, then binds the pressed slot as pinned', () => {
    const { mapping, p, timers, results } = setup();
    p.start('r1', pane('a:b'), true);
    expect(p.state.phase).toBe('waitingForKey');
    expect(timers[0]!.ms).toBe(15_000);
    expect(p.press('s1', 'tap')).toBe(true);
    expect(mapping.get('s1')).toMatchObject({ mode: 'pinned', pane: { paneKey: 'a:b' } });
    expect(results).toEqual([{ requestId: 'r1', ok: true, slot: 's1', action: 'mapped' }]);
    expect(p.state.phase).toBe('idle');
    expect(timers[0]!.live).toBe(false);
  });

  it('turns an auto slot into pinned and replaces a mapped one', () => {
    const { mapping, p } = setup();
    mapping.set('s1', { mode: 'auto', pane: pane('x:y') });
    p.start('r1', pane('a:b'), true);
    p.press('s1', 'tap');
    expect(mapping.get('s1')).toMatchObject({ mode: 'pinned', pane: { paneKey: 'a:b' } });
  });

  it('ignores presses outside pairing mode', () => {
    const { mapping, p } = setup();
    expect(p.press('s1', 'tap')).toBe(false);
    expect(mapping.get('s1')).toBeUndefined();
  });

  it('lists the slots already showing the pane', () => {
    const { mapping, p } = setup();
    mapping.set('s9', { mode: 'pinned', pane: pane('a:b') });
    p.start('r1', pane('a:b'), true);
    expect(p.state).toMatchObject({ existing: ['s9'] });
  });

  it('tap on a pane pinned elsewhere adds a copy', () => {
    const { mapping, p, results } = setup();
    mapping.set('s9', { mode: 'pinned', pane: pane('a:b') });
    p.start('r1', pane('a:b'), true);
    p.press('s1', 'tap');
    expect(mapping.slotsFor('a:b').sort()).toEqual(['s1', 's9']);
    expect(results[0]).toMatchObject({ ok: true, action: 'copied' });
  });

  it('hold on a pane pinned elsewhere moves it and frees the old slot to auto', () => {
    const { mapping, p, results } = setup();
    mapping.set('s9', { mode: 'pinned', pane: pane('a:b') });
    p.start('r1', pane('a:b'), true);
    p.press('s1', 'hold');
    expect(mapping.slotsFor('a:b')).toEqual(['s1']);
    expect(mapping.get('s9')).toMatchObject({ mode: 'auto' });
    expect(mapping.get('s9')?.pane).toBeUndefined();
    expect(results[0]).toMatchObject({ ok: true, action: 'moved' });
  });

  it('pressing the slot that already shows the pane is a plain map', () => {
    const { mapping, p, results } = setup();
    mapping.set('s1', { mode: 'pinned', pane: pane('a:b') });
    p.start('r1', pane('a:b'), true);
    p.press('s1', 'hold');
    expect(mapping.slotsFor('a:b')).toEqual(['s1']);
    expect(results[0]).toMatchObject({ ok: true, action: 'mapped' });
  });

  it('times out with reason timeout and leaves mappings alone', () => {
    const { mapping, p, results, fire } = setup();
    p.start('r1', pane('a:b'), true);
    fire();
    expect(results).toEqual([{ requestId: 'r1', ok: false, reason: 'timeout' }]);
    expect(p.state.phase).toBe('idle');
    expect(mapping.mappedCount()).toBe(0);
  });

  it('cancel reports cancelled; a cancel for another request is ignored', () => {
    const { p, results } = setup();
    p.start('r1', pane('a:b'), true);
    p.cancel('other');
    expect(p.state.phase).toBe('waitingForKey');
    p.cancel('r1');
    expect(results).toEqual([{ requestId: 'r1', ok: false, reason: 'cancelled' }]);
    p.cancel();
    expect(results).toHaveLength(1);
  });

  it('reports noFocusedPane and deckOffline without entering pairing mode', () => {
    const { p, results } = setup();
    p.start('r1', null, true);
    p.start('r2', pane('a:b'), false);
    expect(results).toEqual([
      { requestId: 'r1', ok: false, reason: 'noFocusedPane' },
      { requestId: 'r2', ok: false, reason: 'deckOffline' },
    ]);
    expect(p.state.phase).toBe('idle');
  });

  it('a new request cancels the pending one', () => {
    const { p, results, timers } = setup();
    p.start('r1', pane('a:b'), true);
    p.start('r2', pane('c:d'), true);
    expect(results).toEqual([{ requestId: 'r1', ok: false, reason: 'cancelled' }]);
    expect(timers[0]!.live).toBe(false);
    expect(p.state).toMatchObject({ requestId: 'r2' });
  });

  it('deckOffline while waiting ends the request', () => {
    const { p, results } = setup();
    p.start('r1', pane('a:b'), true);
    p.deckOffline();
    expect(results).toEqual([{ requestId: 'r1', ok: false, reason: 'deckOffline' }]);
  });
});
