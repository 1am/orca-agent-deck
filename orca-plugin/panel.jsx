// The Agent Deck sidebar panel: the connected deck as a grid of numbered keys, shaped like the deck. A click on a
// key marks it and shows its details under the grid (like the key settings in the Stream Deck app): what it shows,
// Unmap, the focused pane and the panes Orca lists. The details stay open after a choice; Back closes them.
// Opened from the status bar button or the shortcut it shows the key of the focused pane (details open), else the
// bare grid. While the panel is in view with a key's details open, a tap on a deck key opens that key here.
// Orca draws this tree with its own controls (ui: "components", no build step). The deck is plugin B's: this
// panel only asks plugin A (main.mjs) for its state (`deck.get`, and `deck.changed` pushes) and sends choices
// (`deck.assign`, `deck.unmap`, `deck.panelSelect`).
import {
  atom,
  Box,
  Button,
  Heading,
  Input,
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
/** What the pane list is narrowed to. */
const query = atom('');
const REASONS = {
  noFocusedPane:
    'No pane is focused in Orca (it reports none on a paired server): click a terminal, or pick a pane below.',
  noSuchPane: 'That pane is gone. Pick another one.',
  deckOffline: 'The Stream Deck is not connected.',
  noSuchKey: 'That key is not on the deck any more.',
  occupied: 'That key already shows a pane.',
  timeout: 'The Stream Deck plugin did not answer.',
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

/** The panel fits the sidebar and only the pane list scrolls: it takes the free height, down to this floor. */
const PANE_LIST_MIN_PX = 120;
/** A two-line row's height, and the list height a sidebar usually leaves: the box height itself is not readable. */
const PANE_ROW_PX = 48;
const PANE_LIST_TYPICAL_PX = 400;
/** Orca draws a scrollbar only on hover: past this many panes the list likely overflows and says it scrolls. */
const PANE_LIST_SCROLL_HINT = Math.floor(PANE_LIST_TYPICAL_PX / PANE_ROW_PX);

/** Key tone from the state the deck shows. */
const TONES = {
  working: 'accent',
  needs_input: 'warning',
  awaiting_reply: 'warning',
  error: 'danger',
  completed: 'success',
};

/** Opens a key's details (null closes them); the last result line and a search typed for another key go. */
function openKey(key) {
  set(note, '');
  set(query, '');
  set(picking, key);
  // Tell the worker now (Back, no key open): the redraw would send it too, a moment later.
  reportSelecting(wantSelecting());
}

async function refresh() {
  try {
    const v = await plugin.request('deck.get');
    set(view, v);
    return v;
  } catch (e) {
    set(view, null);
    set(note, failed(e));
    return null;
  }
}

/** The panel was asked for: the details of the key the focused pane is on, if it is on one. */
async function showFocusedKey() {
  const v = await refresh();
  if (v?.status !== 'ok') return;
  // A key B asked for (a hold) wins over the focused pane's key.
  const key = Number.isInteger(v.picked) ? v.picked : v.deck.panes?.find((p) => p.focused)?.onKey;
  if (key) {
    openKey(key);
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
  } catch (e) {
    set(note, failed(e));
  } finally {
    set(busy, false);
  }
}

/** True while the person can see the panel (from setup; true where Orca gives none). */
let visible = null;
/** What the worker was last told about deck taps, so a redraw sends only a change. */
let selectSent = null;

/** Whether deck taps should open keys here: in view, deck connected, and a key's details open. */
function wantSelecting() {
  const v = read(view);
  const live = v && v.status === 'ok' && v.deck.connected;
  return !!live && (visible ? read(visible) : true) && read(picking) !== null;
}

/** The panel is drawn on screen (not hidden, not behind another sidebar tab); true where Orca gives no signal. */
function inView() {
  return visible ? !!read(visible) : true;
}

/** What the worker was last told about the panel being in view, so a redraw sends only a change. */
let viewSent = null;

/**
 * Tells the worker whether the panel is in view, so the status bar button and the shortcut can hide the right
 * sidebar instead of showing the panel again. The worker treats silence as not in view, so `renew` repeats an on.
 */
function reportView(on, renew = false) {
  if (on === viewSent && !(renew && on)) return;
  viewSent = on;
  void Promise.resolve()
    .then(() => plugin.request('deck.panelView', { on }))
    .catch(() => (viewSent = null));
}

/** B drops a `panelSelect` that is not renewed within this long (a hidden panel may not draw or run again). */
const SELECT_HEARTBEAT_MS = 1000;
/** `visible` is polled this often (Orca offers no way to be told of a hide), so a hide releases deck taps within it. */
const VISIBLE_POLL_MS = 500;

/**
 * Deck taps open keys here only while the panel is in view with a key's details open. Called while drawing, which
 * re-runs on each change of what it reads, and by a timer that re-reads `visible` (Orca offers no way to be told
 * of a hide); the request leaves after the draw. `renew` repeats an on so B keeps it.
 */
function reportSelecting(on, renew = false) {
  if (on === selectSent && !(renew && on)) return;
  selectSent = on;
  void Promise.resolve()
    .then(() => plugin.request('deck.panelSelect', { on }))
    .catch(() => (selectSent = null));
}

export function setup(ctx) {
  visible = ctx.visible ?? null;
  let ticks = 0;
  const heartbeat = setInterval(() => {
    // Every tick sends a change at once; every second tick also renews an on.
    const renew = ++ticks % (SELECT_HEARTBEAT_MS / VISIBLE_POLL_MS) === 0;
    reportSelecting(wantSelecting(), renew);
    reportView(inView(), renew);
  }, VISIBLE_POLL_MS);
  heartbeat.unref?.();
  ctx.signal?.addEventListener('abort', () => clearInterval(heartbeat));
  ctx.subscriptions.push(
    { dispose: () => clearInterval(heartbeat) },
    { dispose: () => void plugin.request('deck.panelSelect', { on: false }).catch(() => {}) },
    { dispose: () => void plugin.request('deck.panelView', { on: false }).catch(() => {}) },
    plugin.on('deck.keyPicked', (payload) => {
      if (!Number.isInteger(payload?.key)) return;
      openKey(payload.key);
    }),
    plugin.on('deck.changed', (payload) => {
      set(view, payload);
      if (payload?.status !== 'ok') set(picking, null);
    }),
    plugin.on('panel.opened', () => void showFocusedKey()),
  );
  void showFocusedKey();
}

function Status({ v }) {
  if (!v) return <Text muted>Asking the Stream Deck plugin...</Text>;
  if (v.status !== 'ok') return <Text tone="warning">{REASONS[v.status]}</Text>;
  const { deck } = v;
  if (!deck.connected) return <Text tone="warning">{REASONS.deckOffline}</Text>;
  return (
    <Text muted size="xs" truncate>
      {modelName(deck.model)}
    </Text>
  );
}

const pick = (p) => ({ paneKey: p.paneKey, ...(p.hostId ? { hostId: p.hostId } : {}) });

/** What a position that is not one of our Pane keys is, for its tooltip. */
const OTHER_KINDS = {
  status: 'the Agent Deck status key',
  attention: 'the Agent Deck attention key',
  other: 'not an Agent Deck key',
};

/**
 * Every position of the deck, rows x columns as on the deck, as equal keys that fill the width. Pane keys are buttons
 * (filled and in their state's colour when they show a pane, outlined when empty, ringed when selected); the other
 * positions are greyed out. A Stream Deck plugin without `layout` draws only the Pane keys it lists.
 */
function Grid({ deck }) {
  const working = read(busy);
  const open = read(picking);
  const byKey = new Map(deck.keys.map((k) => [k.key, k]));
  const cells = deck.layout
    ? deck.layout.map((l) => ({ key: l.key, kind: l.kind, k: byKey.get(l.key) }))
    : deck.keys.map((k) => ({ key: k.key, kind: 'pane', k }));
  const rows = [];
  for (let r = 0; r < deck.rows; r++)
    rows.push(cells.filter((c) => Math.ceil(c.key / deck.cols) === r + 1));
  return (
    <Stack gap="xs">
      {rows.map((cs, i) => (
        <Box key={i} direction="row" gap="xs" width="100%">
          {cs.map(({ key, kind, k }) => {
            const pane = kind === 'pane';
            const mapped = pane && !!k?.mapped;
            return (
              <Box
                key={key}
                grow
                width={0}
                minWidth={0}
                align="stretch"
                border={open === key ? 'accent' : false}
                radius="md"
              >
                <Button
                  size={deck.cols > 6 ? 'xs' : 'sm'}
                  variant={mapped ? 'solid' : pane ? 'outline' : 'ghost'}
                  tone={mapped ? (TONES[k.state] ?? 'neutral') : 'neutral'}
                  disabled={pane ? working : true}
                  tooltip={
                    pane
                      ? mapped
                        ? `Key ${key}: ${k.label} (${k.state})`
                        : `Key ${key}: empty`
                      : `Key ${key}: ${OTHER_KINDS[kind] ?? OTHER_KINDS.other}`
                  }
                  onPress={() => {
                    openKey(open === key ? null : key);
                  }}
                >
                  {key}
                </Button>
              </Box>
            );
          })}
        </Box>
      ))}
    </Stack>
  );
}

/** The group a pane sits under, as the key settings list writes it: host > repo > branch (an older plugin: its label). */
function groupOf(p) {
  const host = p.remote ? `Remote: ${p.host ?? 'unknown host'}` : 'This machine';
  const where = p.name === undefined ? [p.label] : [p.repo, p.branch];
  return [host, ...where].filter(Boolean).join(' > ');
}

/** What the row says under its name: the agent and the marks; the host is in the group header, the key in the badge. */
function paneLine(p) {
  const bits = [];
  // An older plugin has no name: its detail (title and tab) is the best the row can say.
  if (p.name === undefined && p.detail) bits.push(p.detail);
  if (p.agent) bits.push(p.agent);
  if (p.focused) bits.push('Focused');
  if (p.lastPressed) bits.push('Last opened from the deck');
  return bits.join(' · ');
}

/** Every word of `q` appears in the pane's row as drawn: group, name, tab, agent, marks, key, host name and address (any case). */
function matches(p, q) {
  const text = [
    p.label,
    p.detail,
    groupOf(p),
    p.tab,
    p.name,
    p.agent,
    p.focused && 'Focused',
    p.lastPressed && 'Last opened from the deck',
    p.onKey && `on key ${p.onKey}`,
    p.host,
    p.hostAddress,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      // A bare number is a whole number: "7" finds key 7, not 17 or an address with a 7 in it.
      .every((w) =>
        /^\d+$/.test(w) ? new RegExp(`(^|\\D)${w}(\\D|$)`).test(text) : text.includes(w),
      )
  );
}

/** One pane: a small badge at the left (its key, or an empty square when it is on none), then the row to press. */
function PaneRow({ p, k, working }) {
  const here = p.onKey === k.key;
  return (
    <Box direction="row" gap="xs" align="start">
      {/* A small copy of a grid key: filled in its state's colour when the pane is on a key (ringed when it is the
          key being edited), an empty square when it is on none. */}
      <Box width={36} shrink={false} align="stretch">
        {p.onKey ? (
          <Box align="stretch" border={here ? 'accent' : false} radius="md">
            <Button size="xs" variant="solid" tone={TONES[p.state] ?? 'neutral'}>
              {p.onKey}
            </Button>
          </Box>
        ) : (
          <Box height={28} border radius="md" />
        )}
      </Box>
      <Box grow width={0} minWidth={0}>
        <List label={`Choose ${p.name || p.label}`}>
          <ListItem
            title={p.name || p.label}
            description={paneLine(p)}
            current={here}
            disabled={working}
            onPress={() => act('deck.assign', { key: k.key, replace: k.mapped, ...pick(p) }, k.key)}
          />
        </List>
      </Box>
    </Box>
  );
}

/**
 * The pane list of a key (`k`), the focused pane first, or why there is none: a Stream Deck plugin of an older
 * build sends no list at all. A press puts the pane on the key.
 */
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
  const q = read(query);
  const found = q.trim() ? deck.panes.filter((p) => matches(p, q)) : deck.panes;
  const shown = [...found.filter((p) => p.focused), ...found.filter((p) => !p.focused)];
  // Groups in order of their first pane, so the focused pane's group is first and groups stay whole.
  const groups = new Map();
  for (const p of shown) {
    const g = groupOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  return (
    // Grows into the sidebar's free height: the list below is what takes it.
    <Box grow minHeight={0} gap="sm" align="stretch">
      <Input
        type="search"
        label="Search panes"
        labelHidden
        placeholder="Search panes"
        value={q}
        onChange={(text) => set(query, text)}
      />
      {shown.length ? null : (
        <Text size="xs" muted>
          {`No pane matches "${q.trim()}".`}
        </Text>
      )}
      {/* The hint only while the rows overflow the minimum box: a taller sidebar may still show them all. */}
      {shown.length > PANE_LIST_SCROLL_HINT ? (
        <Text size="xs" muted>
          {`${shown.length} panes: scroll the list for more`}
        </Text>
      ) : null}
      {/* Its own scroll area, so the grid and the banner stay in view; it fills the sidebar, at least PANE_LIST_MIN_PX. */}
      <Box grow scroll="y" minHeight={PANE_LIST_MIN_PX}>
        <Stack gap="md">
          {[...groups].map(([group, list]) => (
            <Stack key={group} gap="xs">
              <Text size="xs" weight="semibold" muted truncate>
                {group}
              </Text>
              {list.map((p) => (
                <PaneRow key={`${p.hostId ?? ''}\0${p.paneKey}`} p={p} k={k} working={working} />
              ))}
            </Stack>
          ))}
        </Stack>
      </Box>
    </Box>
  );
}

/** The selected key's details, under the grid: what it shows, Unmap, the focused pane and the panes to choose. */
function Details({ deck, k }) {
  const working = read(busy);
  // A Stream Deck plugin that sends no pane list cannot say: let the press try.
  const noFocus = !!deck.panes && !deck.panes.some((p) => p.focused);
  return (
    <Box grow minHeight={0} gap="sm" align="stretch">
      {/* One line: the key, what it shows (cut off with an ellipsis) and Back at the right. */}
      <Box direction="row" gap="sm" align="center">
        <Text weight="semibold">Key {k.key}</Text>
        <Box grow width={0} minWidth={0}>
          <Text size="xs" muted={!k.mapped} truncate>
            {k.mapped ? k.label : 'Empty'}
          </Text>
        </Box>
        <Button size="xs" variant="ghost" onPress={() => openKey(null)}>
          Back
        </Button>
      </Box>
      <Row gap="xs" wrap>
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
        <Button
          size="xs"
          disabled={working || noFocus}
          onPress={() => act('deck.assign', { key: k.key, replace: k.mapped }, k.key)}
        >
          Use the focused pane
        </Button>
      </Row>
      {noFocus ? (
        <Text size="xs" tone="warning">
          {REASONS.noFocusedPane}
        </Text>
      ) : null}
      <Panes deck={deck} k={k} />
    </Box>
  );
}

export default function Panel() {
  const v = read(view);
  const last = read(note);
  const open = read(picking);
  const live = v && v.status === 'ok' && v.deck.connected;
  const k = live && open !== null ? v.deck.keys.find((x) => x.key === open) : null;
  reportSelecting(wantSelecting());
  reportView(inView());
  return (
    // One box, one padding: every block (heading, status, grid, details, search, list) shares the same edges. `md`
    // between blocks, `sm` inside one; the full height lets the pane list fill what is left of the sidebar.
    <Box padding="md" gap="md" align="stretch" height="100%">
      <Heading>Agent Deck</Heading>
      <Box direction="row" gap="sm" align="center">
        <Box minWidth={0}>
          <Status v={v} />
        </Box>
        <Button size="xs" variant="ghost" icon="refresh" onPress={() => refresh()}>
          Refresh
        </Button>
      </Box>
      {live ? <Grid deck={v.deck} /> : null}
      {last ? <Text size="xs">{last}</Text> : null}
      {live && k ? <Separator /> : null}
      {live && k ? <Details deck={v.deck} k={k} /> : null}
    </Box>
  );
}
