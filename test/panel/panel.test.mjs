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
    assert.ok(view.find({ text: name }));
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
  assert.ok(view.find({ text: 'agent-deck/main' }));
  await view.press({ text: 'Unmap' });
  assert.ok(view.find({ text: 'Key 1 emptied.' }));
  assert.ok(view.find({ text: 'agent-deck/main' }), 'until the deck pushes the change');
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

test('a row says its name, the agent and the marks; the host is in the group header', async () => {
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck }) } }),
  });
  await view.press({ text: '2' });
  const line = (label) => view.find({ label })?.props.description;
  assert.equal(line('agent-deck / main'), 'Tab 1 · claude · Focused');
  assert.equal(line('orca / dev'), 'Build');
  await view.unmount();
});

test('the search matches the whole line: key, marks, host name and address', async () => {
  const withMore = deckOf(3, 2, {
    panes: [
      { ...deck.panes[0], onKey: 7, detail: 'tmp' },
      { ...deck.panes[1], host: 'RemoteLaptop', hostAddress: '192.168.1.12', onKey: 2 },
    ],
  });
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck: withMore }) } }),
  });
  const shown = () => view.findAll({ type: 'ListItem' }).map((e) => e.label);
  await view.press({ text: '3' });
  const search = async (q) => {
    await view.type({ label: 'Search panes' }, q, { replace: true });
    return shown();
  };
  assert.deepEqual(await search('key 7'), ['agent-deck / main'], 'the mark "on key 7"');
  assert.deepEqual(await search('focused'), ['agent-deck / main'], 'the Focused mark');
  assert.deepEqual(await search('remotelaptop'), ['orca / dev'], 'the host name');
  assert.deepEqual(await search('192.168'), ['orca / dev'], 'the host address');
  assert.deepEqual(await search('claude tmp'), ['agent-deck / main'], 'agent and tab');
  assert.deepEqual(await search('KEY 2 REMOTE'), ['orca / dev'], 'every word, any case');
  assert.deepEqual(await search('key 9'), []);
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('the search narrows the pane list by title, tab, agent or host', async () => {
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck }) } }),
  });
  const shown = () => view.findAll({ type: 'ListItem' }).map((e) => e.label);
  await view.press({ text: '2' });
  assert.deepEqual(shown(), ['agent-deck / main', 'orca / dev']);
  await view.type({ label: 'Search panes' }, 'BUILD-1');
  assert.deepEqual(shown(), ['orca / dev'], 'by host, any case');
  await view.type({ label: 'Search panes' }, 'claude tab', { replace: true });
  assert.deepEqual(shown(), ['agent-deck / main'], 'every word, by agent and tab');
  await view.type({ label: 'Search panes' }, 'nothing', { replace: true });
  assert.deepEqual(shown(), []);
  assert.ok(view.find({ text: 'No pane matches "nothing".' }));
  // A key's details start with the whole list.
  await view.press({ text: '3' });
  assert.deepEqual(shown(), ['agent-deck / main', 'orca / dev']);
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('deck taps open a key here only while the panel is in view with a key open', async () => {
  const selects = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck: deckOf(3, 2, { panes: [] }) }),
      'deck.panelSelect': (input) => (selects.push(input.on), { ok: true }),
    },
  });
  const view = await mount(panel, { host });
  await view.settled();
  assert.deepEqual(selects, [false], 'no key open: deck taps focus as usual');
  await view.post('deck.keyPicked', { key: 5 });
  await view.settled();
  assert.deepEqual(selects, [false, true]);
  assert.ok(view.find({ text: 'Key 5' }), "the tapped key's details open");
  await view.setVisible(false);
  await view.settled();
  assert.deepEqual(selects, [false, true, false], 'hidden: deck taps focus again');
  await view.setVisible(true);
  await view.press({ text: 'Back' });
  assert.equal(selects.at(-1), false, 'Back: off at once, before any redraw settles');
  await view.settled();
  assert.equal(selects.at(-1), false, 'no key open');
  await view.unmount();
  assert.equal(selects.at(-1), false);
  assert.deepEqual(view.errors, []);
});

test('a panel that stays in view renews its panelSelect so B keeps it; a hide stops the renewals', async () => {
  const selects = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.panelSelect': (input) => (selects.push(input.on), { ok: true }),
    },
  });
  const view = await mount(panel, { host });
  await view.post('deck.keyPicked', { key: 5 });
  await view.settled();
  assert.deepEqual(selects, [true]);
  await new Promise((r) => globalThis.setTimeout(r, 1300));
  await view.settled();
  assert.deepEqual(selects, [true, true], 'renewed every second while in view');
  await view.setVisible(false);
  await new Promise((r) => globalThis.setTimeout(r, 700));
  await view.settled();
  assert.deepEqual(selects, [true, true, false], 'hidden: off within a second');
  await new Promise((r) => globalThis.setTimeout(r, 1300));
  await view.settled();
  assert.deepEqual(selects, [true, true, false], 'and no renewals after');
  await view.unmount();
  assert.deepEqual(view.errors, []);
});

test('opened for the focused pane: its key opens, else the bare grid; there is no map mode', async () => {
  const noKey = deck;
  let current = noKey;
  const host = mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck: current }) } });
  const view = await mount(panel, { host });
  await view.settled();
  assert.ok(!view.find({ text: 'Key 1' }), 'the focused pane is on no key: nothing selected');
  for (const gone of ['Mapping', 'Cancel']) assert.ok(!view.find({ text: gone }));
  current = { ...deck, panes: deck.panes.map((p) => (p.focused ? { ...p, onKey: 1 } : p)) };
  await view.post('panel.opened', {});
  await view.settled();
  assert.ok(view.find({ text: 'Key 1' }), "the focused pane's key opens");
  assert.ok(view.find({ text: 'agent-deck/main' }));
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('Use the focused pane is disabled with the reason when nothing is focused; the list puts the focused pane first', async () => {
  const none = { ...deck, panes: deck.panes.map((p) => ({ ...p, focused: false })) };
  const host = mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck: none }) } });
  const view = await mount(panel, { host });
  await view.press({ text: '4' });
  const button = view.find({ text: 'Use the focused pane' });
  assert.ok(button.props.disabled);
  assert.ok(view.find({ text: /^No pane is focused in Orca/ }));
  await view.unmount();

  const view2 = await mount(panel, {
    host: mockHost({
      requests: {
        'deck.get': () => ({
          status: 'ok',
          deck: { ...deck, panes: [...deck.panes].reverse(), keys: deck.keys },
        }),
      },
    }),
  });
  await view2.press({ text: '2' });
  assert.deepEqual(
    view2.findAll({ type: 'ListItem' }).map((e) => e.label),
    ['agent-deck / main', 'orca / dev'],
    'the focused pane is first',
  );
  await view2.unmount();
});

test('a key B asked for while the panel was not mounted opens when it mounts, ahead of the focused pane', async () => {
  const host = mockHost({
    requests: { 'deck.get': () => ({ status: 'ok', deck: { ...deck }, picked: 3 }) },
  });
  const view = await mount(panel, { host });
  await view.settled();
  assert.ok(view.find({ text: 'Key 3' }));
  await view.unmount();
});

const layoutOf = (cols, rows, special = {}) =>
  Array.from({ length: cols * rows }, (_, i) => ({ key: i + 1, kind: special[i + 1] ?? 'pane' }));

test('draws every position of the deck: Pane keys press, the others are greyed with what they are', async () => {
  const mk2 = deckOf(5, 3, {
    layout: layoutOf(5, 3, { 11: 'status', 12: 'attention', 13: 'other' }),
  });
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck: mk2 }) } }),
  });
  await view.settled();
  const buttons = view
    .findAll({ type: 'Button' })
    .filter((b) => /^\d+$/.test(String(b.text ?? b.label)));
  assert.equal(buttons.length, 15, 'all 15 positions of the MK.2');
  const at = (n) => buttons.find((b) => String(b.text ?? b.label) === String(n));
  assert.ok(!at(5).props.disabled, 'a Pane key presses');
  assert.equal(at(5).props.variant, 'outline', 'empty: outlined');
  assert.equal(at(1).props.variant, 'solid', 'mapped: filled');
  assert.equal(at(1).props.tone, 'accent', "in its state's colour");
  assert.ok(at(11).props.disabled && at(11).props.variant === 'ghost');
  assert.equal(at(11).props.tooltip, 'Key 11: the Agent Deck status key');
  assert.equal(at(12).props.tooltip, 'Key 12: the Agent Deck attention key');
  assert.equal(at(13).props.tooltip, 'Key 13: not an Agent Deck key');
  await view.unmount();

  const xl = deckOf(8, 4, { layout: layoutOf(8, 4, { 32: 'status' }) });
  const wide = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck: xl }) } }),
  });
  await wide.settled();
  assert.equal(
    wide.findAll({ type: 'Button' }).filter((b) => /^\d+$/.test(String(b.text ?? b.label))).length,
    32,
  );
  const cells = wide.findAll({ type: 'Box' }).filter((b) => b.props.grow && b.props.radius);
  assert.equal(cells.length, 32, 'equal cells that share the width');
  assert.ok(
    cells.every((b) => b.props.width === 0),
    'the same basis, so the same size',
  );
  await wide.unmount();
});

test('a Stream Deck plugin without layout draws the Pane keys it lists', async () => {
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck }) } }),
  });
  await view.settled();
  const n = view
    .findAll({ type: 'Button' })
    .filter((b) => /^\d+$/.test(String(b.text ?? b.label))).length;
  assert.equal(n, deck.keys.length);
  await view.unmount();
});

test('the details header is one line, Unmap and Use the focused pane share a row, a long list says it scrolls, the header is one line', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    ...deck.panes[1],
    paneKey: `p-${i}`,
    label: `pane ${i}`,
    focused: false,
  }));
  const view = await mount(panel, {
    host: mockHost({
      requests: { 'deck.get': () => ({ status: 'ok', deck: { ...deck, panes: many } }) },
    }),
  });
  await view.press({ text: '1' });
  assert.ok(view.find({ text: 'Key 1' }));
  const name = view.find({ text: 'agent-deck/main' });
  assert.ok(name.props.truncate, 'the name is cut off with an ellipsis');
  assert.ok(!view.find({ text: /^Shows / }), 'no "Shows" prefix');
  const unmap = view.find({ text: 'Unmap' });
  const use = view.find({ text: 'Use the focused pane' });
  assert.ok(unmap && use);
  assert.ok(view.find({ text: '9 panes: scroll the list for more' }));
  assert.ok(
    view.find({ text: 'Stream Deck (MK.2)' }),
    'only the device name, so a narrow sidebar does not cut it',
  );
  assert.ok(!view.find({ text: 'Connected' }), 'no Connected pill');
  // The list box, read off the drawn tree: growing into the sidebar down to a floor, no fixed maximum.
  const boxes = [];
  const walk = (n) => {
    if (n?.type === 'Box' && n.props?.minHeight !== undefined) boxes.push(n.props);
    for (const c of n?.children ?? []) walk(c);
  };
  walk(typeof view.tree === 'function' ? view.tree() : view.tree);
  assert.deepEqual(
    boxes.filter((b) => b.scroll),
    [{ grow: true, scroll: 'y', minHeight: 120 }],
  );
  assert.ok(
    boxes.filter((b) => !b.scroll).every((b) => b.minHeight === 0),
    'the boxes around the list can shrink, so only the list scrolls',
  );
  await view.unmount();
});

test('the scroll hint is dropped when every row fits the minimum list box', async () => {
  const few = Array.from({ length: 8 }, (_, i) => ({
    ...deck.panes[1],
    paneKey: `p-${i}`,
    label: `pane ${i}`,
    focused: false,
  }));
  const view = await mount(panel, {
    host: mockHost({
      requests: { 'deck.get': () => ({ status: 'ok', deck: { ...deck, panes: few } }) },
    }),
  });
  await view.press({ text: '1' });
  assert.ok(!view.find({ text: /scroll the list for more/ }));
  await view.unmount();
});

test('a pushed offline replaces the grid and closes the open key, the next deck brings the grid back', async () => {
  const host = mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck }) } });
  const view = await mount(panel, { host });
  await view.press({ text: '1' });
  assert.ok(view.find({ text: 'Key 1' }));
  await view.post('deck.changed', { status: 'offline' });
  assert.ok(view.find({ text: 'The Stream Deck plugin is not running.' }));
  assert.ok(!view.find({ text: 'Key 1' }));
  assert.ok(!view.find({ text: '2' }), 'no grid');
  await view.post('deck.changed', { status: 'ok', deck });
  assert.ok(view.find({ text: '2' }), 'the grid is back without a click');
  assert.ok(!view.find({ text: 'Key 1' }), 'the key stays closed');
  await view.unmount();
});

test('a panel in view reports it so the worker can hide the sidebar; hidden or unmounted: off', async () => {
  const views = [];
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.panelView': (input) => (views.push(input.on), { ok: true }),
    },
  });
  const view = await mount(panel, { host });
  await view.settled();
  assert.equal(views.at(-1), true, 'in view on mount');
  await view.setVisible(false);
  await new Promise((r) => globalThis.setTimeout(r, 700));
  await view.settled();
  assert.equal(views.at(-1), false, 'hidden: reported off within a second');
  await view.unmount();
  assert.equal(views.at(-1), false);
  assert.deepEqual(view.errors, []);
});

test('the list is grouped host > repo > branch like the key settings, each row has a key badge', async () => {
  const pane = (paneKey, over) => ({
    paneKey,
    hostId: 'local',
    label: 'x',
    detail: '',
    repo: 'agent-deck',
    branch: 'main',
    tab: 'Tab 1',
    name: `pane ${paneKey}`,
    agent: 'claude',
    state: 'idle',
    remote: false,
    focused: false,
    ...over,
  });
  const grouped = deckOf(3, 2, {
    panes: [
      pane('a'),
      pane('b', { branch: 'dev', onKey: 7 }),
      pane('c', { hostId: 'ssh:l', remote: true, host: 'RemoteLaptop', onKey: 2 }),
      pane('d', { focused: true, branch: 'dev' }),
    ],
  });
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck: grouped }) } }),
  });
  await view.press({ text: '2' });
  const headers = () =>
    view
      .findAll({ type: 'Text' })
      .map((t) => t.text)
      .filter((t) => / > /.test(String(t)));
  assert.deepEqual(headers(), [
    'This machine > agent-deck > dev',
    'This machine > agent-deck > main',
    'Remote: RemoteLaptop > agent-deck > main',
  ]);
  const order = () => view.findAll({ type: 'ListItem' }).map((e) => e.label);
  assert.deepEqual(order().slice(0, 2), ['pane d', 'pane b'], 'the focused pane leads its group');
  assert.ok(view.find({ text: '7' }), 'key badge of a mapped pane');
  const badge = (n) =>
    view.findAll({ type: 'Button' }).find((b) => String(b.text ?? b.label) === String(n));
  assert.equal(badge(7).props.variant, 'solid', 'a badge is a small grid key, filled');
  assert.equal(badge(7).props.size, 'xs');
  const tree = JSON.stringify(view.tree());
  assert.ok(
    tree.includes('"border":"accent"'),
    'the key being edited is ringed like a selected key',
  );
  assert.equal(
    (tree.match(/"height":28/g) ?? []).length,
    2,
    'the two free panes are empty squares',
  );
  assert.ok(!view.find({ text: /on key/ }), 'no "on key N" text');
  await view.type({ label: 'Search panes' }, 'remotelaptop', { replace: true });
  assert.deepEqual(headers(), ['Remote: RemoteLaptop > agent-deck > main'], 'empty groups go');
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('switching keys and closing: the old result line goes, the same key again and Back close', async () => {
  const host = mockHost({
    requests: {
      'deck.get': () => ({ status: 'ok', deck }),
      'deck.assign': () => ({ ok: true, slot: { page: 1, index: 2 }, action: 'mapped' }),
    },
  });
  const view = await mount(panel, { host });
  await view.press({ text: '2' });
  await view.press({ label: 'orca / dev' });
  assert.ok(view.find({ text: 'Key 2 assigned.' }), 'the result line shows');
  await view.press({ text: '3' });
  assert.ok(view.find({ text: 'Key 3' }) && !view.find({ text: 'Key 2' }), 'key 3 is open');
  assert.ok(!view.find({ text: 'Key 2 assigned.' }), 'the old result line is gone');
  await view.press({ text: '3' });
  assert.ok(!view.find({ text: 'Key 3' }), 'the same key again closes');
  await view.press({ text: '2' });
  await view.press({ label: 'orca / dev' });
  assert.ok(view.find({ text: 'Key 2 assigned.' }));
  await view.press({ text: 'Back' });
  assert.ok(!view.find({ text: 'Key 2' }), 'Back closes');
  assert.ok(!view.find({ text: 'Key 2 assigned.' }), 'and the result line goes with it');
  assert.deepEqual(view.errors, []);
  await view.unmount();
});

test('Use the focused pane: a paired-server pane shown (only "last opened from the deck") is not a focus', async () => {
  const paired = {
    ...deck,
    panes: [
      { ...deck.panes[1], hostId: 'env:srv', focused: false, lastPressed: true },
      { ...deck.panes[0], focused: false },
    ],
  };
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck: paired }) } }),
  });
  await view.press({ text: '4' });
  assert.ok(view.find({ text: 'Use the focused pane' }).props.disabled);
  assert.ok(view.find({ text: /^No pane is focused in Orca/ }), 'with the one-line reason');
  await view.unmount();

  const local = await mount(panel, {
    host: mockHost({ requests: { 'deck.get': () => ({ status: 'ok', deck }) } }),
  });
  await local.press({ text: '4' });
  assert.ok(
    !local.find({ text: 'Use the focused pane' }).props.disabled,
    'a local focus enables it',
  );
  assert.ok(!local.find({ text: /^No pane is focused in Orca/ }));
  await local.unmount();
});
