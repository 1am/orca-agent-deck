// Runs inside `orca plugin test` (scripts/panel-test.ts stages it next to the real panel.jsx): the panel on Orca's
// own mount, with the worker's answers mocked.
import { assert, mockHost, mount, test } from 'orca/testing';
import * as panel from './panel.jsx';

const empty = (key) => ({ key, label: '', state: 'unmapped', mapped: false });
const deckOf = (cols, rows, extra = {}) => ({
  connected: true,
  model: '0',
  cols,
  rows,
  keys: Array.from({ length: cols * rows }, (_, i) => empty(i + 1)).map((k) =>
    k.key === 1 ? { key: 1, label: 'agent-deck/main', state: 'working', mapped: true } : k,
  ),
  panes: [
    {
      paneKey: 'p-focus',
      label: 'agent-deck / main',
      detail: 'Tab 1',
      agent: 'claude',
      state: 'working',
      remote: false,
      focused: true,
      onKey: 1,
    },
    {
      paneKey: 'p-build',
      label: 'orca / dev',
      detail: 'build-1 · Build',
      agent: null,
      state: 'idle',
      remote: true,
      focused: false,
    },
  ],
  ...extra,
});
const deck = deckOf(3, 2);

test('draws only key numbers, shaped like the deck, and names the model', async () => {
  for (const [model, cols, rows, name] of [
    ['1', 3, 2, 'Stream Deck Mini'],
    ['0', 5, 3, 'Stream Deck MK.2'],
    ['2', 8, 4, 'Stream Deck XL'],
  ]) {
    const host = mockHost({
      requests: { 'deck.get': () => ({ status: 'ok', deck: deckOf(cols, rows, { model }) }) },
    });
    const view = await mount(panel, { host });
    assert.ok(view.find({ text: `${name}, ${cols} x ${rows} keys` }));
    for (let n = 1; n <= cols * rows; n++) assert.ok(view.find({ text: String(n) }), `key ${n}`);
    assert.ok(!view.find({ text: '1 agent-deck/main' }));
    assert.ok(!view.find({ text: 'model 0' }));
    assert.deepEqual(view.errors, []);
    await view.unmount();
  }
});

test('a click on a key opens its picker; picking a pane assigns that pane and returns to the grid', async () => {
  const calls = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.assign': (input) => {
        calls.push(input);
        return { ok: true, slot: { page: 1, index: input.key }, action: 'mapped' };
      },
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '2' });
  assert.ok(view.find({ text: 'Key 2' }));
  assert.ok(view.find({ text: 'Empty' }));
  assert.ok(!view.find({ text: 'Unmap' }));
  assert.ok(view.find({ label: 'agent-deck / main' }));
  await view.press({ label: 'orca / dev' });
  assert.deepEqual(calls, [{ key: 2, replace: false, paneKey: 'p-build' }]);
  assert.ok(view.find({ text: 'Key 2 assigned.' }));
  assert.ok(!view.find({ role: 'heading', text: 'Key 2' }));
  assert.ok(view.find({ text: '6' }));
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('a mapped key offers Unmap and Back, and picking replaces what it shows', async () => {
  const calls = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.assign': (input) => (
        calls.push(['assign', input]),
        { ok: true, slot: { index: 1 }, action: 'moved' }
      ),
      'deck.unmap': (input) => (
        calls.push(['unmap', input]),
        { ok: true, slot: { index: 1 }, action: 'unmapped' }
      ),
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '1' });
  assert.ok(view.find({ text: 'Shows agent-deck/main' }));
  await view.press({ text: 'Back' });
  assert.ok(view.find({ text: '6' }));
  await view.press({ text: '1' });
  await view.press({ label: 'orca / dev' });
  assert.deepEqual(calls, [['assign', { key: 1, replace: true, paneKey: 'p-build' }]]);
  assert.ok(view.find({ text: 'Key 1 moved here (the pane was on another key).' }));
  await view.press({ text: '1' });
  await view.press({ text: 'Unmap' });
  assert.deepEqual(calls[1], ['unmap', { key: 1 }]);
  assert.ok(view.find({ text: 'Key 1 emptied.' }));
  await view.unmount();
});

test('a pane that was on another key moves: the pushed deck empties the old key', async () => {
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.assign': () => ({ ok: true, slot: { page: 1, index: 2 }, action: 'moved' }),
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '2' });
  await view.press({ label: 'agent-deck / main' });
  assert.ok(view.find({ text: 'Key 2 moved here (the pane was on another key).' }));
  const moved = deck.keys.map((k) =>
    k.key === 1
      ? empty(1)
      : k.key === 2
        ? { key: 2, label: 'agent-deck/main', state: 'working', mapped: true }
        : k,
  );
  await view.post('deck.changed', { status: 'ok', deck: { ...deck, keys: moved } });
  await view.press({ text: '1' });
  assert.ok(view.find({ text: 'Empty' }));
  await view.unmount();
});

test('says what is wrong instead of drawing a grid', async () => {
  for (const [status, text] of [
    ['update', 'Update the Stream Deck plugin: it is older than this one.'],
    ['offline', 'The Stream Deck plugin is not running.'],
  ]) {
    const view = await mount(panel, {
      host: mockHost({ requests: { 'deck.get': () => ({ status }) } }),
    });
    assert.ok(view.find({ text }));
    assert.ok(!view.find({ text: '1' }));
    await view.unmount();
  }
});

test('shows the reason of a refused pick', async () => {
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.assign': () => ({ ok: false, reason: 'noSuchPane' }),
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '3' });
  await view.press({ label: 'orca / dev' });
  assert.ok(view.find({ text: 'That pane is gone. Pick another one.' }));
  await view.unmount();
});
