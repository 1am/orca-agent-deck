// The Agent Deck sidebar panel: the connected deck as a grid of numbered keys, shaped like the deck. A click on a
// key marks it and shows its details under the grid (like the key settings in the Stream Deck app): what it shows,
// Unmap, the focused pane and the panes Orca lists. The details stay open after a choice; Back closes them.
// Opened from the status bar button or the shortcut it is in map mode: a banner names the pane being mapped and a
// click on an empty key assigns it at once.
// Orca draws this tree with its own controls (ui: "components", no build step). The deck is plugin B's: this
// panel only asks plugin A (main.mjs) for its state (`deck.get`, and `deck.changed` pushes) and sends choices
// (`deck.assign`, `deck.unmap`).
import {
  atom,
  Badge,
  Box,
  Button,
  Heading,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Separator,
  set,
  Stack,
  Text,
} from 'orca';

/** `{ status: 'ok' | 'offline' | 'update', deck? }` as plugin A last answered; null until it does. */
const view = atom(null);
/** The key whose details are open, or null. */
const picking = atom(null);
/** The last result of a click, in words (also the last pairing result). */
const note = atom('');
const busy = atom(false);
/** The panel was opened to map the focused pane (status bar button, shortcut): a click on an empty key assigns it. */
const mapping = atom(false);

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
/** A request that never got a result: the Orca plugin did not answer, or it failed. */
const failed = (e) =>
  `The Orca plugin did not answer (${String(e?.message ?? e).slice(0, 80) || 'no reason given'}). Try Refresh.`;
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
  try {
    const v = await plugin.request('deck.get');
    set(view, v);
    set(mapping, v?.mapping === true);
  } catch (e) {
    set(view, null);
    set(note, failed(e));
  }
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
    if (r.ok) set(mapping, false);
  } catch (e) {
    set(note, failed(e));
  } finally {
    set(busy, false);
  }
}

export function setup(ctx) {
  ctx.subscriptions.push(
    plugin.on('deck.changed', (payload) => {
      set(view, payload);
      if (typeof payload?.mapping === 'boolean') set(mapping, payload.mapping);
    }),
    plugin.on('map.changed', (payload) => set(mapping, payload?.mapping === true)),
  );
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

/** The pane Orca has focused: the one a map-mode click assigns. */
const focusedPane = (deck) => deck.panes?.find((p) => p.focused) ?? null;

/** Names the pane being mapped, so it is clear which one it is even when Orca shows it faintly. */
function MapBanner({ deck }) {
  const pane = focusedPane(deck);
  return (
    <Stack gap="xs">
      <Badge tone="accent">Mapping</Badge>
      <Heading level={3}>{pane ? `Map ${pane.label} to a key` : REASONS.noFocusedPane}</Heading>
      {pane ? (
        <Text size="xs" muted>
          {paneLine(pane, 0) || 'Focused terminal pane'}
        </Text>
      ) : null}
      <Text size="xs">Click an empty key below, or press a key on the deck.</Text>
      <Row>
        <Button
          size="xs"
          variant="ghost"
          onPress={() => {
            set(mapping, false);
            plugin.request('deck.mapEnd').catch(() => {});
          }}
        >
          Cancel
        </Button>
      </Row>
    </Stack>
  );
}

/** Numbers only, one small button per key, rows x columns as on the deck. A wide deck wraps instead of clipping. */
function Grid({ deck }) {
  const working = read(busy);
  const open = read(picking);
  const mapMode = read(mapping);
  const rows = [];
  for (let r = 0; r < deck.rows; r++)
    rows.push(deck.keys.filter((k) => Math.ceil(k.key / deck.cols) === r + 1));
  return (
    <Stack gap="xs">
      {rows.map((keys, i) => (
        <Row key={i} gap="xs" wrap>
          {keys.map((k) => (
            <Box key={k.key} border={open === k.key ? 'accent' : false} radius="md">
              <Button
                size={deck.cols > 6 ? 'xs' : 'sm'}
                variant={k.mapped ? 'solid' : 'outline'}
                tone={TONES[k.state] ?? 'neutral'}
                disabled={working}
                tooltip={k.mapped ? `Key ${k.key}: ${k.label} (${k.state})` : `Key ${k.key}: empty`}
                onPress={() => {
                  set(note, '');
                  // Map mode: an empty key takes the pane named above at once; a key that shows a pane opens its
                  // details, where replacing it is a choice of its own.
                  const pane = focusedPane(deck);
                  if (mapMode && !k.mapped && pane)
                    return void act(
                      'deck.assign',
                      { key: k.key, replace: false, paneKey: pane.paneKey },
                      k.key,
                    );
                  set(picking, open === k.key ? null : k.key);
                }}
              >
                {k.key}
              </Button>
            </Box>
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

/** The pane list, or why there is none: a Stream Deck plugin of an older build sends no list at all. */
function Panes({ deck, k }) {
  const working = read(busy);
  if (!deck.panes)
    return (
      <Text size="xs" tone="warning">
        The pane list needs a newer Stream Deck plugin: update it to choose any pane.
      </Text>
    );
  if (!deck.panes.length)
    return (
      <Text size="xs" muted>
        Orca lists no terminal panes.
      </Text>
    );
  return (
    <List label="Choose a pane">
      {deck.panes.map((p) => (
        <ListItem
          key={p.paneKey}
          title={p.label}
          description={paneLine(p, k.key)}
          current={p.onKey === k.key}
          disabled={working}
          onPress={() =>
            act('deck.assign', { key: k.key, replace: k.mapped, paneKey: p.paneKey }, k.key)
          }
        />
      ))}
    </List>
  );
}

/** The selected key's details, under the grid: what it shows, Unmap, the focused pane and the panes to choose. */
function Details({ deck, k }) {
  const working = read(busy);
  return (
    <Stack gap="sm">
      <Separator />
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
        <Row>
          <Button
            size="xs"
            variant="outline"
            tone="danger"
            disabled={working}
            onPress={() => act('deck.unmap', { key: k.key }, k.key)}
          >
            Unmap
          </Button>
        </Row>
      ) : null}
      <Row>
        <Button
          size="xs"
          disabled={working}
          onPress={() => act('deck.assign', { key: k.key, replace: k.mapped }, k.key)}
        >
          Use the focused pane
        </Button>
      </Row>
      <Panes deck={deck} k={k} />
    </Stack>
  );
}

export default function Panel() {
  const v = read(view);
  const last = read(note);
  const open = read(picking);
  const mapMode = read(mapping);
  const live = v && v.status === 'ok' && v.deck.connected;
  const k = live && open !== null ? v.deck.keys.find((x) => x.key === open) : null;
  return (
    <Stack gap="md">
      <Heading>Agent Deck</Heading>
      <Status v={v} />
      {live && mapMode ? <MapBanner deck={v.deck} /> : null}
      {live ? <Grid deck={v.deck} /> : null}
      {live && k ? <Details deck={v.deck} k={k} /> : null}
      {last ? <Text size="xs">{last}</Text> : null}
      <Button size="sm" variant="ghost" icon="refresh" onPress={() => refresh()}>
        Refresh
      </Button>
    </Stack>
  );
}
