import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PORT_RANGE,
  defaultDiscoveryPath,
  removeDiscovery,
  writeDiscovery,
  type Discovery,
} from './discovery.ts';
import {
  PROTOCOL_VERSION,
  UnsupportedVersionError,
  parseFromA,
  type MessageFromA,
  type MessageFromB,
} from './protocol.ts';

export type DeckInfo = Extract<MessageFromB, { type: 'helloAck' }>['deck'];

export interface BridgeServerOptions {
  discoveryPath?: string;
  /** Candidate ports, first free wins. */
  ports?: readonly number[];
  /** Reported to A in `helloAck`. */
  deck?: () => DeckInfo;
  /** Metadata only. Never pass terminal content or tokens to the log. */
  log?: (msg: string) => void;
}

export type ConnectionInfo = { orcaVersion: string; pluginVersion: string };

type Listener = {
  hello: (info: ConnectionInfo) => void;
  message: (msg: MessageFromA) => void;
  disconnect: () => void;
};

const defaultPorts = Array.from(
  { length: PORT_RANGE.last - PORT_RANGE.first + 1 },
  (_, i) => PORT_RANGE.first + i,
);

/**
 * Plugin B side of the bridge. Long-lived WebSocket server on loopback.
 * A (inside Orca) is a client that may come and go: the worker idles out and
 * reconnects on wake, so a disconnect is normal and keeps the last known state.
 */
export class BridgeServer {
  readonly token = randomBytes(32).toString('hex');
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private info: ConnectionInfo | null = null;
  private readonly listeners: { [K in keyof Listener]: Listener[K][] } = {
    hello: [],
    message: [],
    disconnect: [],
  };
  private discoveryPath: string;

  private readonly opts: BridgeServerOptions;

  constructor(opts: BridgeServerOptions = {}) {
    this.opts = opts;
    this.discoveryPath = opts.discoveryPath ?? defaultDiscoveryPath();
  }

  /** Last A that said hello, or null while none is connected. */
  get connection(): ConnectionInfo | null {
    return this.socket ? this.info : null;
  }

  on<K extends keyof Listener>(event: K, fn: Listener[K]): () => void {
    (this.listeners[event] as Listener[K][]).push(fn);
    return () => {
      const l = this.listeners[event] as Listener[K][];
      l.splice(l.indexOf(fn), 1);
    };
  }

  /** Sends to the connected A. Returns false when none is connected. */
  send(msg: MessageFromB): boolean {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  async start(): Promise<Discovery> {
    const ports = this.opts.ports ?? defaultPorts;
    let lastError: unknown;
    for (const port of ports) {
      try {
        this.wss = await listen(port);
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!this.wss) throw new Error(`no free bridge port: ${String(lastError)}`);
    const address = this.wss.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    this.wss.on('connection', (ws) => this.accept(ws));
    const discovery: Discovery = { v: PROTOCOL_VERSION, port, token: this.token, pid: process.pid };
    await writeDiscovery(this.discoveryPath, discovery);
    this.opts.log?.(`bridge listening on 127.0.0.1:${port}`);
    return discovery;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    await removeDiscovery(this.discoveryPath);
    if (!wss) return;
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }

  /** When a plugin A last said hello without the challenge handshake (an older release), else null. */
  outdatedPeerAt: number | null = null;

  /** Connections that have not said hello yet, oldest first. */
  private readonly pending: WebSocket[] = [];

  private accept(ws: WebSocket): void {
    let authed = false;
    // Set once A answered B's challenge correctly; only then is `hello` accepted.
    let proven = false;
    // Unauthenticated sockets cannot lock A out: the oldest one makes room for a new one.
    this.pending.push(ws);
    if (this.pending.length > MAX_PENDING) this.pending.shift()?.close(4004, 'evicted');
    const settle = () => {
      const i = this.pending.indexOf(ws);
      if (i >= 0) this.pending.splice(i, 1);
    };
    const nonce = newNonce();
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'challenge', nonce }));
    // A silent client must not hold a slot: A answers within milliseconds.
    const helloTimer = setTimeout(() => !authed && ws.close(4000, 'hello timeout'), HELLO_MS);
    ws.on('message', (data) => {
      let msg: MessageFromA;
      try {
        msg = parseFromA(JSON.parse(String(data)));
      } catch (e) {
        if (e instanceof UnsupportedVersionError) {
          this.opts.log?.(`unsupported protocol version from A: ${String(e.received)}`);
          // Reported like an A from before the handshake: the Setup doctor says to update.
          this.outdatedPeerAt = Date.now();
          ws.close(4002, 'unsupported protocol version');
        } else if (!authed) {
          ws.close(4001, 'unauthorized');
        } else {
          this.opts.log?.('malformed message from A ignored');
        }
        return;
      }
      if (!authed) {
        if (msg.type === 'auth' && !proven) {
          if (
            !NONCE.test(msg.nonce) ||
            !macMatches(msg.mac, authMac(this.token, nonce, msg.nonce))
          ) {
            ws.close(4001, 'unauthorized');
            return;
          }
          proven = true;
          ws.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'proof',
              mac: proofMac(this.token, msg.nonce, nonce),
            }),
          );
          return;
        }
        if (msg.type !== 'hello' || !proven) {
          // An A from before the handshake sends hello at once: tell the user to update it.
          if (msg.type === 'hello') this.outdatedPeerAt = Date.now();
          ws.close(4001, 'unauthorized');
          return;
        }
        authed = true;
        settle();
        clearTimeout(helloTimer);
        // A newer connection replaces the old one (worker restarted).
        if (this.socket && this.socket !== ws) this.socket.close(4003, 'replaced');
        this.socket = ws;
        this.info = { orcaVersion: msg.orcaVersion, pluginVersion: msg.pluginVersion };
        this.opts.log?.(`A connected: Orca ${msg.orcaVersion}, plugin ${msg.pluginVersion}`);
        this.send({
          v: PROTOCOL_VERSION,
          type: 'helloAck',
          deck: this.opts.deck?.() ?? { connected: false, devices: [] },
        });
        for (const fn of this.listeners.hello) fn(this.info);
        return;
      }
      for (const fn of this.listeners.message) fn(msg);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      settle();
      if (this.socket !== ws) return;
      this.socket = null;
      this.opts.log?.('A disconnected (idle or restarted), keeping last known state');
      for (const fn of this.listeners.disconnect) fn();
    });
    ws.on('error', () => ws.terminate());
  }
}

/** Largest frame accepted from A; status messages are well under 1 KiB. */
export const MAX_PAYLOAD = 256 * 1024;

/** Unauthenticated connections held at once; a new one evicts the oldest. */
export const MAX_PENDING = 2;
/** Time a new connection has to finish the handshake. */
export const HELLO_MS = 2000;

/** Nonces are 16 random bytes as hex on both sides; anything else is refused. */
export const NONCE = /^[0-9a-f]{32}$/;
export const newNonce = () => randomBytes(16).toString('hex');

/**
 * Handshake MACs: HMAC-SHA256 over a direction label and two fixed-length nonces, so an answer
 * can neither be reflected nor spliced into another session. A sends authMac(B's nonce, A's
 * nonce), B answers proofMac(A's nonce, B's nonce). orca-plugin/main.mjs mirrors these.
 */
export const authMac = (token: string, nonceB: string, nonceA: string) =>
  createHmac('sha256', token)
    .update('orca-deck/auth/v1')
    .update(nonceB)
    .update(nonceA)
    .digest('hex');
export const proofMac = (token: string, nonceA: string, nonceB: string) =>
  createHmac('sha256', token)
    .update('orca-deck/proof/v1')
    .update(nonceA)
    .update(nonceB)
    .digest('hex');

function macMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

/**
 * Only plugin A may connect. Browsers always send an `Origin` on a WebSocket upgrade and A's
 * raw node:net client never does, so a web page on this machine is turned away before it can
 * even try a token. The loopback bind already keeps other machines out; the address is checked too.
 */
export function acceptUpgrade(info: {
  origin?: string;
  remoteAddress?: string;
  host?: string;
  port?: number;
}): boolean {
  if (info.origin) return false;
  // A DNS rebinding page sends its own hostname here, A sends the literal address.
  if (info.host !== `127.0.0.1:${info.port}`) return false;
  return info.remoteAddress !== undefined && LOOPBACK.has(info.remoteAddress);
}

function listen(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      maxPayload: MAX_PAYLOAD,
      verifyClient: (info: {
        origin?: string;
        req: { headers: { host?: string }; socket: { remoteAddress?: string; localPort?: number } };
      }) =>
        acceptUpgrade({
          origin: info.origin,
          remoteAddress: info.req.socket.remoteAddress,
          host: info.req.headers.host,
          port: info.req.socket.localPort,
        }),
    });
    wss.once('listening', () => resolve(wss));
    wss.once('error', reject);
  });
}
