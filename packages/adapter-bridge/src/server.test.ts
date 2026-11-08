import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { isPrivateFile, readDiscovery } from './discovery.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import {
  BridgeServer,
  MAX_PAYLOAD,
  MAX_PENDING,
  acceptUpgrade,
  authMac,
  proofMac,
} from './server.ts';

// Plugin A is plain JS that ships inside Orca, so it is loaded by path to stay untyped.
const pluginPath = new URL('../../../orca-plugin/main.mjs', import.meta.url);
const plugin = (await import(pathToFileURL(pluginPath.pathname).href)) as {
  createBridge: (o: Record<string, unknown>) => {
    ensure: () => Promise<void>;
    status: () => { state: string; deck: unknown };
    stop: () => void;
    send: (m: object) => boolean;
  };
  createForwarder: (b: { send: (m: object) => boolean }) => {
    onStatus: (ev: object) => boolean;
    onWorkspace: (e: string, ev: object) => boolean;
    replay: () => number;
    size: () => number;
  };
  toAgentStatus: (ev: object, now?: number) => Record<string, unknown> | null;
  default: (orca: unknown) => Promise<void>;
};

let dir: string;
let discoveryPath: string;
let server: BridgeServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridge-'));
  discoveryPath = join(dir, 'bridge.json');
  server = new BridgeServer({
    discoveryPath,
    ports: [0],
    deck: () => ({ connected: true, devices: [{ model: 'Mobile', keys: 15 }] }),
  });
});
afterEach(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const hello = (extra: object = {}) =>
  JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'hello',
    orcaVersion: '1.4.245',
    pluginVersion: '0.1.0',
    ...extra,
  });
const NA = 'a'.repeat(32);
const authMsg = (nonce: string, m: string) =>
  JSON.stringify({ v: PROTOCOL_VERSION, type: 'auth', nonce, mac: m });

/** What plugin A does: answer the challenge, check nothing, then say hello. */
async function login(c: ReturnType<typeof rawClient>, token: string, extra: object = {}) {
  await until(() => c.nonce() !== '');
  c.ws.send(authMsg(NA, authMac(token, c.nonce(), NA)));
  await until(() => c.messages.length > 0 || c.code() !== 0);
  if (c.code() === 0) c.ws.send(hello(extra));
}

function rawClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: unknown[] = [];
  let closeCode = 0;
  let challenge = '';
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'challenge') challenge = m.nonce;
    else messages.push(m);
  });
  ws.on('close', (c) => (closeCode = c));
  ws.on('error', () => {});
  return {
    ws,
    messages,
    nonce: () => challenge,
    code: () => closeCode,
    open: () => new Promise((r) => ws.once('open', r)),
  };
}

describe('discovery file', () => {
  it('is written with mode 0600 and holds port, token and pid', async () => {
    const d = await server.start();
    expect(await readDiscovery(discoveryPath)).toEqual(d);
    expect(d.pid).toBe(process.pid);
    expect(d.token).toHaveLength(64);
    if (process.platform !== 'win32') {
      expect((await stat(discoveryPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('is removed on stop and the token rotates on every start', async () => {
    const first = await server.start();
    await server.stop();
    await expect(readFile(discoveryPath)).rejects.toThrow();
    const second = new BridgeServer({ discoveryPath, ports: [0] });
    const d = await second.start();
    await second.stop();
    expect(d.token).not.toBe(first.token);
  });

  it('skips a busy port and takes the next free one', async () => {
    const a = new BridgeServer({ discoveryPath: join(dir, 'a.json'), ports: [0] });
    const { port } = await a.start();
    const b = new BridgeServer({ discoveryPath: join(dir, 'b.json'), ports: [port, 0] });
    const d = await b.start();
    await Promise.all([a.stop(), b.stop()]);
    expect(d.port).not.toBe(port);
  });

  it('creates the discovery dir as 0700 and fixes a looser existing one', async () => {
    if (process.platform === 'win32') return;
    const sub = join(dir, 'deck');
    const s1 = new BridgeServer({ discoveryPath: join(sub, 'bridge.json'), ports: [0] });
    await s1.start();
    expect((await stat(sub)).mode & 0o777).toBe(0o700);
    await s1.stop();
    await chmod(sub, 0o755);
    await s1.start();
    expect((await stat(sub)).mode & 0o777).toBe(0o700);
    await s1.stop();
  });

  it('readDiscovery refuses a symlink and a group or world readable file', async () => {
    if (process.platform === 'win32') return;
    const d = await server.start();
    const link = join(dir, 'link.json');
    await symlink(discoveryPath, link);
    expect(await readDiscovery(link)).toBeNull();
    const loose = join(dir, 'loose.json');
    await writeFile(loose, JSON.stringify(d), { mode: 0o644 });
    await chmod(loose, 0o644);
    expect(await readDiscovery(loose)).toBeNull();
    expect(await isPrivateFile(loose)).toBe(false);
    expect(await isPrivateFile(discoveryPath)).toBe(true);
  });

  it('plugin A will not use a discovery file that is world readable', async () => {
    if (process.platform === 'win32') return;
    await server.start();
    await chmod(discoveryPath, 0o644);
    const a = plugin.createBridge({ orcaVersion: 'x', discoveryPath, retryMs: 60_000 });
    await a.ensure();
    expect(a.status().state).toBe('b-not-running');
    a.stop();
  });

  it('readDiscovery returns null for a missing or garbled file', async () => {
    expect(await readDiscovery(join(dir, 'nope.json'))).toBeNull();
  });
});

describe('server handshake', () => {
  it('acks a valid hello with the deck state and reports the connection', async () => {
    const { port, token } = await server.start();
    const onHello = vi.fn();
    server.on('hello', onHello);
    const c = rawClient(port);
    await c.open();
    await login(c, token);
    await until(() => c.messages.length > 1);
    expect(c.messages[1]).toEqual({
      v: 1,
      type: 'helloAck',
      deck: { connected: true, devices: [{ model: 'Mobile', keys: 15 }] },
    });
    expect(onHello).toHaveBeenCalledWith({ orcaVersion: '1.4.245', pluginVersion: '0.1.0' });
    expect(server.connection).toEqual({ orcaVersion: '1.4.245', pluginVersion: '0.1.0' });
  });

  it('closes a hello without a proof, even one carrying the token, with 4001', async () => {
    const { port, token } = await server.start();
    expect(server.outdatedPeerAt).toBeNull();
    const c = rawClient(port);
    await c.open();
    c.ws.send(hello({ token }));
    await until(() => c.code() !== 0);
    expect(c.code()).toBe(4001);
    expect(server.connection).toBeNull();
    expect(server.outdatedPeerAt).not.toBeNull();
  });

  it('refuses a browser upgrade (Origin header) before any token is tried', async () => {
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://example.com' });
    const status = await new Promise<number | undefined>((r) => {
      ws.on('unexpected-response', (_req, res) => r(res.statusCode));
      ws.on('open', () => r(undefined));
      ws.on('error', () => {});
    });
    expect(status).toBe(401);
  });

  it('accepts only loopback peers without an Origin', () => {
    const ok = { remoteAddress: '127.0.0.1', host: '127.0.0.1:47800', port: 47800 };
    expect(acceptUpgrade(ok)).toBe(true);
    expect(acceptUpgrade({ ...ok, remoteAddress: '::1' })).toBe(true);
    expect(acceptUpgrade({ ...ok, remoteAddress: '192.168.1.5' })).toBe(false);
    expect(acceptUpgrade({ ...ok, origin: 'null' })).toBe(false);
    expect(acceptUpgrade({})).toBe(false);
  });

  it('rejects a wrong Host header with 401 (DNS rebinding)', async () => {
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Host: `evil.test:${port}` } });
    const status = await new Promise<number | undefined>((r) => {
      ws.on('unexpected-response', (_req, res) => r(res.statusCode));
      ws.on('open', () => r(undefined));
      ws.on('error', () => {});
    });
    expect(status).toBe(401);
  });

  it('silent connections cannot lock A out: a new one evicts the oldest pending one', async () => {
    const { port, token } = await server.start();
    const squatters = Array.from({ length: MAX_PENDING }, () => rawClient(port));
    await Promise.all(squatters.map((q) => q.open()));
    const c = rawClient(port);
    await c.open();
    await until(() => squatters[0]!.code() === 4004);
    await login(c, token);
    await until(() => server.connection !== null);
    for (const q of squatters) q.ws.close();
  });

  it('compares MACs of equal and different length without accepting a prefix', async () => {
    const { port, token } = await server.start();
    for (const bad of [(m: string) => m.slice(0, -1), (m: string) => `${m}0`, () => '']) {
      const c = rawClient(port);
      await c.open();
      await until(() => c.nonce() !== '');
      c.ws.send(authMsg(NA, bad(authMac(token, c.nonce(), NA))));
      await until(() => c.code() !== 0);
      expect(c.code()).toBe(4001);
    }
  });

  it('refuses an A nonce that is not 32 hex characters (no splicing into the MAC input)', async () => {
    const { port, token } = await server.start();
    const c = rawClient(port);
    await c.open();
    await until(() => c.nonce() !== '');
    c.ws.send(authMsg(`${NA}00`, authMac(token, c.nonce(), `${NA}00`)));
    await until(() => c.code() !== 0);
    expect(c.code()).toBe(4001);
  });

  it('closes a client that sends a frame over the size cap', async () => {
    const { port } = await server.start();
    const c = rawClient(port);
    await c.open();
    c.ws.send('x'.repeat(MAX_PAYLOAD + 1));
    await until(() => c.code() !== 0);
    // ws drops the socket (1006) or sends "message too big" (1009), depending on timing.
    expect([1006, 1009]).toContain(c.code());
    expect(server.connection).toBeNull();
  });

  it('closes a client whose first message is not hello', async () => {
    const { port } = await server.start();
    const c = rawClient(port);
    await c.open();
    c.ws.send(JSON.stringify({ v: 1, type: 'requestSnapshot' }));
    await until(() => c.code() !== 0);
    expect(c.code()).toBe(4001);
  });

  it('closes an unsupported protocol version with 4002', async () => {
    const { port } = await server.start();
    const c = rawClient(port);
    await c.open();
    c.ws.send(hello({ v: 2 }));
    await until(() => c.code() !== 0);
    expect(c.code()).toBe(4002);
  });

  it('ignores garbage without dropping a connected A', async () => {
    const { port, token } = await server.start();
    const c = rawClient(port);
    await c.open();
    await login(c, token);
    await until(() => server.connection !== null);
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ v: 1, type: 'agentStatus' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connection).not.toBeNull();
  });

  it('keeps last state info only while connected and a new A replaces the old one', async () => {
    const { port, token } = await server.start();
    const onDisconnect = vi.fn();
    server.on('disconnect', onDisconnect);
    const first = rawClient(port);
    await first.open();
    await login(first, token);
    await until(() => server.connection !== null);
    const second = rawClient(port);
    await second.open();
    await login(second, token, { pluginVersion: '0.2.0' });
    await until(() => first.code() === 4003);
    expect(server.connection?.pluginVersion).toBe('0.2.0');
    // the replaced socket closing must not look like a disconnect of the live one
    expect(onDisconnect).not.toHaveBeenCalled();
    second.ws.close();
    await until(() => onDisconnect.mock.calls.length === 1);
    expect(server.connection).toBeNull();
  });

  it('forwards authenticated messages to listeners and send() reaches A', async () => {
    const { port, token } = await server.start();
    const onMessage = vi.fn();
    server.on('message', onMessage);
    const c = rawClient(port);
    await c.open();
    expect(server.send({ v: 1, type: 'requestSnapshot' })).toBe(false);
    await login(c, token);
    await until(() => server.connection !== null);
    c.ws.send(JSON.stringify({ v: 1, type: 'pairCancel', requestId: 'r1' }));
    await until(() => onMessage.mock.calls.length === 1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'pairCancel', requestId: 'r1' });
    expect(server.send({ v: 1, type: 'requestSnapshot' })).toBe(true);
    await until(() => c.messages.length === 3);
    expect(c.messages[2]).toEqual({ v: 1, type: 'requestSnapshot' });
  });
});

describe('challenge-response handshake', () => {
  it('proves both sides, then accepts a hello without any token', async () => {
    const { port, token } = await server.start();
    const c = rawClient(port);
    await c.open();
    await until(() => c.nonce() !== '');
    c.ws.send(authMsg(NA, authMac(token, c.nonce(), NA)));
    await until(() => c.messages.length === 1);
    expect(c.messages[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: 'proof',
      mac: proofMac(token, NA, c.nonce()),
    });
    expect(server.connection).toBeNull();
    c.ws.send(hello());
    await until(() => server.connection !== null);
    await until(() => c.messages.length === 2);
    expect(c.messages[1]).toMatchObject({ type: 'helloAck' });
  });

  it('closes a wrong HMAC with 4001 and gives no proof', async () => {
    const { port, token } = await server.start();
    const c = rawClient(port);
    await c.open();
    await until(() => c.nonce() !== '');
    c.ws.send(authMsg(NA, authMac(`${token}x`, c.nonce(), NA)));
    await until(() => c.code() !== 0);
    expect(c.code()).toBe(4001);
    expect(c.messages).toEqual([]);
  });

  it('rejects the answer recorded from an earlier connection (fresh nonce each time)', async () => {
    const { port, token } = await server.start();
    const first = rawClient(port);
    await first.open();
    await until(() => first.nonce() !== '');
    const recorded = authMsg(NA, authMac(token, first.nonce(), NA));
    first.ws.close();
    const second = rawClient(port);
    await second.open();
    await until(() => second.nonce() !== '');
    expect(second.nonce()).not.toBe(first.nonce());
    second.ws.send(recorded);
    await until(() => second.code() !== 0);
    expect(second.code()).toBe(4001);
  });

  it('does not let a proven connection skip hello or send a second auth', async () => {
    const { port, token } = await server.start();
    const c = rawClient(port);
    await c.open();
    await until(() => c.nonce() !== '');
    c.ws.send(authMsg(NA, authMac(token, c.nonce(), NA)));
    await until(() => c.messages.length === 1);
    c.ws.send(authMsg('b'.repeat(32), authMac(token, c.nonce(), 'b'.repeat(32))));
    await until(() => c.code() !== 0);
    expect(c.code()).toBe(4001);
  });

  it('plugin A closes on a bad proof and never sends hello or the token to an impostor', async () => {
    const seen: string[] = [];
    const impostor = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    impostor.on('connection', (ws) => {
      ws.on('message', (d) => seen.push(String(d)));
      ws.send(JSON.stringify({ v: 1, type: 'challenge', nonce: 'c'.repeat(32) }));
      ws.on('message', () => ws.send(JSON.stringify({ v: 1, type: 'proof', mac: 'f'.repeat(64) })));
    });
    await new Promise((r) => impostor.once('listening', r));
    const { port } = impostor.address() as { port: number };
    await writeFile(discoveryPath, JSON.stringify({ v: 1, port, token: 'secret-token', pid: 1 }), {
      mode: 0o600,
    });
    const a = plugin.createBridge({ orcaVersion: 'x', discoveryPath, retryMs: 60_000 });
    await a.ensure();
    await until(() => seen.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] ?? '{}').type).toBe('auth');
    expect(seen.join('')).not.toContain('secret-token');
    expect(a.status().state).not.toBe('connected');
    a.stop();
    await new Promise((r) => impostor.close(r));
  });

  it('plugin A never sends the token or a hello to a server that cannot prove it knows it', async () => {
    const received: string[] = [];
    const fake = createServer((sock) => {
      sock.on('data', (d) => received.push(d.toString('latin1')));
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const port = (fake.address() as { port: number }).port;
    const a = plugin.createBridge({
      orcaVersion: 'x',
      discoveryPath,
      retryMs: 60_000,
    });
    await writeFile(discoveryPath, JSON.stringify({ v: 1, port, token: 'secret-token', pid: 1 }), {
      mode: 0o600,
    });
    await a.ensure();
    await until(() => received.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    // Only the HTTP upgrade request came in. The fake never answered, so no token, no hello.
    expect(received.join('')).not.toContain('secret-token');
    expect(a.send({ v: 1, type: 'agentStatus' })).toBe(false);
    a.stop();
    fake.close();
  });
});

describe('plugin A against a hostile peer on the bridge port', () => {
  const upgraded = (onSocket: (sock: import('node:net').Socket) => void) =>
    createServer((sock) => {
      sock.once('data', (d) => {
        const key = /Sec-WebSocket-Key: (\S+)/.exec(d.toString('latin1'))?.[1] ?? '';
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        sock.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        onSocket(sock);
      });
    });
  const connectTo = async (srv: import('node:net').Server, handshakeMs = 60_000) => {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await writeFile(discoveryPath, JSON.stringify({ v: 1, port, token: 't', pid: 1 }), {
      mode: 0o600,
    });
    const logs: string[] = [];
    const a = plugin.createBridge({
      orcaVersion: 'x',
      discoveryPath,
      retryMs: 60_000,
      handshakeMs,
      log: (m: string) => logs.push(m),
    });
    await a.ensure();
    return { a, logs };
  };

  it('drops a peer that never starts the handshake, so it cannot hold A forever', async () => {
    let closed = false;
    const srv = createServer((sock) => sock.resume().on('close', () => (closed = true)));
    const { a, logs } = await connectTo(srv, 100);
    await until(() => closed);
    expect(logs.join('\n')).toContain('no challenge on the bridge port');
    a.stop();
    srv.close();
  });

  it('closes on a frame larger than the cap before buffering it', async () => {
    let closed = false;
    const srv = upgraded((sock) => {
      sock.on('close', () => (closed = true));
      const head = Buffer.alloc(10);
      head[0] = 0x81;
      head[1] = 127;
      head.writeBigUInt64BE(1n << 40n, 2);
      sock.write(head);
    });
    const { a } = await connectTo(srv);
    await until(() => closed);
    a.stop();
    srv.close();
  });

  it('closes on a masked server frame', async () => {
    let closed = false;
    const srv = upgraded((sock) => {
      sock.on('close', () => (closed = true));
      sock.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x7a, 0x7b]));
    });
    const { a } = await connectTo(srv);
    await until(() => closed);
    a.stop();
    srv.close();
  });
});

describe('plugin A client against the real server', () => {
  it('reads the discovery file, says hello and gets the ack', async () => {
    await server.start();
    const onAck = vi.fn();
    const a = plugin.createBridge({ orcaVersion: '1.4.245', discoveryPath, onAck });
    await a.ensure();
    await until(() => a.status().state === 'connected');
    expect(server.connection).toEqual({ orcaVersion: '1.4.245', pluginVersion: '0.1.0' });
    expect(onAck).toHaveBeenCalledOnce();
    expect(a.status().deck).toEqual({ connected: true, devices: [{ model: 'Mobile', keys: 15 }] });
    a.stop();
  });

  it('reports b-not-running while B is down, then connects once B starts', async () => {
    const a = plugin.createBridge({ orcaVersion: '1.4.245', discoveryPath, retryMs: 30 });
    await a.ensure();
    expect(a.status().state).toBe('b-not-running');
    await server.start();
    await until(() => a.status().state === 'connected');
    a.stop();
  });

  it('is a no-op to ensure() while connected (one connection only)', async () => {
    await server.start();
    const a = plugin.createBridge({ orcaVersion: '1.4.245', discoveryPath });
    await a.ensure();
    await until(() => a.status().state === 'connected');
    const onHello = vi.fn();
    server.on('hello', onHello);
    await a.ensure();
    await a.ensure();
    await new Promise((r) => setTimeout(r, 50));
    expect(onHello).not.toHaveBeenCalled();
    a.stop();
  });

  it('reconnects with the new token after B restarts', async () => {
    const first = await server.start();
    const a = plugin.createBridge({ orcaVersion: '1.4.245', discoveryPath, retryMs: 30 });
    await a.ensure();
    await until(() => a.status().state === 'connected');
    await server.stop();
    await until(() => a.status().state !== 'connected');
    server = new BridgeServer({ discoveryPath, ports: [0] });
    const second = await server.start();
    expect(second.token).not.toBe(first.token);
    await until(() => a.status().state === 'connected');
    expect(server.connection).not.toBeNull();
    a.stop();
  });

  it('a stale token is rejected, a client that re-reads the file gets in', async () => {
    const { port } = await server.start();
    const c = rawClient(port);
    await c.open();
    await login(c, 'stale-token');
    await until(() => c.code() === 4001);
    const a = plugin.createBridge({ orcaVersion: '1.4.245', discoveryPath });
    await a.ensure();
    await until(() => a.status().state === 'connected');
    a.stop();
  });

  it('sends frames larger than 64 KiB to B (extended length path)', async () => {
    await server.start();
    const a = plugin.createBridge({ orcaVersion: '1.4.245', discoveryPath });
    await a.ensure();
    await until(() => a.status().state === 'connected');
    // a >64 KiB A->B frame exercises the masked 64-bit length encoder
    const onMessage = vi.fn();
    server.on('message', onMessage);
    const big = 'x'.repeat(70_000);
    (a as unknown as { send: (m: object) => void }).send({
      v: 1,
      type: 'pairRequest',
      requestId: big,
      pane: null,
    });
    await until(() => onMessage.mock.calls.length === 1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'pairRequest', requestId: big });
    a.stop();
  });
});

describe('plugin A activate() and the Show status command', () => {
  it('connects on activate and logs "Orca plugin connected" and never raises a notification', async () => {
    await server.start();
    const prev = process.env.HOME;
    const commands = new Map<string, () => Promise<void>>();
    const logged: string[] = [];
    const orca = {
      version: '1.4.245',
      log: (m: string) => logged.push(m),
      commands: { register: (id: string, fn: () => Promise<void>) => commands.set(id, fn) },
      events: { on: () => {} },
      notifications: {
        show: async () => {
          throw new Error('must not be called');
        },
      },
    };
    // activate() uses the default discovery path, so point HOME at a fake one
    process.env.HOME = dir;
    const { writeDiscovery } = await import('./discovery.ts');
    const d = await readDiscovery(discoveryPath);
    await writeDiscovery(join(dir, '.orca-deck', 'bridge.json'), d!);
    vi.resetModules();
    const fresh = (await import(
      `${pathToFileURL(pluginPath.pathname).href}?fresh=${Date.now()}`
    )) as typeof plugin;
    await fresh.default(orca);
    await commands.get('deck.status')!();
    process.env.HOME = prev;
    expect(logged).toContain('status: Orca plugin connected');
    expect(commands.has('deck.status')).toBe(true);
  });

  it.each([
    [false, 'Stream Deck not connected', []],
    [true, 'Press a key on the deck to map this pane', ['pairRequest']],
  ])('Map pane with the deck connected=%s', async (deckUp, toast, sent) => {
    const connected = { value: deckUp };
    server = new BridgeServer({
      discoveryPath,
      ports: [0],
      deck: () => ({ connected: connected.value, devices: [] }),
    });
    await server.start();
    const received: { type: string; pane?: unknown }[] = [];
    server.on('message', (m) => received.push(m));
    const prev = process.env.HOME;
    const commands = new Map<string, () => Promise<string | void>>();
    const orca = {
      version: '1.4.245',
      log: () => {},
      commands: {
        register: (id: string, fn: () => Promise<string | void>) => commands.set(id, fn),
      },
      events: { on: () => {} },
    };
    process.env.HOME = dir;
    const { writeDiscovery } = await import('./discovery.ts');
    const d = await readDiscovery(discoveryPath);
    await writeDiscovery(join(dir, '.orca-deck', 'bridge.json'), d!);
    vi.resetModules();
    const fresh = (await import(
      `${pathToFileURL(pluginPath.pathname).href}?fresh=${Date.now()}`
    )) as typeof plugin;
    await fresh.default(orca);
    try {
      expect(commands.has('deck.map') && commands.has('deck.unmap')).toBe(true);
      expect(await commands.get('deck.map')!()).toBe(toast);
      await new Promise((r) => setTimeout(r, 100));
      expect(received.map((m) => m.type)).toEqual(sent);
      if (deckUp) {
        expect(received[0]).toMatchObject({ pane: null });
        expect(await commands.get('deck.unmap')!()).toBe('Unmapping this pane');
        await new Promise((r) => setTimeout(r, 100));
        expect(received.map((m) => m.type)).toEqual(['pairRequest', 'unmapRequest']);
      }
    } finally {
      process.env.HOME = prev;
    }
  });
});

const ev = (o: object = {}) => ({
  workspaceId: 'w1::/p',
  paneKey: 't1:l1',
  state: 'working',
  receivedAt: 1000,
  mainAgent: { state: 'working', stateStartedAt: 900 },
  ...o,
});

describe('toAgentStatus', () => {
  it('prefers mainAgent over a stale top-level state', () => {
    const m = plugin.toAgentStatus(
      ev({ state: 'working', mainAgent: { state: 'done', stateStartedAt: 5 } }),
    );
    expect(m).toMatchObject({ type: 'agentStatus', state: 'done', stateStartedAt: 5 });
  });
  it('uses the top-level state for Pi (mainAgent null) and falls back to receivedAt', () => {
    const m = plugin.toAgentStatus(ev({ mainAgent: null, state: 'waiting' }));
    expect(m).toMatchObject({ state: 'waiting', stateStartedAt: 1000, outcome: null });
  });
  it('carries the outcome and an empty workspaceId when Orca sent null', () => {
    const m = plugin.toAgentStatus(
      ev({
        workspaceId: null,
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 7 },
      }),
    );
    expect(m).toMatchObject({ outcome: 'failure', workspaceId: '' });
  });
  it('forwards the agent type when Orca sends one, and leaves it out otherwise', async () => {
    const { parseFromA } = await import('./protocol.ts');
    const m = plugin.toAgentStatus(ev({ agentType: 'claude' }));
    expect(m).toMatchObject({ agentType: 'claude' });
    expect(parseFromA(m)).toMatchObject({ agentType: 'claude' });
    expect(plugin.toAgentStatus(ev({}))).not.toHaveProperty('agentType');
  });
  it('rejects events without a pane or a state', () => {
    expect(plugin.toAgentStatus({ state: 'done' })).toBeNull();
    expect(plugin.toAgentStatus({ paneKey: 'a:b' })).toBeNull();
    expect(plugin.toAgentStatus(null as never)).toBeNull();
  });
  it('produces messages the bridge protocol accepts', async () => {
    const { parseFromA } = await import('./protocol.ts');
    expect(() => parseFromA(plugin.toAgentStatus(ev({ mainAgent: null })))).not.toThrow();
  });
});

describe('forwarder', () => {
  const make = (connected = true) => {
    const sent: Array<Record<string, unknown>> = [];
    let up = connected;
    const f = plugin.createForwarder({
      send: (m) => (up ? (sent.push(m as never), true) : false),
    });
    return { f, sent, setUp: (v: boolean) => (up = v) };
  };

  it('drops duplicates of the same pane, state and stateStartedAt', () => {
    const { f, sent } = make();
    expect(f.onStatus(ev())).toBe(true);
    expect(f.onStatus(ev())).toBe(false);
    expect(f.onStatus(ev({ receivedAt: 1100 }))).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('forwards a new transition and a repeat state with a new stateStartedAt', () => {
    const { f, sent } = make();
    f.onStatus(ev());
    f.onStatus(ev({ mainAgent: { state: 'done', stateStartedAt: 950 } }));
    f.onStatus(ev({ mainAgent: { state: 'done', stateStartedAt: 990 } }));
    expect(sent.map((m) => m['state'])).toEqual(['working', 'done', 'done']);
  });

  it('remembers state while B is down and replays only the latest per pane on connect', () => {
    const { f, sent, setUp } = make(false);
    f.onStatus(ev());
    f.onStatus(ev({ mainAgent: { state: 'waiting', stateStartedAt: 910 } }));
    f.onStatus(ev({ paneKey: 't2:l2', mainAgent: { state: 'done', stateStartedAt: 920 } }));
    expect(sent).toHaveLength(0);
    setUp(true);
    expect(f.replay()).toBe(2);
    expect(sent.map((m) => `${m['paneKey']}:${m['state']}`).sort()).toEqual([
      't1:l1:waiting',
      't2:l2:done',
    ]);
  });

  it('keeps at most maxPanes panes, dropping the least recently updated', () => {
    const sent: unknown[] = [];
    const f = (
      plugin.createForwarder as (b: object, o: object) => ReturnType<typeof plugin.createForwarder>
    )({ send: (m: unknown) => (sent.push(m), true) }, { maxPanes: 2 });
    f.onStatus(ev({ paneKey: 'a:1' }));
    f.onStatus(ev({ paneKey: 'b:1' }));
    f.onStatus(ev({ paneKey: 'a:1', mainAgent: { state: 'done', stateStartedAt: 1 } }));
    f.onStatus(ev({ paneKey: 'c:1' }));
    expect(f.size()).toBe(2);
    sent.length = 0;
    f.replay();
    expect((sent as Array<{ paneKey: string }>).map((m) => m.paneKey).sort()).toEqual([
      'a:1',
      'c:1',
    ]);
  });

  it('forwards workspace created/removed and ignores events without an id', () => {
    const { f, sent } = make();
    expect(f.onWorkspace('created', { workspaceId: 'w2', path: '/x' })).toBe(true);
    expect(f.onWorkspace('removed', { id: 'w2' })).toBe(true);
    expect(f.onWorkspace('created', {})).toBe(false);
    expect(sent).toEqual([
      { v: 1, type: 'workspace', event: 'created', workspaceId: 'w2', path: '/x' },
      { v: 1, type: 'workspace', event: 'removed', workspaceId: 'w2', path: '' },
    ]);
  });
});

describe('plugin A end to end through activate()', () => {
  async function boot() {
    await server.start();
    const prev = process.env.HOME;
    process.env.HOME = dir;
    const { writeDiscovery } = await import('./discovery.ts');
    await writeDiscovery(
      join(dir, '.orca-deck', 'bridge.json'),
      (await readDiscovery(discoveryPath))!,
    );
    const handlers = new Map<string, (e: object) => unknown>();
    const orca = {
      version: '1.4.245',
      log: () => {},
      commands: { register: () => {} },
      events: { on: (n: string, fn: (e: object) => unknown) => handlers.set(n, fn) },
    };
    const fresh = (await import(
      `${pathToFileURL(pluginPath.pathname).href}?e2e=${Math.random()}`
    )) as typeof plugin;
    return {
      handlers,
      run: async () => {
        await fresh.default(orca);
        process.env.HOME = prev;
      },
    };
  }

  it('forwards agent events to B, replays on requestSnapshot, and wakes with the first event', async () => {
    const got: Array<Record<string, unknown>> = [];
    const { handlers, run } = await boot();
    server.on('message', (m) => got.push(m as never));
    await run();
    await until(() => server.connection !== null);
    await handlers.get('agent.status.changed')!(ev());
    await handlers.get('agent.status.changed')!(ev()); // duplicate
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ type: 'agentStatus', paneKey: 't1:l1', state: 'working' });
    server.send({ v: 1, type: 'requestSnapshot' });
    await until(() => got.length === 2);
    expect(got[1]).toMatchObject({ type: 'agentStatus', paneKey: 't1:l1' });
    handlers.get('workspace.created')!({ workspaceId: 'w9', path: '/w9' });
    await until(() => got.length === 3);
    expect(got[2]).toMatchObject({ type: 'workspace', event: 'created', workspaceId: 'w9' });
  });
});
