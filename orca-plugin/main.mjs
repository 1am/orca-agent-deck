// Orca Agent Deck plugin A (trusted-worker). Single ESM file, no dependencies.
// Finds plugin B (the Stream Deck plugin) through its discovery file, proves the shared token,
// forwards agent status and workspace events, and reconnects on every activate.
// Never log tokens or terminal content.
import net from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROTOCOL_VERSION = 1;
export const PLUGIN_VERSION = '0.1.0';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const defaultDiscoveryPath = () =>
  process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'orca-deck', 'bridge.json')
    : join(homedir(), '.orca-deck', 'bridge.json');

/** Regular file (no symlink) of the current user, not readable by group or other. Mirrors B's check. */
export async function isPrivateFile(path) {
  if (process.platform === 'win32') return true;
  try {
    const st = await lstat(path);
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
}) {
  let ws = null;
  let state = 'disconnected';
  let timer = null;
  let deck = null;
  let stopped = false;
  let delay = retryMs;

  const setState = (s) => {
    if (s !== state) log(`bridge: ${state} -> ${s}`);
    state = s;
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
            }),
          );
        } else if (!proven) {
          return;
        } else if (msg?.type === 'helloAck') {
          setState('connected');
          delay = retryMs;
          deck = msg.deck ?? null;
          log('connected to Orca Agent Deck');
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
        if (state !== 'b-not-running') setState('disconnected');
        deck = null;
        schedule();
      },
    });
    // An older Stream Deck plugin never sends a challenge; anything else on the port may say nothing.
    const deadline = setTimeout(() => {
      if (proven) return;
      log(
        challenge
          ? 'bridge: the peer on the bridge port sent no proof, closing'
          : 'bridge: no challenge on the bridge port (Stream Deck plugin older than this one, or not Orca Agent Deck), closing',
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
    status: () => ({ state, deck }),
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

const logFile = join(homedir(), '.orca-deck', 'plugin-a.log');
const fileLog = (msg) =>
  mkdir(join(homedir(), '.orca-deck'), { recursive: true })
    .then(() => appendFile(logFile, `${new Date().toISOString()} ${msg}\n`))
    .catch(() => {});

const label = {
  connected: 'Orca plugin connected',
  connecting: 'Connecting to the Stream Deck plugin',
  'b-not-running': 'Stream Deck plugin not running',
  disconnected: 'Disconnected from the Stream Deck plugin',
};

/** One-line status for the command toast, within Orca's 200 character limit; ends with the log file. */
export function statusSummary({ state, deck, seen, tracked, ago }) {
  const link = !deck
    ? 'no Stream Deck plugin link'
    : `Stream Deck app ${deck.connected ? 'connected' : 'not connected'}, ${deck.devices.length} device(s)`;
  const tail = ' Log: ~/.orca-deck/plugin-a.log';
  const body = `${label[state] ?? state}. ${link}. Events ${seen.status} (${seen.forwarded} fwd), last ${ago(seen.lastAt)}; ${tracked} pane(s).`;
  return body.slice(0, 200 - tail.length) + tail;
}

export default async function activate(orca) {
  const log = (m) => {
    orca.log?.(m);
    void fileLog(m);
  };
  // The worker idles out and is restarted by the next event: reconnect on every activate.
  let forwarder;
  // activate() gets no app version, only the plugin API version; B reads the app version itself.
  const pairing = { id: null, last: null };
  const bridge = createBridge({
    orcaVersion: orca.api ? `api ${orca.api.major}.${orca.api.minor}` : 'unknown',
    log,
    onAck: () => forwarder?.replay(),
    onMessage: (msg) => {
      if (msg.type === 'requestSnapshot') forwarder?.replay();
      else if (msg.type === 'pairResult' && msg.requestId === pairing.id) {
        pairing.id = null;
        pairing.last = msg.ok
          ? `mapped to key ${msg.slot?.index} (page ${msg.slot?.page})`
          : msg.reason;
        log(`pairing: ${msg.ok ? pairing.last : `not mapped (${msg.reason})`}`);
      }
    },
  });
  forwarder = createForwarder(bridge);
  const seen = { status: 0, forwarded: 0, workspace: 0, lastAt: 0, wokeAt: Date.now() };
  log(`worker started: plugin ${PLUGIN_VERSION}, ${bridge.status().state}`);
  // The event that woke a lazy worker arrives right after activate(); keep it even if B is down.
  orca.events.on('agent.status.changed', async (ev) => {
    seen.status++;
    seen.lastAt = Date.now();
    if (forwarder.onStatus(ev)) seen.forwarded++;
    await bridge.ensure();
  });
  orca.events.on?.('workspace.created', (ev) => {
    seen.workspace++;
    forwarder.onWorkspace('created', ev);
  });
  orca.events.on?.('workspace.removed', (ev) => {
    seen.workspace++;
    forwarder.onWorkspace('removed', ev);
  });
  await bridge.ensure();
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
    return type === 'pairRequest'
      ? 'Press a key on the deck to map this pane'
      : 'Unmapping this pane';
  };
  orca.commands.register('deck.map', sendPairing('pairRequest'));
  orca.commands.register('deck.unmap', sendPairing('unmapRequest'));
  orca.commands.register('deck.status', async () => {
    await bridge.ensure();
    await new Promise((r) => setTimeout(r, 300));
    const { state, deck } = bridge.status();
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
    log(`status: log file ${logFile}; also: orca plugin logs 1am.agent-deck`);
    // Orca's Logs pane never shows orca.log output, but it shows a returned string (max 200 chars)
    // as the toast description of the palette command. This is the visible result.
    return statusSummary({ state, deck, seen, tracked: forwarder.size(), ago });
  });
}
