// The Agent Deck sidebar panel: the connected deck as a grid of keys. A click puts the pane that is focused in
// Orca on a key; a key that shows a pane offers Replace and Unmap. Orca draws this tree with its own controls
// (ui: "components", no build step). The deck is plugin B's: this panel only asks plugin A (main.mjs) for its
// state (`deck.get`, and `deck.changed` pushes) and sends clicks (`deck.assign`, `deck.unmap`).
import { atom, Badge, Button, Heading, plugin, read, Row, set, Stack, Text } from 'orca';

/** `{ status: 'ok' | 'offline' | 'update', deck? }` as plugin A last answered; null until it does. */
const view = atom(null);
/** The key whose actions are open (a key that shows a pane), or null. */
const selected = atom(null);
/** The last result of a click, in words (also the last pairing result). */
const note = atom('');
const busy = atom(false);

const REASONS = {
  noFocusedPane: 'No pane is focused in Orca. Click a terminal first.',
  deckOffline: 'The Stream Deck is not connected.',
  noSuchKey: 'That key is not on the deck any more.',
  occupied: 'That key already shows a pane.',
  timeout: 'The Stream Deck plugin did not answer.',
  cancelled: 'Cancelled.',
  offline: 'The Stream Deck plugin is not running.',
  update: 'Update the Stream Deck plugin: it is older than this one.',
};
const DONE = {
  mapped: 'assigned',
  moved: 'moved here (the pane was on another key)',
  unmapped: 'emptied',
};

/** Key tone from the state the deck shows. */
const TONES = {
  working: 'accent',
  needs_input: 'warning',
  awaiting_reply: 'warning',
  error: 'danger',
  completed: 'success',
};

async function refresh() {
  set(view, await plugin.request('deck.get'));
}

async function act(name, input, key) {
  set(busy, true);
  try {
    const r = await plugin.request(name, input);
    set(
      note,
      r.ok
        ? `Key ${key} ${DONE[r.action] ?? 'assigned'}.`
        : (REASONS[r.reason] ?? `Not done (${r.reason}).`),
    );
    set(selected, null);
  } finally {
    set(busy, false);
  }
}

export function setup(ctx) {
  ctx.subscriptions.push(plugin.on('deck.changed', (payload) => set(view, payload)));
  void refresh();
}

function Status({ v }) {
  if (!v) return <Text muted>Asking the Stream Deck plugin...</Text>;
  if (v.status !== 'ok') return <Text tone="warning">{REASONS[v.status]}</Text>;
  const { deck } = v;
  if (!deck.connected) return <Text tone="warning">{REASONS.deckOffline}</Text>;
  return (
    <Row gap="xs" align="center">
      <Badge tone="success">Connected</Badge>
      <Text muted size="xs">
        {deck.cols} x {deck.rows} keys, model {deck.model}
      </Text>
    </Row>
  );
}

function Grid({ deck }) {
  const open = read(selected);
  const working = read(busy);
  const rows = [];
  for (let r = 0; r < deck.rows; r++)
    rows.push(deck.keys.filter((k) => Math.ceil(k.key / deck.cols) === r + 1));
  const press = (k) =>
    k.mapped
      ? set(selected, open === k.key ? null : k.key)
      : act('deck.assign', { key: k.key, replace: false }, k.key);
  return (
    <Stack gap="xs">
      {rows.map((keys, i) => (
        <Row key={i} gap="xs">
          {keys.map((k) => (
            <Button
              key={k.key}
              size="sm"
              variant={k.mapped ? 'solid' : 'outline'}
              tone={TONES[k.state] ?? 'neutral'}
              disabled={working}
              tooltip={
                k.mapped
                  ? `Key ${k.key}: ${k.label} (${k.state})`
                  : `Key ${k.key}: put the focused pane here`
              }
              onPress={() => press(k)}
            >
              {k.key} {k.mapped ? k.label : 'empty'}
            </Button>
          ))}
        </Row>
      ))}
    </Stack>
  );
}

function Actions({ deck }) {
  const key = read(selected);
  const working = read(busy);
  const k = deck.keys.find((x) => x.key === key);
  if (!k) return null;
  return (
    <Stack gap="xs">
      <Text size="xs">
        Key {k.key} shows {k.label}.
      </Text>
      <Row gap="xs">
        <Button
          size="sm"
          disabled={working}
          onPress={() => act('deck.assign', { key: k.key, replace: true }, k.key)}
        >
          Replace with the focused pane
        </Button>
        <Button
          size="sm"
          variant="outline"
          tone="danger"
          disabled={working}
          onPress={() => act('deck.unmap', { key: k.key }, k.key)}
        >
          Unmap
        </Button>
        <Button size="sm" variant="ghost" onPress={() => set(selected, null)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  );
}

export default function Panel() {
  const v = read(view);
  const last = read(note);
  const live = v && v.status === 'ok' && v.deck.connected;
  return (
    <Stack gap="md">
      <Heading>Agent Deck</Heading>
      <Status v={v} />
      {live ? <Grid deck={v.deck} /> : null}
      {live ? <Actions deck={v.deck} /> : null}
      {last ? <Text size="xs">{last}</Text> : null}
      <Button size="sm" variant="ghost" icon="refresh" onPress={() => refresh()}>
        Refresh
      </Button>
    </Stack>
  );
}
