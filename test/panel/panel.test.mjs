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
      hostId: 'ssh:build-1',
      label: 'orca / dev',
      detail: 'Build',
      host: 'build-1',
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
    ['0', 5, 3, 'Stream Deck (MK.2)'],
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

test('the grid stays; a click on a key shows its details under it, and the details stay after a pick', async () => {
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
  assert.ok(!view.find({ text: 'Key 2' }));
  await view.press({ text: '2' });
  assert.ok(view.find({ text: 'Key 2' }));
  assert.ok(view.find({ text: 'Empty' }));
  assert.ok(!view.find({ text: 'Unmap' }));
  assert.ok(view.find({ text: '6' }));
  assert.ok(view.find({ label: 'agent-deck / main' }));
  await view.press({ label: 'orca / dev' });
  assert.deepEqual(calls, [{ key: 2, replace: false, paneKey: 'p-build', hostId: 'ssh:build-1' }]);
  assert.ok(view.find({ text: 'Key 2 assigned.' }));
  assert.ok(view.find({ text: 'Key 2' }), 'the details stay');
  assert.ok(view.find({ text: '6' }));
  await view.press({ text: 'Use the focused pane' });
  assert.deepEqual(calls[1], { key: 2, replace: false });
  assert.ok(view.find({ text: 'Key 2' }));
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('the details follow the pushed deck, switch with another key and close with Back or the same key', async () => {
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.unmap': () => ({ ok: true, slot: { index: 1 }, action: 'unmapped' }),
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '1' });
  assert.ok(view.find({ text: 'Shows agent-deck/main' }));
  await view.press({ text: 'Unmap' });
  assert.ok(view.find({ text: 'Key 1 emptied.' }));
  assert.ok(view.find({ text: 'Shows agent-deck/main' }), 'until the deck pushes the change');
  await view.post('deck.changed', {
    status: 'ok',
    deck: { ...deck, keys: deck.keys.map((k) => (k.key === 1 ? empty(1) : k)) },
  });
  assert.ok(view.find({ text: 'Empty' }));
  assert.ok(!view.find({ text: 'Unmap' }));
  await view.press({ text: '3' });
  assert.ok(view.find({ text: 'Key 3' }));
  assert.ok(!view.find({ text: 'Key 1 emptied.' }));
  await view.press({ text: '3' });
  assert.ok(!view.find({ text: 'Key 3' }));
  await view.press({ text: '4' });
  await view.press({ text: 'Back' });
  assert.ok(!view.find({ text: 'Key 4' }));
  assert.ok(view.find({ text: '6' }));
  await view.unmount();
});

test('picking replaces what a mapped key shows and a pane on another key moves', async () => {
  const calls = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.assign': (input) => (
        calls.push(input),
        { ok: true, slot: { index: 2 }, action: 'moved' }
      ),
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '1' });
  await view.press({ label: 'orca / dev' });
  assert.deepEqual(calls, [{ key: 1, replace: true, paneKey: 'p-build', hostId: 'ssh:build-1' }]);
  assert.ok(view.find({ text: 'Key 1 moved here (the pane was on another key).' }));
  await view.unmount();
});

test('says to update the Stream Deck plugin when it sends no pane list, and still offers the focused pane', async () => {
  const old = { ...deck };
  delete old.panes;
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck: old }) } }),
  });
  await view.press({ text: '2' });
  assert.ok(
    view.find({
      text: 'The pane list needs a newer Stream Deck plugin: update it to choose any pane.',
    }),
  );
  assert.ok(!view.find({ text: 'Orca lists no terminal panes.' }));
  assert.ok(view.find({ text: 'Use the focused pane' }));
  await view.unmount();
  const none = await mount(panel, {
    host: mockHost({
      requests: { 'deck.get': () => ({ status: 'ok', deck: { ...deck, panes: [] } }) },
    }),
  });
  await none.press({ text: '2' });
  assert.ok(none.find({ text: 'Orca lists no terminal panes.' }));
  await none.unmount();
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

test('opened to map: names the focused pane, an empty key assigns it at once, a mapped key opens its details', async () => {
  const calls = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck, mapping: true }),
      'deck.assign': (input) => (
        calls.push(input),
        { ok: true, slot: { index: input.key }, action: 'mapped' }
      ),
    },
  });
  const view = await mount(panel, { host });
  assert.ok(view.find({ text: 'Mapping' }));
  assert.ok(view.find({ text: 'Map agent-deck / main to a key' }));
  assert.ok(view.find({ text: 'Click an empty key below, or press a key on the deck.' }));
  await view.press({ text: '1' });
  assert.deepEqual(calls, [], 'a key that shows a pane only opens its details');
  assert.ok(view.find({ text: 'Key 1' }));
  await view.press({ text: 'Back' });
  await view.press({ text: '4' });
  assert.deepEqual(calls, [{ key: 4, replace: false, paneKey: 'p-focus' }]);
  assert.ok(view.find({ text: 'Key 4 assigned.' }));
  assert.ok(!view.find({ text: 'Mapping' }), 'map mode ends with the assignment');
  await view.press({ text: '5' });
  assert.ok(view.find({ text: 'Key 5' }), 'a click now only picks the key');
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('map mode starts from a push of the worker and ends with Cancel', async () => {
  const requests = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.mapEnd': () => (requests.push('deck.mapEnd'), { ok: true }),
    },
  });
  const view = await mount(panel, { host });
  assert.ok(!view.find({ text: 'Mapping' }));
  await view.post('map.changed', { mapping: true });
  assert.ok(view.find({ text: 'Map agent-deck / main to a key' }));
  await view.press({ text: 'Cancel' });
  assert.ok(!view.find({ text: 'Mapping' }));
  assert.deepEqual(requests, ['deck.mapEnd']);
  await view.unmount();
});

test('map mode without a focused pane says so and assigns nothing', async () => {
  const calls = [];
  const none = { ...deck, panes: deck.panes.map((p) => ({ ...p, focused: false })) };
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck: none, mapping: true }),
      'deck.assign': (input) => (calls.push(input), { ok: true, slot: { index: 1 } }),
    },
  });
  const view = await mount(panel, { host });
  assert.ok(
    view.find({
      text: 'No pane is focused in Orca. Click a terminal first, or pick the pane in the list (Orca reports no focus on a paired server).',
    }),
  );
  await view.press({ text: '4' });
  assert.deepEqual(calls, []);
  assert.ok(view.find({ text: 'Key 4' }));
  await view.unmount();
});

test('shows a reason when the worker does not answer a click', async () => {
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.assign': () => {
        throw new Error('worker stopped');
      },
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '3' });
  await view.press({ label: 'orca / dev' });
  assert.ok(view.find({ text: 'The Orca plugin did not answer (worker stopped). Try Refresh.' }));
  await view.unmount();
});

test('the pane line puts the title first and the host last', async () => {
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck }) } }),
  });
  await view.press({ text: '2' });
  const line = (label) => view.find({ label })?.props.description;
  assert.equal(line('agent-deck / main'), 'Tab 1 · claude · Focused · on key 1');
  assert.equal(line('orca / dev'), 'Build · build-1');
  await view.unmount();
});

test('map mode lists the panes with the focused one chosen; another choice is what an empty key gets', async () => {
  const calls = [];
  const requests = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck, mapping: true }),
      'deck.mapChoose': () => (requests.push('deck.mapChoose'), { ok: true }),
      'deck.assign': (input) => (
        calls.push(input),
        { ok: true, slot: { index: input.key }, action: 'mapped' }
      ),
    },
  });
  const view = await mount(panel, { host });
  const current = () => view.findAll({ type: 'ListItem' }).filter((e) => e.props.current);
  assert.deepEqual(
    current().map((e) => e.label),
    ['agent-deck / main'],
    'the list shows without a key chosen, the focused pane marked',
  );
  assert.ok(view.find({ text: 'Click an empty key below, or press a key on the deck.' }));
  await view.press({ label: 'orca / dev' });
  assert.deepEqual(requests, ['deck.mapChoose'], "the deck's Assign-here ends");
  assert.ok(view.find({ text: 'Map orca / dev to a key' }));
  assert.deepEqual(
    current().map((e) => e.label),
    ['orca / dev'],
  );
  assert.ok(view.find({ text: 'Click an empty key below.' }));
  await view.press({ text: '4' });
  assert.deepEqual(calls, [{ key: 4, replace: false, paneKey: 'p-build', hostId: 'ssh:build-1' }]);
  assert.ok(!view.find({ text: 'Mapping' }));
  assert.deepEqual(view.errors, []);
  await view.unmount();
});
