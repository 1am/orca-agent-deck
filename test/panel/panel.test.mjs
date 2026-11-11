// Runs inside `orca plugin test` (scripts/panel-test.ts stages it next to the real panel.jsx): the panel on Orca's
// own mount, with the worker's answers mocked.
import { assert, mockHost, mount, test } from 'orca/testing';
import * as panel from './panel.jsx';

const deck = {
  connected: true,
  model: '0',
  cols: 3,
  rows: 2,
  keys: [
    { key: 1, label: 'agent-deck/main', state: 'working', mapped: true },
    { key: 2, label: '', state: 'unmapped', mapped: false },
    { key: 3, label: '', state: 'unmapped', mapped: false },
    { key: 4, label: '', state: 'unmapped', mapped: false },
    { key: 5, label: '', state: 'unmapped', mapped: false },
    { key: 6, label: '', state: 'unmapped', mapped: false },
  ],
};

test('draws the deck as a grid and assigns the focused pane on a click', async () => {
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
  assert.ok(view.find({ text: '1 agent-deck/main' }));
  await view.press({ text: '2 empty' });
  assert.deepEqual(calls, [{ key: 2, replace: false }]);
  assert.ok(view.find({ text: 'Key 2 assigned.' }));
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('a key that shows a pane asks before replacing and offers Unmap', async () => {
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
  await view.press({ text: '1 agent-deck/main' });
  assert.deepEqual(calls, []);
  await view.press({ text: 'Replace with the focused pane' });
  assert.deepEqual(calls, [['assign', { key: 1, replace: true }]]);
  await view.press({ text: '1 agent-deck/main' });
  await view.press({ text: 'Unmap' });
  assert.deepEqual(calls[1], ['unmap', { key: 1 }]);
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
  await view.press({ text: '2 empty' });
  assert.ok(view.find({ text: 'Key 2 moved here (the pane was on another key).' }));
  const moved = deck.keys.map((k) =>
    k.key === 1
      ? { ...k, label: '', state: 'unmapped', mapped: false }
      : k.key === 2
        ? { ...k, label: 'agent-deck/main', state: 'working', mapped: true }
        : k,
  );
  await view.post('deck.changed', { status: 'ok', deck: { ...deck, keys: moved } });
  assert.ok(view.find({ text: '1 empty' }));
  assert.ok(view.find({ text: '2 agent-deck/main' }));
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
    assert.ok(!view.find({ text: '1 agent-deck/main' }));
    await view.unmount();
  }
});

test('shows the reason of a refused click and a deck pushed by the worker', async () => {
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.assign': () => ({ ok: false, reason: 'noFocusedPane' }),
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '3 empty' });
  assert.ok(view.find({ text: 'No pane is focused in Orca. Click a terminal first.' }));
  await view.post('deck.changed', {
    status: 'ok',
    deck: {
      ...deck,
      keys: deck.keys.map((k) =>
        k.key === 3 ? { ...k, label: 'Build', state: 'completed', mapped: true } : k,
      ),
    },
  });
  assert.ok(view.find({ text: '3 Build' }));
  await view.unmount();
});
