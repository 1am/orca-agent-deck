// The Agent Deck sidebar panel: the connected deck as a grid of numbered keys, shaped like the deck. A click on a
// key opens a picker for that key (like the key settings in the Stream Deck app): the panes Orca lists, Unmap and
// Back. Orca draws this tree with its own controls (ui: "components", no build step). The deck is plugin B's:
// this panel only asks plugin A (main.mjs) for its state (`deck.get`, and `deck.changed` pushes) and sends
// choices (`deck.assign`, `deck.unmap`).
import {
  atom,
  Badge,
  Button,
  Heading,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
} from 'orca';

/** `{ status: 'ok' | 'offline' | 'update', deck? }` as plugin A last answered; null until it does. */
const view = atom(null);
/** The key whose picker is open, or null for the grid. */
const picking = atom(null);
/** The last result of a click, in words (also the last pairing result). */
const note = atom('');
const busy = atom(false);

const REASONS = {
  noFocusedPane: 'No pane is focused in Orca. Click a terminal first.',
  noSuchPane: 'That pane is gone. Pick another one.',
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

/** The Stream Deck SDK's device type numbers, as the deck frame carries them. */
const MODELS = {
  0: 'Stream Deck (MK.2)',
  1: 'Stream Deck Mini',
  2: 'Stream Deck XL',
  3: 'Stream Deck Mobile',
  7: 'Stream Deck +',
  9: 'Stream Deck Neo',
  11: 'Virtual Stream Deck',
  13: 'Stream Deck + XL',
};
const modelName = (m) => MODELS[m] ?? (m && Number.isNaN(Number(m)) ? m : 'Stream Deck');

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
    set(picking, null);
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
    <Row gap="xs" align="center" wrap>
      <Badge tone="success">Connected</Badge>
      <Text muted size="xs">
        {`${modelName(deck.model)}, ${deck.cols} x ${deck.rows} keys`}
      </Text>
    </Row>
  );
}

/** Numbers only, one small button per key, rows x columns as on the deck. A wide deck wraps instead of clipping. */
function Grid({ deck }) {
  const working = read(busy);
  const rows = [];
  for (let r = 0; r < deck.rows; r++)
    rows.push(deck.keys.filter((k) => Math.ceil(k.key / deck.cols) === r + 1));
  return (
    <Stack gap="xs">
      {rows.map((keys, i) => (
        <Row key={i} gap="xs" wrap>
          {keys.map((k) => (
            <Button
              key={k.key}
              size={deck.cols > 6 ? 'xs' : 'sm'}
              variant={k.mapped ? 'solid' : 'outline'}
              tone={TONES[k.state] ?? 'neutral'}
              disabled={working}
              tooltip={k.mapped ? `Key ${k.key}: ${k.label} (${k.state})` : `Key ${k.key}: empty`}
              onPress={() => set(picking, k.key)}
            >
              {k.key}
            </Button>
          ))}
        </Row>
      ))}
    </Stack>
  );
}

function paneLine(p, key) {
  const bits = [];
  if (p.focused) bits.push('Focused');
  if (p.onKey && p.onKey !== key) bits.push(`on key ${p.onKey}`);
  if (p.agent) bits.push(p.agent);
  if (p.detail) bits.push(p.detail);
  return bits.join(' · ');
}

/** The key settings: which pane the key shows, the panes to put on it, Unmap and Back. */
function Picker({ deck, k }) {
  const working = read(busy);
  const panes = deck.panes ?? [];
  const pick = (paneKey) => act('deck.assign', { key: k.key, replace: k.mapped, paneKey }, k.key);
  return (
    <Stack gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Heading level={3}>Key {k.key}</Heading>
        <Button size="xs" variant="ghost" onPress={() => set(picking, null)}>
          Back
        </Button>
      </Row>
      <Text size="xs" muted={!k.mapped}>
        {k.mapped ? `Shows ${k.label}` : 'Empty'}
      </Text>
      {k.mapped ? (
        <Button
          size="xs"
          variant="outline"
          tone="danger"
          disabled={working}
          onPress={() => act('deck.unmap', { key: k.key }, k.key)}
        >
          Unmap
        </Button>
      ) : null}
      {panes.length ? (
        <List label="Choose a pane">
          {panes.map((p) => (
            <ListItem
              key={p.paneKey}
              title={p.label}
              description={paneLine(p, k.key)}
              current={p.onKey === k.key}
              disabled={working}
              onPress={() => pick(p.paneKey)}
            />
          ))}
        </List>
      ) : (
        <Stack gap="xs">
          <Text size="xs" muted>
            Orca lists no terminal panes yet.
          </Text>
          <Button
            size="xs"
            disabled={working}
            onPress={() => act('deck.assign', { key: k.key, replace: k.mapped }, k.key)}
          >
            Use the focused pane
          </Button>
        </Stack>
      )}
    </Stack>
  );
}

export default function Panel() {
  const v = read(view);
  const last = read(note);
  const open = read(picking);
  const live = v && v.status === 'ok' && v.deck.connected;
  const k = live && open !== null ? v.deck.keys.find((x) => x.key === open) : null;
  return (
    <Stack gap="md">
      <Heading>Agent Deck</Heading>
      <Status v={v} />
      {live && k ? <Picker deck={v.deck} k={k} /> : null}
      {live && !k ? <Grid deck={v.deck} /> : null}
      {last ? <Text size="xs">{last}</Text> : null}
      <Button size="sm" variant="ghost" icon="refresh" onPress={() => refresh()}>
        Refresh
      </Button>
    </Stack>
  );
}
