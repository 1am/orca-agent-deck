// Agent Deck for Orca plugin A (trusted-worker). Single ESM file, no dependencies.
// Finds plugin B (the Stream Deck plugin) through its discovery file, proves the shared token,
// forwards agent status, and reconnects on every activate.
// Never log tokens or terminal content.
import net from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

export const PROTOCOL_VERSION = 1;
/** Additive features of this major: 1 = the deck grid for the sidebar panel, 2 = B opens that panel for us, 3 = a deck press selects the key in that panel (see docs/bridge-protocol.md). */
export const PROTOCOL_MINOR = 5;
export const PLUGIN_VERSION = '0.2.2';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const here = () => ({ platform: process.platform, env: process.env, homedir: homedir() });

/** Per-user folder of bridge.json and plugin-a.log. Mirrors `deckDataDir` in adapter-bridge. */
export const deckDataDir = ({ platform, env, homedir: home } = here()) =>
  platform === 'win32'
    ? // Orca's worker can start without APPDATA in its environment: use the same per-user folder.
      win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'orca-deck')
    : posix.join(home, '.orca-deck');

export const defaultDiscoveryPath = () => join(deckDataDir(), 'bridge.json');

/**
 * Regular file (no symlink) of the current user, not readable by group or other. Mirrors B's check.
 * Windows has no mode bits or uid: only the regular-file check applies, the profile ACL does the rest.
 */
export async function isPrivateFile(path) {
  try {
    const st = await lstat(path);
    if (process.platform === 'win32') return st.isFile();
    return st.isFile() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

// Handshake MACs, mirroring packages/adapter-bridge/src/server.ts: a direction label plus two
// fixed-length nonces, so an answer can neither be reflected nor spliced into another session.
const NONCE = /^[0-9a-f]{32}$/;
const mac = (token, label, first, second) =>
  createHmac('sha256', token).update(label).update(first).update(second).digest('hex');
/** Time B has to prove itself; a silent peer on the port must not hold the connection slot. */
export const HANDSHAKE_MS = 5000;

/** Largest HTTP response head and message accepted from B; B's messages are well under 1 KiB. */
export const MAX_HEAD = 8 * 1024;
export const MAX_MESSAGE = 256 * 1024;

/**
 * Minimal RFC 6455 client over node:net: text frames only, enough for the bridge. Anything on the
 * port can talk to it before auth, so sizes are capped and protocol violations close the socket.
 */
export function openWebSocket(host, port, { onOpen, onMessage, onClose, onError }) {
  const key = randomBytes(16).toString('base64');
  const sock = net.connect(port, host);
  let buf = Buffer.alloc(0);
  let upgraded = false;
  let closed = false;
  let frag = [];
  let fragLen = 0;
  let inText = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const frame = (opcode, payload) => {
    const mask = randomBytes(4);
    const len = payload.length;
    const head =
      len < 126
        ? Buffer.from([0x80 | opcode, 0x80 | len])
        : len < 65536
          ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
          : (() => {
              const h = Buffer.alloc(10);
              h[0] = 0x80 | opcode;
              h[1] = 0x80 | 127;
              h.writeBigUInt64BE(BigInt(len), 2);
              return h;
            })();
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    return Buffer.concat([head, mask, body]);
  };
  const drain = () => {
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const fin = (buf[0] & 0x80) !== 0;
      // Server frames are never masked and use no extensions (RSV bits).
      if (buf[1] & 0x80 || buf[0] & 0x70) return sock.destroy();
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const control = opcode >= 0x8;
      if (control ? len > 125 || !fin : fragLen + len > MAX_MESSAGE) return sock.destroy();
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (opcode === 0x8) return sock.end(frame(0x8, Buffer.alloc(0)));
      if (opcode === 0x9) sock.write(frame(0xa, payload));
      else if (opcode === 0x1 || opcode === 0x0) {
        // A continuation needs a text message in progress; a new text frame must not interrupt one.
        if ((opcode === 0x0) !== inText) return sock.destroy();
        frag.push(payload);
        fragLen += len;
        inText = !fin;
        if (fin) {
          const text = Buffer.concat(frag).toString('utf8');
          frag = [];
          fragLen = 0;
          onMessage(text);
        }
      } else if (!control) return sock.destroy(); // binary or unknown data frames
    }
  };

  sock.on('connect', () =>
    sock.write(
      `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ),
  );
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return buf.length > MAX_HEAD ? sock.destroy() : undefined;
      const head = buf.subarray(0, end).toString('latin1');
      buf = buf.subarray(end + 4);
      const accept = createHash('sha1')
        .update(key + GUID)
        .digest('base64');
      const got = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(head)?.[1];
      if (!head.startsWith('HTTP/1.1 101') || got !== accept) return sock.destroy();
      upgraded = true;
      onOpen();
    }
    drain();
  });
  sock.on('error', (e) => onError?.(e));
  sock.on('close', finish);
  return {
    send: (text) => upgraded && !closed && sock.write(frame(0x1, Buffer.from(text))),
    close: () => sock.destroy(),
  };
}

/**
 * Keeps one connection to B. Safe to call `ensure()` repeatedly (every activate, every command):
 * a live connection is kept, a dead one is replaced, and the discovery file is re-read each time
 * because B rotates its token on every start.
 */
export function createBridge({
  orcaVersion,
  discoveryPath = defaultDiscoveryPath(),
  log = () => {},
  retryMs = 1000,
  maxRetryMs = 30_000,
  handshakeMs = HANDSHAKE_MS,
  followMs = 5000,
  /** While there is no B to talk to, look at the discovery file at least this often (a new B must be found in seconds). */
  pollMs = 2000,
  onAck = () => {},
  onMessage: onBridgeMessage = () => {},
  onChange = () => {},
}) {
  let ws = null;
  let state = 'disconnected';
  let timer = null;
  let deck = null;
  /** B's protocol minor from `helloAck` (0 for a Stream Deck plugin that tells none), and which connection it is. */
  let peerMinor = 0;
  let session = 0;
  /** Set while B speaks another bridge major: A must not use its messages and says so. */
  let versionNote = null;
  let stopped = false;
  let delay = retryMs;
  /** The discovery file the open connection was made from, to notice a newer B (see `follow`). */
  let connectedTo = null;
  const sameB = (a, b) => a.pid === b.pid && a.port === b.port && a.token === b.token;
  /**
   * Every B writes a new bridge.json, but an open socket never looks at it: after the Stream Deck app is swapped
   * (Elgato <-> OpenDeck) A would stay on the old B for good. Drop the socket when the file names another B.
   */
  const follow = setInterval(async () => {
    if (stopped || state !== 'connected' || !ws || !connectedTo) return;
    const socket = ws;
    try {
      const now = JSON.parse(await readFile(discoveryPath, 'utf8'));
      if (ws !== socket || sameB(connectedTo, now)) return;
      log(
        `bridge: a newer Stream Deck plugin (pid ${now.pid}) owns the discovery file, reconnecting`,
      );
      delay = retryMs;
      socket.close();
    } catch {
      // No file (or half written): keep the connection, the next tick looks again.
    }
  }, followMs);
  follow.unref?.();

  const setState = (s) => {
    if (s === state) return;
    log(`bridge: ${state} -> ${s}`);
    state = s;
    onChange();
  };
  const schedule = () => {
    if (stopped || timer) return;
    const wait = delay;
    delay = Math.min(delay * 2, maxRetryMs);
    timer = setTimeout(() => {
      timer = null;
      void ensure();
    }, wait);
    timer.unref?.();
  };

  async function ensure() {
    if (stopped || ws) return;
    let disc;
    try {
      if (!(await isPrivateFile(discoveryPath))) throw new Error('discovery file not private');
      disc = JSON.parse(await readFile(discoveryPath, 'utf8'));
    } catch {
      setState('b-not-running');
      log('bridge file not found, Stream Deck plugin not running');
      delay = Math.min(delay, pollMs);
      return schedule();
    }
    if (stopped || ws) return;
    connectedTo = disc;
    setState('connecting');
    // Challenge-response: the token itself never goes over the wire, and nothing is sent
    // (no hello, no statuses) until B has proven it knows the token.
    const nonce = randomBytes(16).toString('hex');
    let challenge = null;
    let proven = false;
    const socket = openWebSocket('127.0.0.1', disc.port, {
      onOpen: () => {},
      onMessage: (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        // Every message of B carries its bridge major; another one means one of the two plugins is outdated. Only
        // after B proved it knows the token: anything else on the port can say anything, and is ignored below.
        if (proven && msg && typeof msg === 'object' && msg.v !== PROTOCOL_VERSION) {
          versionNote = `B speaks bridge ${String(msg.v)}, this plugin ${PROTOCOL_VERSION}`;
          onChange();
          log(
            `bridge: ${versionNote}: update Agent Deck for Orca (both plugins from the same release)`,
          );
          return socket.close();
        }
        if (msg?.type === 'challenge' && !challenge && NONCE.test(String(msg.nonce))) {
          challenge = msg.nonce;
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'auth',
              nonce,
              mac: mac(disc.token, 'orca-deck/auth/v1', challenge, nonce),
            }),
          );
        } else if (msg?.type === 'proof' && challenge && !proven) {
          const want = Buffer.from(mac(disc.token, 'orca-deck/proof/v1', nonce, challenge));
          const got = Buffer.from(String(msg.mac));
          if (got.length !== want.length || !timingSafeEqual(got, want)) {
            log('bridge: peer on the bridge port failed the token proof, closing');
            return socket.close();
          }
          proven = true;
          clearTimeout(deadline);
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'hello',
              orcaVersion,
              pluginVersion: PLUGIN_VERSION,
              minor: PROTOCOL_MINOR,
            }),
          );
        } else if (!proven) {
          return;
        } else if (msg?.type === 'helloAck') {
          setState('connected');
          versionNote = null;
          delay = retryMs;
          deck = msg.deck ?? null;
          peerMinor = Number.isInteger(msg.minor) && msg.minor > 0 ? msg.minor : 0;
          session++;
          log('connected to Agent Deck for Orca');
          onChange();
          onAck(msg);
        } else if (msg?.type) {
          onBridgeMessage(msg);
        }
      },
      onError: (e) =>
        log(`bridge: socket error ${e?.code ?? e?.message ?? 'unknown'} on port ${disc.port}`),
      onClose: () => {
        clearTimeout(deadline);
        if (ws === socket) ws = null;
        deck = null;
        if (state !== 'b-not-running') setState('disconnected');
        // A B that never answered (a stale file, a B that is starting) is looked for again soon, as a missing one.
        if (!proven) delay = Math.min(delay, pollMs);
        schedule();
      },
    });
    // An older Stream Deck plugin never sends a challenge; anything else on the port may say nothing.
    const deadline = setTimeout(() => {
      if (proven) return;
      log(
        challenge
          ? 'bridge: the peer on the bridge port sent no proof, closing'
          : 'bridge: no challenge on the bridge port (Stream Deck plugin older than this one, or not Agent Deck for Orca), closing',
      );
      socket.close();
    }, handshakeMs);
    deadline.unref?.();
    ws = socket;
  }

  return {
    ensure,
    /** True when handed to a live, acknowledged connection. */
    send: (msg) => {
      if (state !== 'connected' || !ws) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    status: () => ({ state, deck, versionNote, minor: peerMinor, session }),
    /** Where the discovery file is read from, for the status report. */
    discoveryPath,
    stop() {
      stopped = true;
      clearInterval(follow);
      clearTimeout(timer);
      ws?.close();
      ws = null;
    },
  };
}

/**
 * Turns an `agent.status.changed` event into a bridge `agentStatus` message, or null when it
 * cannot be used. `mainAgent` wins over the top-level `state`, which can be stale, and Pi
 * reports only the top-level state (`mainAgent: null`).
 */
export function toAgentStatus(ev, now = Date.now()) {
  if (!ev || typeof ev.paneKey !== 'string') return null;
  const state = ev.mainAgent?.state ?? ev.state;
  if (typeof state !== 'string') return null;
  const receivedAt = typeof ev.receivedAt === 'number' ? ev.receivedAt : now;
  return {
    v: PROTOCOL_VERSION,
    type: 'agentStatus',
    paneKey: ev.paneKey,
    workspaceId: typeof ev.workspaceId === 'string' ? ev.workspaceId : '',
    state,
    outcome: ev.mainAgent?.outcome ?? null,
    stateStartedAt: ev.mainAgent?.stateStartedAt ?? receivedAt,
    receivedAt,
    ...(typeof (ev.mainAgent?.agentType ?? ev.agentType) === 'string'
      ? { agentType: ev.mainAgent?.agentType ?? ev.agentType }
      : {}),
  };
}

/**
 * Forwards status events and replays the last known state of every pane after a
 * (re)connect or a `requestSnapshot`. Orca delivers the same transition 2-3 times, so duplicates
 * (same pane, state and stateStartedAt) are dropped.
 */
export function createForwarder(bridge, { maxPanes = 500 } = {}) {
  const lastByPane = new Map();
  const forward = (msg) => bridge.send(msg);
  return {
    onStatus(ev) {
      const msg = toAgentStatus(ev);
      if (!msg) return false;
      const prev = lastByPane.get(msg.paneKey);
      if (prev && prev.state === msg.state && prev.stateStartedAt === msg.stateStartedAt) {
        return false;
      }
      // Re-insert so the Map keeps the most recently updated panes last.
      lastByPane.delete(msg.paneKey);
      lastByPane.set(msg.paneKey, msg);
      if (lastByPane.size > maxPanes) lastByPane.delete(lastByPane.keys().next().value);
      forward(msg);
      return true;
    },
    replay() {
      for (const msg of lastByPane.values()) forward(msg);
      return lastByPane.size;
    },
    size: () => lastByPane.size,
  };
}

const logPath = () => join(deckDataDir(here()), 'plugin-a.log');
const fileLog = (msg) =>
  mkdir(dirname(logPath()), { recursive: true })
    .then(() => appendFile(logPath(), `${new Date().toISOString()} ${msg}\n`))
    .catch(() => {});

const label = {
  connected: 'Orca plugin connected',
  connecting: 'Connecting to the Stream Deck plugin',
  'b-not-running': 'Stream Deck plugin not running',
  disconnected: 'Disconnected from the Stream Deck plugin',
};

/** One-line status for the command toast, within Orca's 200 character limit; ends with the log file. */
export function statusSummary({ state, deck, seen, tracked, ago, versionNote = null }) {
  const link = !deck
    ? 'no Stream Deck plugin link'
    : `Stream Deck app ${deck.connected ? 'connected' : 'not connected'}, ${deck.devices.length} device(s)`;
  const tail = ' Log: ~/.orca-deck/plugin-a.log';
  const update = versionNote ? 'Update Agent Deck for Orca. ' : '';
  const body = `${update}${label[state] ?? state}. ${link}. Events ${seen.status} (${seen.forwarded} fwd), last ${ago(seen.lastAt)}; ${tracked} pane(s).`;
  return body.slice(0, 200 - tail.length) + tail;
}

const STATUS_ITEM = 'deck';
const PANEL_ID = 'deck';
const OPEN_TIP =
  'Open Agent Deck: the panel to map terminal panes to Stream Deck keys (shortcut: Cmd+Option+K, Ctrl+Alt+K on Windows and Linux)';

/**
 * The status bar button (`contributes.statusBarItems`, id `deck`): it always runs Open panel (the Agent Deck
 * panel), and its text says when that cannot work. Null while connecting, so a reconnect does not flicker.
 * `deckConnected` is the last `deckState` of this connection, else what `helloAck` said.
 */
export function statusBarItem({ state, deck, versionNote = null, deckConnected = null }) {
  if (versionNote)
    return {
      text: 'Update Agent Deck',
      tone: 'warning',
      tooltip: 'The Orca and Stream Deck plugins are from different releases: update both',
    };
  if (state === 'connecting') return null;
  if (state !== 'connected')
    return {
      text: 'Deck offline',
      tone: 'warning',
      tooltip:
        'Agent Deck: the Stream Deck plugin is not running (open the Elgato app or OpenDeck)',
    };
  if (!(deckConnected ?? deck?.connected ?? false))
    return {
      text: 'No Stream Deck',
      tone: 'warning',
      tooltip: 'Agent Deck: the Stream Deck app shows no device with Agent Deck keys',
    };
  return { text: 'Agent Deck', tone: 'neutral', tooltip: OPEN_TIP };
}

/** How long the panel waits for the deck's state, and for the result of a click. */
const DECK_WAIT_MS = 2000;
const RESULT_WAIT_MS = 10_000;
/** B answers `openPanel` once Orca did, or failed to. */
const OPEN_WAIT_MS = 3000;
/** The panel renews its in-view report every 2 s; silence for this long means it is hidden (it may not run then). */
const PANEL_VIEW_TTL_MS = 5000;

/** Orca objects that were already logged as lacking the host API. */
const missingLogged = new WeakSet();

/**
 * Hides the right sidebar by running Orca's built-in action (`commands.run`, host API 1.3, workspace:write): it is a
 * host method, reached through `orca.host.call`. False when this Orca lacks it or refuses, so the caller shows the
 * panel instead; a missing method is logged once.
 */
export async function hideRightSidebar(orca, log = () => {}) {
  if (typeof orca.host?.call !== 'function') {
    if (!missingLogged.has(orca)) {
      missingLogged.add(orca);
      log('sidebar toggle: this Orca has no host API to run its commands, showing the panel');
    }
    return false;
  }
  try {
    await orca.host.call('commands.run', { action: 'sidebar.right.toggle' });
    return true;
  } catch (err) {
    log(`sidebar toggle refused (${err?.message ?? err}), showing the panel`);
    return false;
  }
}

/**
 * What the Agent Deck sidebar panel asks the worker (`plugin.request` in the panel, `orca.panels.handle`
 * here). The deck is B's: this only asks for its state and forwards clicks as `assignKey` / `unmapKey`, and
 * B checks the key and resolves the focused pane. `deckState` and `pairResult` arrive through `onMessage`.
 */
export function createPanelApi(
  bridge,
  {
    onDeck = () => {},
    onOpened = () => {},
    onKeyPicked = () => {},
    onHold = async () => 'show',
    deckWaitMs = DECK_WAIT_MS,
    resultWaitMs = RESULT_WAIT_MS,
    openWaitMs = OPEN_WAIT_MS,
  } = {},
) {
  // The panel is in view with a key's details open: B hands deck taps to it (minor 3).
  let selecting = false;
  const sendSelect = () => {
    const { state, minor } = bridge.status();
    if (state === 'connected' && minor >= 3)
      bridge.send({ v: PROTOCOL_VERSION, type: 'panelSelect', on: selecting });
  };
  // The key B last asked to show (a hold opens the panel, then sends keyPicked): a panel that was not mounted yet
  // missed the post, so `get` hands it over once, while it is fresh.
  let picked = null;
  // When the panel last said it is in view (0: hidden or never).
  let viewAt = 0;
  const PICKED_FRESH_MS = 5000;
  let deckNow = null;
  let deckSession = -1;
  const pending = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const omit = (o, keys) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

  const current = () => (deckNow && deckSession === bridge.status().session ? deckNow : null);
  /** The link as the panel needs it: connected with the new frames, or why not. */
  async function link() {
    if (bridge.status().state !== 'connected') {
      await bridge.ensure();
      await sleep(300);
    }
    const { state, minor } = bridge.status();
    if (state !== 'connected') return 'offline';
    return minor >= 1 ? 'ok' : 'update';
  }
  const idOf = () => randomBytes(8).toString('hex');

  async function get() {
    const status = await link();
    if (status !== 'ok') return { status };
    if (!current()) {
      bridge.send({ v: PROTOCOL_VERSION, type: 'requestDeck' });
      const end = Date.now() + deckWaitMs;
      while (!current() && Date.now() < end) await sleep(50);
    }
    // A Stream Deck plugin of this minor answers at once: silence means it is not the one we know.
    if (!current()) return { status: 'update' };
    const key = picked && Date.now() - picked.at < PICKED_FRESH_MS ? picked.key : undefined;
    picked = null;
    return { status: 'ok', deck: current(), ...(key ? { picked: key } : {}) };
  }

  async function click(frame, waitMs = resultWaitMs, minMinor = 1) {
    const status = await link();
    if (status !== 'ok') return { ok: false, reason: status };
    // A B without the frame ignores it: do not wait for an answer that cannot come.
    if (bridge.status().minor < minMinor) return { ok: false, reason: 'update' };
    const requestId = idOf();
    const answer = new Promise((resolve) => {
      pending.set(requestId, resolve);
      setTimeout(() => resolve({ ok: false, reason: 'timeout' }), waitMs).unref?.();
    });
    bridge.send({ v: PROTOCOL_VERSION, requestId, ...frame });
    const r = await answer;
    pending.delete(requestId);
    return r;
  }

  return {
    get,
    assign: async ({ key, replace, paneKey, hostId }) => {
      if (!Number.isInteger(key) || key < 1) return { ok: false, reason: 'noSuchKey' };
      return click({
        type: 'assignKey',
        key,
        replace: replace === true,
        ...(typeof paneKey === 'string' && paneKey ? { paneKey } : {}),
        ...(typeof hostId === 'string' && hostId ? { hostId } : {}),
      });
    },
    /** Asks B to show the panel in Orca's sidebar (minor 2). */
    open: (panelId) => click({ type: 'openPanel', panelId }, openWaitMs, 2),
    /** The panel was asked for (status bar, shortcut, palette): it shows the focused pane's key, if it has one. */
    opened: () => onOpened(),
    /** The panel says whether deck taps should select keys in it. */
    select: (on) => {
      selecting = on === true;
      sendSelect();
      return { ok: true };
    },
    /** The panel says whether it is in view; a report older than PANEL_VIEW_TTL_MS counts as not in view. */
    view: (on) => {
      viewAt = on === true ? Date.now() : 0;
      return { ok: true };
    },
    /** Whether the panel was last reported in view, recently. */
    inView: () => viewAt > 0 && Date.now() - viewAt < PANEL_VIEW_TTL_MS,
    /** Milliseconds since the panel last said it is in view, null when it never did (or said it is hidden). */
    viewAge: () => (viewAt > 0 ? Date.now() - viewAt : null),
    /** Forgets the report, so the next press shows the panel again. */
    forgetView: () => {
      viewAt = 0;
    },
    /** A new connection: B forgot the panel state with the old one. */
    resync: () => {
      if (selecting) sendSelect();
    },
    unmap: ({ key }) =>
      Number.isInteger(key) && key >= 1
        ? click({ type: 'unmapKey', key })
        : { ok: false, reason: 'noSuchKey' },
    onMessage(msg) {
      if (msg.type === 'deckState') {
        const state = omit(msg, ['type', 'v']);
        deckNow = state;
        deckSession = bridge.status().session;
        onDeck(state);
      } else if (
        (msg.type === 'pairResult' || msg.type === 'openPanelResult') &&
        pending.has(msg.requestId)
      ) {
        pending.get(msg.requestId)(omit(msg, ['type', 'v', 'requestId']));
      } else if (msg.type === 'holdKey' && typeof msg.requestId === 'string') {
        // B asks what a hold on a key should do: hide the sidebar while the panel is in view, else show the panel.
        void Promise.resolve(onHold(msg.key))
          .catch(() => 'show')
          .then((action) =>
            bridge.send({
              v: PROTOCOL_VERSION,
              type: 'holdResult',
              requestId: msg.requestId,
              action,
            }),
          );
      } else if (msg.type === 'keyPicked' && Number.isInteger(msg.key)) {
        picked = { key: msg.key, at: Date.now() };
        onKeyPicked(msg.key);
      }
    },
  };
}

const OFFLINE_PUSH_MS = 1000;

/**
 * Tells the panel when the link to the Stream Deck plugin is gone, since it only learns by asking (`deck.get`). A drop
 * is told after `delayMs` of staying down (a switch of the Stream Deck plugin reconnects within that and must not
 * flicker); the deck B pushes after the next handshake brings the grid back.
 */
export function createLinkNotifier({ bridge, post, delayMs = OFFLINE_PUSH_MS }) {
  let timer = null;
  let told = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    /** The bridge state changed. */
    change() {
      if (bridge.status().state === 'connected') {
        // B pushes its deck after the handshake, which brings the panel back.
        told = false;
        return cancel();
      }
      if (timer || told) return;
      timer = setTimeout(() => {
        timer = null;
        if (bridge.status().state === 'connected') return;
        told = true;
        post({ status: 'offline' });
      }, delayMs);
      timer.unref?.();
    },
    stop: cancel,
  };
}

export default async function activate(orca) {
  const log = (m) => {
    orca.log?.(m);
    void fileLog(m);
  };
  // The worker idles out and is restarted by the next event: reconnect on every activate.
  let forwarder;
  // activate() gets no app version, only the plugin API version; B reads the app version itself.
  // The panel's calls are registered once the bridge exists; its messages arrive before that only if B is fast.
  let panelApi = { onMessage: () => {}, resync: () => {} };
  // Orca before 1.4.248 has no status bar for plugins; the button is a convenience, never an error.
  const canShowItem = orca.host?.has?.('statusBar.update') === true;
  let shownItem = '';
  let lastDeck = { session: -1, connected: null };
  const updateItem = () => {
    if (!canShowItem) return;
    const s = bridge.status();
    const item = statusBarItem({
      ...s,
      deckConnected: lastDeck.session === s.session ? lastDeck.connected : null,
    });
    const sig = JSON.stringify(item);
    if (!item || sig === shownItem) return;
    shownItem = sig;
    orca.host.call('statusBar.update', { id: STATUS_ITEM, ...item }).catch((e) => {
      shownItem = '';
      log(`status bar: update failed (${e?.message ?? e})`);
    });
  };
  const bridge = createBridge({
    orcaVersion: orca.api ? `api ${orca.api.major}.${orca.api.minor}` : 'unknown',
    log,
    onAck: () => {
      forwarder?.replay();
      panelApi.resync();
    },
    onChange: () => {
      updateItem();
      link.change();
    },
    onMessage: (msg) => {
      panelApi.onMessage(msg);
      if (msg.type === 'deckState') {
        lastDeck = { session: bridge.status().session, connected: msg.connected === true };
        updateItem();
      }
      if (msg.type === 'requestSnapshot') forwarder?.replay();
    },
  });
  const link = createLinkNotifier({
    bridge,
    post: (payload) => orca.panels?.post?.('deck.changed', payload),
  });
  forwarder = createForwarder(bridge);
  panelApi = createPanelApi(bridge, {
    onDeck: (state) => orca.panels?.post?.('deck.changed', { status: 'ok', deck: state }),
    onOpened: () => orca.panels?.post?.('panel.opened', {}),
    onKeyPicked: (key) => orca.panels?.post?.('deck.keyPicked', { key }),
    onHold: async () => ((await hideIfInView()) ? 'hidden' : 'show'),
  });
  orca.panels?.handle?.('deck.get', () => panelApi.get());
  orca.panels?.handle?.('deck.assign', (input) => panelApi.assign(input ?? {}));
  orca.panels?.handle?.('deck.unmap', (input) => panelApi.unmap(input ?? {}));
  orca.panels?.handle?.('deck.panelSelect', (input) => panelApi.select(input?.on));
  orca.panels?.handle?.('deck.panelView', (input) => panelApi.view(input?.on));
  const seen = { status: 0, forwarded: 0, lastAt: 0, wokeAt: Date.now() };
  log(`worker started: plugin ${PLUGIN_VERSION}, ${bridge.status().state}`);
  // The event that woke a lazy worker arrives right after activate(); keep it even if B is down.
  orca.events.on('agent.status.changed', async (ev) => {
    seen.status++;
    seen.lastAt = Date.now();
    if (forwarder.onStatus(ev)) seen.forwarded++;
    await bridge.ensure();
  });
  await bridge.ensure();
  updateItem();
  /** With the panel in view, hides the right sidebar (and forgets the report, so the next press shows the panel). */
  const hideIfInView = async () => {
    if (!panelApi.inView() || !(await hideRightSidebar(orca, log))) return false;
    panelApi.forgetView();
    return true;
  };
  // The status bar button, the shortcut and the palette toggle the Agent Deck panel: in view, they hide the right
  // sidebar (`commands.run`, which needs the workspace:write capability; Orca's API cannot hide a single panel);
  // otherwise B shows the panel, which opens the key of the pane Orca has focused, if it is on one.
  orca.commands.register('deck.map', async () => {
    log(
      `panel toggle: in view ${panelApi.inView()} (last report ${panelApi.viewAge() ?? 'none'} ms ago)`,
    );
    if (await hideIfInView()) return 'Agent Deck panel hidden (the right sidebar)';
    await bridge.ensure();
    await new Promise((r) => setTimeout(r, 300));
    const { state, deck } = bridge.status();
    if (state !== 'connected') return 'Stream Deck plugin not running';
    if (!deck?.connected) return 'Stream Deck not connected';
    const opened = await panelApi.open(PANEL_ID);
    if (!opened.ok) {
      log(`panel not opened (${opened.reason})`);
      return 'Could not open the Agent Deck panel: open it from the sidebar';
    }
    panelApi.opened();
    return 'Agent Deck panel';
  });
  orca.commands.register('deck.status', async () => {
    await bridge.ensure();
    await new Promise((r) => setTimeout(r, 300));
    const { state, deck, versionNote } = bridge.status();
    if (versionNote) log(`status: update Agent Deck for Orca: ${versionNote}`);
    // Never a toast or OS notification: the deck is the attention surface and notifications may be off.
    // Counts and ages only, never pane titles, terminal content or the bridge token.
    const ago = (t) => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : 'none yet');
    log(`status: ${label[state] ?? state}`);
    log(
      `status: plugin ${PLUGIN_VERSION}, ${orca.api ? `Orca plugin api ${orca.api.major}.${orca.api.minor}` : 'api unknown'}, worker up ${Math.round((Date.now() - seen.wokeAt) / 1000)}s`,
    );
    log(
      deck
        ? `status: Stream Deck app ${deck.connected ? 'connected' : 'not connected'}, ${deck.devices.length} device(s)${deck.devices.map((d) => ` ${d.model}/${d.keys} keys`).join(',')}`
        : `status: no Stream Deck plugin link (discovery file ${bridge.discoveryPath})`,
    );
    log(
      `status: agent events ${seen.status} (${seen.forwarded} forwarded), last ${ago(seen.lastAt)}; ${forwarder.size()} pane(s) tracked`,
    );
    log(`status: log file ${logPath()}; also: orca plugin logs 1am.agent-deck`);
    // Orca's Logs pane never shows orca.log output, but it shows a returned string (max 200 chars)
    // as the toast description of the palette command. This is the visible result.
    return statusSummary({ state, deck, seen, tracked: forwarder.size(), ago, versionNote });
  });
}
