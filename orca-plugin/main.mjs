// Agent Deck for Orca plugin A (trusted-worker). Single ESM file, no dependencies.
// Finds plugin B (the Stream Deck plugin) through its discovery file, proves the shared token,
// forwards agent status and workspace events, and reconnects on every activate.
// Never log tokens or terminal content.
import net from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

export const PROTOCOL_VERSION = 1;
/** Additive features of this major: 1 = the deck grid for the sidebar panel, 2 = B opens that panel for us (see docs/bridge-protocol.md). */
export const PROTOCOL_MINOR = 2;
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
      return schedule();
    }
    if (stopped || ws) return;
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
 * Forwards status and workspace events and replays the last known state of every pane after a
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
    onWorkspace(event, ev) {
      const workspaceId = ev?.workspaceId ?? ev?.id;
      if (typeof workspaceId !== 'string') return false;
      return forward({
        v: PROTOCOL_VERSION,
        type: 'workspace',
        event,
        workspaceId,
        path: typeof ev?.path === 'string' ? ev.path : '',
      });
    },
    replay() {
      for (const msg of lastByPane.values()) forward(msg);
      return lastByPane.size;
    },
    size: () => lastByPane.size,
  };
}

const logPath = () => join(deckDataDir(here()), 'plugin-a.log');
// After "Uninstall" nothing may write the data dir again.
let uninstalled = false;
const fileLog = (msg) =>
  uninstalled
    ? Promise.resolve()
    : mkdir(dirname(logPath()), { recursive: true })
        .then(() => appendFile(logPath(), `${new Date().toISOString()} ${msg}\n`))
        .catch(() => {});

/**
 * Removes the Agent Deck for Orca data dir (bridge.json, mappings.json, this plugin's log) and nothing else: the target must be
 * exactly what `deckDataDir` says and end in `orca-deck` or `.orca-deck`, never the home dir or a root.
 */
export async function removeDeckData(target, h = here(), remove = rm) {
  const want = deckDataDir(h);
  const p = h.platform === 'win32' ? win32 : posix;
  const name = p.basename(want);
  if (
    target !== want ||
    (name !== 'orca-deck' && name !== '.orca-deck') ||
    want === h.homedir ||
    p.dirname(want) === want
  )
    throw new Error(`refusing to remove ${String(target)}`);
  await remove(want, { recursive: true, force: true });
  return want;
}

/** The second "Uninstall" run must come within this long after the first. */
export const UNINSTALL_CONFIRM_MS = 10_000;

/** What the "Uninstall" toast says (max 200 characters): the data is gone, the two plugins are removed by hand. */
export const uninstallText = (dir) =>
  `Removed ${dir}. Remove the Stream Deck plugin too, or it recreates your mappings (Elgato app: Preferences, Plugins; OpenDeck: Plugins), then this plugin in Orca Settings.`.slice(
    0,
    200,
  );

/**
 * "Record events": an opt-in capture of what Orca sends this plugin and what crosses the bridge, in the input format of
 * `pnpm replay:record` (docs/replay.md). Sanitized before anything is written: fields that carry terminal content or
 * credentials are dropped by name and secret-looking strings are replaced, so none of it is ever on disk. The two
 * lists mirror `DROP_KEYS` in packages/fake-orca/src/replay/record.ts; a test keeps them equal.
 */
export const RECORD_DROP_KEYS = [
  'lastassistantmessage',
  'lastmessage',
  'message',
  'preview',
  'content',
  'text',
  'output',
  'prompt',
  'title',
  'path',
  'authtoken',
  'token',
  'secret',
  'password',
  'nonce',
  'mac',
];
/** 32 or more hex characters, or a long base64-ish run. */
export const RECORD_SECRET_LIKE = /^(?:[0-9a-f]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})$/i;

export function sanitizeForRecording(value) {
  if (Array.isArray(value)) return value.map(sanitizeForRecording);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value))
      if (!RECORD_DROP_KEYS.includes(k.toLowerCase())) out[k] = sanitizeForRecording(v);
    return out;
  }
  return typeof value === 'string' && RECORD_SECRET_LIKE.test(value) ? '<redacted>' : value;
}

/**
 * What is written is an allow-list, the drop pass above is the second line of defence. The fields are the ones the
 * plugin itself reads (`toAgentStatus`, `onWorkspace`) and the replay schema needs; anything else Orca adds (a
 * branch name, a terminal handle, a title, a path) never reaches the file. A value is kept only when it is a
 * string, number, boolean or null; a spec of `1` means "this field", an object means "these fields of it".
 */
export const RECORD_EVENT_FIELDS = {
  'agent.status.changed': {
    workspaceId: 1,
    paneKey: 1,
    state: 1,
    receivedAt: 1,
    agentType: 1,
    mainAgent: { state: 1, outcome: 1, stateStartedAt: 1, agentType: 1 },
  },
  'workspace.created': { workspaceId: 1, id: 1, kind: 1 },
  'workspace.removed': { workspaceId: 1, id: 1, kind: 1 },
};
/** Per frame type of the bridge; a type not listed keeps only `v` and `type`. */
export const RECORD_FRAME_FIELDS = {
  agentStatus: {
    v: 1,
    type: 1,
    paneKey: 1,
    workspaceId: 1,
    state: 1,
    outcome: 1,
    stateStartedAt: 1,
    receivedAt: 1,
    agentType: 1,
  },
  workspace: { v: 1, type: 1, event: 1, workspaceId: 1 },
  pairRequest: { v: 1, type: 1, requestId: 1, pane: 1 },
  unmapRequest: { v: 1, type: 1, requestId: 1, pane: 1 },
  pairCancel: { v: 1, type: 1, requestId: 1 },
  requestSnapshot: { v: 1, type: 1 },
  pairResult: {
    v: 1,
    type: 1,
    requestId: 1,
    ok: 1,
    reason: 1,
    action: 1,
    slot: { index: 1, page: 1 },
  },
  assignKey: { v: 1, type: 1, requestId: 1, key: 1, replace: 1, paneKey: 1 },
  unmapKey: { v: 1, type: 1, requestId: 1, key: 1 },
  openPanel: { v: 1, type: 1, requestId: 1, panelId: 1 },
  openPanelResult: { v: 1, type: 1, requestId: 1, ok: 1, reason: 1 },
  // No labels: they are pane names.
  deckState: { v: 1, type: 1, connected: 1, cols: 1, rows: 1 },
};
const RECORD_FRAME_DEFAULT = { v: 1, type: 1 };

export function pickFields(value, spec) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [k, want] of Object.entries(spec)) {
    const v = value[k];
    if (v === undefined) continue;
    if (want === 1) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    } else if (v && typeof v === 'object') out[k] = pickFields(v, want);
  }
  return out;
}

/** A recording stops by itself after this long or this many bytes. */
export const RECORD_MAX_MS = 10 * 60 * 1000;
export const RECORD_MAX_BYTES = 5 * 1024 * 1024;

/** The recordings folder of the data dir; files are named by the start time. */
export const recordingsDir = (h = here()) => join(deckDataDir(h), 'recordings');

export function createRecorder({
  dir = recordingsDir(),
  now = Date.now,
  maxMs = RECORD_MAX_MS,
  maxBytes = RECORD_MAX_BYTES,
  onStop = () => {},
} = {}) {
  let file = null;
  let bytes = 0;
  let timer = null;
  let queue = Promise.resolve();
  // Orca kills an idle worker and starts a new one for the next event: what is recording survives in this file, so
  // the next worker keeps appending (within the same limits) and the toggle still knows a recording runs.
  const statePath = join(dir, '.active.json');
  const NAME = /^[0-9T-]+Z\.ndjson$/;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => stop('time limit reached'), ms);
    timer.unref?.();
  };
  const add = (entry) => {
    if (!file) return;
    const line = `${JSON.stringify({ ts: now(), ...sanitizeForRecording(entry) })}\n`;
    bytes += Buffer.byteLength(line);
    const target = file;
    queue = queue.then(() => appendFile(target, line, { mode: 0o600 })).catch(() => {});
    if (bytes >= maxBytes) stop('size limit reached');
  };
  function stop(why = 'stopped') {
    if (!file) return null;
    const done = file;
    file = null;
    clearTimeout(timer);
    queue = queue.then(() => rm(statePath, { force: true })).catch(() => {});
    onStop(done, why);
    return done;
  }
  return {
    get active() {
      return file !== null;
    },
    async start() {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      file = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}.ndjson`);
      bytes = 0;
      queue = Promise.resolve();
      const startedAt = now();
      arm(maxMs);
      await writeFile(statePath, JSON.stringify({ active: true, path: file, startedAt, bytes }), {
        mode: 0o600,
      });
      return file;
    },
    /**
     * Picks up the recording of the worker that went before, when its file is ours, young and small enough; otherwise
     * clears the note. Resolves to the file, or null.
     */
    async resume() {
      if (file) return file;
      let st;
      try {
        st = JSON.parse(await readFile(statePath, 'utf8'));
      } catch {
        return null;
      }
      const left = typeof st?.startedAt === 'number' ? st.startedAt + maxMs - now() : 0;
      let size = Infinity;
      // Only a file this recorder names, inside its own folder: the note is just a file and may be edited.
      const ok =
        typeof st?.path === 'string' && NAME.test(posix.basename(st.path.replaceAll('\\', '/')));
      const path = ok ? join(dir, posix.basename(st.path.replaceAll('\\', '/'))) : '';
      if (ok)
        size = await stat(path).then(
          (x) => x.size,
          () => Infinity,
        );
      if (!ok || left <= 0 || size >= maxBytes) {
        await rm(statePath, { force: true }).catch(() => {});
        return null;
      }
      file = path;
      bytes = size;
      arm(left);
      return file;
    },
    stop,
    event: (name, payload) =>
      add({
        kind: 'orca.event',
        name,
        payload: pickFields(payload, RECORD_EVENT_FIELDS[name] ?? {}),
      }),
    frame: (from, frame) =>
      add({
        kind: 'bridge.frame',
        from,
        frame: pickFields(frame, RECORD_FRAME_FIELDS[frame?.type] ?? RECORD_FRAME_DEFAULT),
      }),
    /** Resolves once every accepted line is on disk. */
    flush: () => queue,
  };
}

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
const PRESS_KEY = 'Press a key on the deck to map this pane';
const PANEL_ID = 'deck';
const MAP_TIP =
  'Agent Deck: open the panel to map the last focused terminal pane to a Stream Deck key (shortcut: Cmd+Option+K, Ctrl+Alt+K on Windows and Linux)';

/**
 * The status bar button (`contributes.statusBarItems`, id `deck`): it always runs Map pane (which opens the
 * Agent Deck panel), and its text says when that cannot work. Null while connecting, so a reconnect does not flicker.
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
  return { text: 'Agent Deck', tone: 'neutral', tooltip: MAP_TIP };
}

/** How long the panel waits for the deck's state, and for the result of a click. */
const DECK_WAIT_MS = 2000;
const RESULT_WAIT_MS = 10_000;
/** B answers `openPanel` once Orca did, or failed to. */
const OPEN_WAIT_MS = 3000;

/**
 * What the Agent Deck sidebar panel asks the worker (`plugin.request` in the panel, `orca.panels.handle`
 * here). The deck is B's: this only asks for its state and forwards clicks as `assignKey` / `unmapKey`, and
 * B checks the key and resolves the focused pane. `deckState` and `pairResult` arrive through `onMessage`.
 */
export function createPanelApi(
  bridge,
  {
    onDeck = () => {},
    onMap = () => {},
    deckWaitMs = DECK_WAIT_MS,
    resultWaitMs = RESULT_WAIT_MS,
    openWaitMs = OPEN_WAIT_MS,
  } = {},
) {
  // The panel was opened to map the focused pane: its keys assign at a click until a key is chosen or Cancel.
  let mapping = false;
  const setMapping = (on) => {
    if (mapping === on) return;
    mapping = on;
    onMap(on);
  };
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
    return current() ? { status: 'ok', deck: current(), mapping } : { status: 'update' };
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
      const r = await click({
        type: 'assignKey',
        key,
        replace: replace === true,
        ...(typeof paneKey === 'string' && paneKey ? { paneKey } : {}),
        ...(typeof hostId === 'string' && hostId ? { hostId } : {}),
      });
      if (r.ok) setMapping(false);
      return r;
    },
    /** Asks B to show the panel in Orca's sidebar (minor 2). */
    open: (panelId) => click({ type: 'openPanel', panelId }, openWaitMs, 2),
    startMap: () => setMapping(true),
    endMap: () => setMapping(false),
    get mapping() {
      return mapping;
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
      }
    },
  };
}

export default async function activate(orca) {
  uninstalled = false;
  const log = (m) => {
    orca.log?.(m);
    void fileLog(m);
  };
  // The worker idles out and is restarted by the next event: reconnect on every activate.
  let forwarder;
  const recorder = createRecorder({
    onStop: (file, why) => log(`record: ${why}, recording is in ${file}`),
  });
  const resumed = await recorder.resume();
  if (resumed) log(`record: resumed after a restart of this worker, writing to ${resumed}`);
  // activate() gets no app version, only the plugin API version; B reads the app version itself.
  const pairing = { id: null, last: null, reason: null };
  // The panel's calls are registered once the bridge exists; its messages arrive before that only if B is fast.
  let panelApi = { onMessage: () => {} };
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
    onAck: () => forwarder?.replay(),
    onChange: () => updateItem(),
    onMessage: (msg) => {
      recorder.frame('b', msg);
      panelApi.onMessage(msg);
      if (msg.type === 'deckState') {
        lastDeck = { session: bridge.status().session, connected: msg.connected === true };
        updateItem();
      }
      if (msg.type === 'requestSnapshot') forwarder?.replay();
      else if (msg.type === 'pairResult' && msg.requestId === pairing.id) {
        pairing.id = null;
        // No page: the Stream Deck SDK does not tell which profile page shows, so it is always 1.
        pairing.last = msg.ok ? `mapped to key ${msg.slot?.index}` : msg.reason;
        pairing.reason = msg.ok ? null : msg.reason;
        if (msg.ok) panelApi.endMap();
        log(`pairing: ${msg.ok ? pairing.last : `not mapped (${msg.reason})`}`);
      }
    },
  });
  // Frames A sends are recorded where they leave (the handshake does not pass here).
  const sendRaw = bridge.send;
  bridge.send = (msg) => {
    recorder.frame('a', msg);
    return sendRaw(msg);
  };
  forwarder = createForwarder(bridge);
  panelApi = createPanelApi(bridge, {
    onDeck: (state) =>
      orca.panels?.post?.('deck.changed', {
        status: 'ok',
        deck: state,
        mapping: panelApi.mapping,
      }),
    onMap: (mapping) => orca.panels?.post?.('map.changed', { mapping }),
  });
  orca.panels?.handle?.('deck.get', () => panelApi.get());
  orca.panels?.handle?.('deck.assign', (input) => panelApi.assign(input ?? {}));
  orca.panels?.handle?.('deck.unmap', (input) => panelApi.unmap(input ?? {}));
  // Another pane chosen in the panel's list: the deck's Assign-here would map the focused one, so it ends.
  orca.panels?.handle?.('deck.mapChoose', () => {
    if (pairing.id) bridge.send({ v: PROTOCOL_VERSION, type: 'pairCancel', requestId: pairing.id });
    return { ok: true };
  });
  orca.panels?.handle?.('deck.mapEnd', () => {
    panelApi.endMap();
    if (pairing.id) bridge.send({ v: PROTOCOL_VERSION, type: 'pairCancel', requestId: pairing.id });
    return { ok: true };
  });
  const seen = { status: 0, forwarded: 0, workspace: 0, lastAt: 0, wokeAt: Date.now() };
  log(`worker started: plugin ${PLUGIN_VERSION}, ${bridge.status().state}`);
  // The event that woke a lazy worker arrives right after activate(); keep it even if B is down.
  orca.events.on('agent.status.changed', async (ev) => {
    seen.status++;
    seen.lastAt = Date.now();
    recorder.event('agent.status.changed', ev);
    if (forwarder.onStatus(ev)) seen.forwarded++;
    await bridge.ensure();
  });
  orca.events.on?.('workspace.created', (ev) => {
    seen.workspace++;
    recorder.event('workspace.created', ev);
    forwarder.onWorkspace('created', ev);
  });
  orca.events.on?.('workspace.removed', (ev) => {
    seen.workspace++;
    recorder.event('workspace.removed', ev);
    forwarder.onWorkspace('removed', ev);
  });
  await bridge.ensure();
  updateItem();
  // The feedback that matters is on the deck; the returned string is only the palette toast.
  const sendPairing = (type) => async () => {
    await bridge.ensure();
    await new Promise((r) => setTimeout(r, 300));
    const { state, deck } = bridge.status();
    if (state !== 'connected') return 'Stream Deck plugin not running';
    if (!deck?.connected) return 'Stream Deck not connected';
    const requestId = randomBytes(8).toString('hex');
    if (type === 'pairRequest') {
      if (pairing.id)
        bridge.send({ v: PROTOCOL_VERSION, type: 'pairCancel', requestId: pairing.id });
      pairing.id = requestId;
    }
    bridge.send({ v: PROTOCOL_VERSION, type, requestId, pane: null });
    log(`pairing: ${type} sent`);
    if (type !== 'pairRequest') return 'Unmapping this pane';
    // B answers at once when it has no pane to map (nothing focused, none seen before): say so, nothing is pairing.
    for (let i = 0; i < 16 && pairing.id === requestId; i++)
      await new Promise((r) => setTimeout(r, 50));
    if (pairing.id !== requestId && pairing.reason === 'noFocusedPane')
      return 'Focus a terminal pane first (a paired-server pane: pick it in the Agent Deck panel)';
    if (pairing.id !== requestId && pairing.last && pairing.reason)
      return `Not mapped: ${pairing.last}`.slice(0, 200);
    return PRESS_KEY;
  };
  // The status bar button and the shortcut: pairing mode on the deck (press a key there) and the panel beside it
  // (click a key there). B opens the panel; where it cannot (an older B, no runtime), the deck alone keeps working.
  orca.commands.register('deck.map', async () => {
    const text = await sendPairing('pairRequest')();
    const opened = await panelApi.open(PANEL_ID);
    if (!opened.ok) {
      log(`pairing: panel not opened (${opened.reason}), deck only`);
      return text;
    }
    panelApi.startMap();
    return text === PRESS_KEY
      ? 'Pick a key in the Agent Deck panel, or press one on the deck'
      : text;
  });
  orca.commands.register('deck.unmap', sendPairing('unmapRequest'));
  // Orca's plugin API has no confirm dialog (and notifications stay off), so Uninstall asks twice: the first run only arms.
  let armedAt = 0;
  orca.commands.register('deck.uninstall', async () => {
    const dir = deckDataDir(here());
    if (Date.now() - armedAt > UNINSTALL_CONFIRM_MS) {
      armedAt = Date.now();
      return `Run Agent Deck: Uninstall again within ${UNINSTALL_CONFIRM_MS / 1000} s to remove ${dir} (bridge file, key mappings, recordings, this plugin's log).`.slice(
        0,
        200,
      );
    }
    armedAt = 0;
    recorder.stop('uninstall');
    bridge.stop();
    uninstalled = true;
    await removeDeckData(dir);
    orca.log?.(
      `uninstall: removed ${dir}; remove the Stream Deck plugin in the Elgato app or OpenDeck, then this plugin in Orca`,
    );
    return uninstallText(dir);
  });
  // A toggle: the first run starts a recording, the second stops it and says where the file is.
  orca.commands.register('deck.record', async () => {
    if (recorder.active) {
      const file = recorder.stop('stopped by the command');
      await recorder.flush();
      return `Recording stopped: ${file}`.slice(0, 200);
    }
    const file = await recorder.start();
    log(`record: started, writing to ${file}`);
    return `Recording events to ${file}. Run Agent Deck: Record events again to stop (it stops by itself after 10 min or 5 MB).`.slice(
      0,
      200,
    );
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
      `status: agent events ${seen.status} (${seen.forwarded} forwarded), last ${ago(seen.lastAt)}; ${forwarder.size()} pane(s) tracked; workspace events ${seen.workspace}`,
    );
    log(`status: log file ${logPath()}; also: orca plugin logs 1am.agent-deck`);
    // Orca's Logs pane never shows orca.log output, but it shows a returned string (max 200 chars)
    // as the toast description of the palette command. This is the visible result.
    return statusSummary({ state, deck, seen, tracked: forwarder.size(), ago, versionNote });
  });
}
