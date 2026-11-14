import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { isPrivateFile, readDiscovery, writeDiscovery } from './discovery.ts';
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
const plugin = (await import(pluginPath.href)) as {
  PLUGIN_VERSION: string;
  createBridge: (o: Record<string, unknown>) => {
    ensure: () => Promise<void>;
    status: () => { state: string; deck: unknown };
    stop: () => void;
    send: (m: object) => boolean;
  };
  createForwarder: (b: { send: (m: object) => boolean }) => {
    onStatus: (ev: object) => boolean;
    replay: () => number;
    size: () => number;
  };
  toAgentStatus: (ev: object, now?: number) => Record<string, unknown> | null;
  statusBarItem: (s: Record<string, unknown>) => { text: string; tone: string } | null;
  createPanelApi: (
    bridge: object,
    opts?: { onKeyPicked?: (key: number) => void; deckWaitMs?: number },
  ) => {
    get: () => Promise<Record<string, unknown>>;
    select: (on: boolean) => { ok: true };
    resync: () => void;
    onMessage: (msg: object) => void;
  };
  default: (orca: unknown) => Promise<void>;
};

// Wraps lstat so a test can fake what Windows reports (real symlinks need extra rights there).
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

let dir: string;
let discoveryPath: string;
let server: BridgeServer;

/** Points the plugin's default discovery path at the test dir on every platform. afterEach undoes it. */
function fakeUserDirs(): void {
  vi.stubEnv('HOME', dir);
  vi.stubEnv('APPDATA', join(dir, 'AppData', 'Roaming'));
}

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
  vi.unstubAllEnvs();
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

  it('leaves a discovery file a newer B took over', async () => {
    await server.start();
    const newer = new BridgeServer({ discoveryPath, ports: [0] });
    await newer.start();
    await server.stop();
    expect((await readFile(discoveryPath, 'utf8')).length).toBeGreaterThan(0);
    await newer.stop();
    await expect(readFile(discoveryPath)).rejects.toThrow();
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

  it('on win32 only the regular-file check applies, so a symlink is still refused', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const faked = (isFile: boolean) =>
        vi
          .mocked(lstat)
          .mockResolvedValueOnce({ isFile: () => isFile, uid: -1, mode: 0o644 } as Stats);
      faked(false);
      expect(await isPrivateFile(join(dir, 'link.json'))).toBe(false);
      // no uid or mode bits on Windows: a regular file passes whatever they say
      faked(true);
      expect(await isPrivateFile(join(dir, 'file.json'))).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('writeDiscovery replaces a symlink at the target instead of following it', async () => {
    if (process.platform === 'win32') return;
    const d = await server.start();
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'keep');
    const target = join(dir, 'planted.json');
    await symlink(victim, target);
    await writeDiscovery(target, d);
    expect(await readFile(victim, 'utf8')).toBe('keep');
    expect((await lstat(target)).isFile()).toBe(true);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
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

  it('plugin A moves to a newer B that took over the discovery file, though the old B still lives', async () => {
    await server.start();
    const first = vi.fn();
    server.on('hello', first);
    const a = plugin.createBridge({
      orcaVersion: 'x',
      discoveryPath,
      retryMs: 20,
      followMs: 20,
    });
    await a.ensure();
    await until(() => first.mock.calls.length === 1);
    const newer = new BridgeServer({ discoveryPath, ports: [0] });
    const second = vi.fn();
    newer.on('hello', second);
    await newer.start();
    await until(() => second.mock.calls.length === 1, 3000);
    a.stop();
    await newer.stop();
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
      minor: 4,
    });
    // A hello without a minor is a v0.2.x A: minor 0.
    const info = { orcaVersion: '1.4.245', pluginVersion: '0.1.0', minor: 0 };
    expect(onHello).toHaveBeenCalledWith(info);
    expect(server.connection).toEqual(info);
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

  it('does not call A outdated for a bridge version sent without the token', async () => {
    const { port } = await server.start();
    const c = rawClient(port);
    await c.open();
    c.ws.send(JSON.stringify({ v: 9, type: 'auth', nonce: NA, mac: 'f'.repeat(64) }));
    await until(() => c.code() !== 0);
    expect(server.outdatedPeerAt).toBeNull();
  });

  it('calls A outdated for another bridge version once it proved the token', async () => {
    const { port, token } = await server.start();
    const c = rawClient(port);
    await c.open();
    await until(() => c.nonce() !== '');
    c.ws.send(
      JSON.stringify({ v: 9, type: 'auth', nonce: NA, mac: authMac(token, c.nonce(), NA) }),
    );
    await until(() => c.code() !== 0);
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
    c.ws.send(JSON.stringify({ v: 1, type: 'openPanel', requestId: 'r1', panelId: 'deck' }));
    await until(() => onMessage.mock.calls.length === 1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
      type: 'openPanel',
      requestId: 'r1',
      panelId: 'deck',
    });
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

  it('ignores another bridge version from a peer that has not proven the token', async () => {
    const text = Buffer.from(JSON.stringify({ v: 9, type: 'challenge', nonce: 'x' }));
    const srv = upgraded((sock) =>
      sock.write(Buffer.concat([Buffer.from([0x81, text.length]), text])),
    );
    const { a, logs } = await connectTo(srv);
    await new Promise((r) => setTimeout(r, 150));
    expect(logs.join('\n')).not.toContain('update Agent Deck');
    expect((a.status() as { versionNote?: string | null }).versionNote ?? null).toBeNull();
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
    expect(server.connection).toEqual({
      orcaVersion: '1.4.245',
      pluginVersion: plugin.PLUGIN_VERSION,
      minor: 3,
    });
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
      type: 'openPanel',
      requestId: big,
      panelId: 'deck',
    });
    await until(() => onMessage.mock.calls.length === 1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'openPanel', requestId: big });
    a.stop();
  });
});

describe('plugin A activate() and the Show status command', () => {
  it('connects on activate and logs "Orca plugin connected" and never raises a notification', async () => {
    await server.start();
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
    // activate() uses the default discovery path, so point HOME and APPDATA at a fake one
    fakeUserDirs();
    const { writeDiscovery, defaultDiscoveryPath } = await import('./discovery.ts');
    const d = await readDiscovery(discoveryPath);
    await writeDiscovery(defaultDiscoveryPath(), d!);
    vi.resetModules();
    const fresh = (await import(`${pluginPath.href}?fresh=${Date.now()}`)) as typeof plugin;
    await fresh.default(orca);
    await commands.get('deck.status')!();
    expect(logged).toContain('status: Orca plugin connected');
    expect(commands.has('deck.status')).toBe(true);
  });

  it.each([
    [false, 'Stream Deck not connected', []],
    [true, 'Agent Deck panel', ['openPanel']],
  ])('Open panel with the deck connected=%s', async (deckUp, toast, sent) => {
    const connected = { value: deckUp };
    server = new BridgeServer({
      discoveryPath,
      ports: [0],
      deck: () => ({ connected: connected.value, devices: [] }),
    });
    await server.start();
    const received: { type: string; pane?: unknown }[] = [];
    // B opens the panel in Orca and says so.
    server.on('message', (m) => {
      received.push(m);
      if (m.type === 'openPanel')
        server.send({ v: 1, type: 'openPanelResult', requestId: m.requestId, ok: true });
    });
    const commands = new Map<string, () => Promise<string | void>>();
    const orca = {
      version: '1.4.245',
      log: () => {},
      commands: {
        register: (id: string, fn: () => Promise<string | void>) => commands.set(id, fn),
      },
      events: { on: () => {} },
    };
    fakeUserDirs();
    const { writeDiscovery, defaultDiscoveryPath } = await import('./discovery.ts');
    const d = await readDiscovery(discoveryPath);
    await writeDiscovery(defaultDiscoveryPath(), d!);
    vi.resetModules();
    const fresh = (await import(`${pluginPath.href}?fresh=${Date.now()}`)) as typeof plugin;
    await fresh.default(orca);
    expect(commands.has('deck.map')).toBe(true);
    expect(commands.has('deck.unmap'), 'no pane unmap command: the panel does it').toBe(false);
    expect(await commands.get('deck.map')!()).toBe(toast);
    await new Promise((r) => setTimeout(r, 100));
    expect(received.map((m) => m.type)).toEqual(sent);
  });
});

describe('the panel is told when the link drops', () => {
  const make = (delayMs = 1000) => {
    let state = 'connected';
    const posts: object[] = [];
    const sent: object[] = [];
    const n = (
      plugin as unknown as {
        createLinkNotifier: (o: object) => {
          change: () => void;
          stop: () => void;
        };
      }
    ).createLinkNotifier({
      bridge: { status: () => ({ state }), send: (m: object) => (sent.push(m), true) },
      post: (p: object) => posts.push(p),
      delayMs,
    });
    return {
      n,
      posts,
      sent,
      set: (s: string) => {
        state = s;
        n.change();
      },
    };
  };

  it('tells offline once after a second down, and again after the next drop', () => {
    vi.useFakeTimers();
    try {
      const t = make();
      t.set('disconnected');
      vi.advanceTimersByTime(900);
      expect(t.posts).toEqual([]);
      vi.advanceTimersByTime(200);
      expect(t.posts).toEqual([{ status: 'offline' }]);
      t.set('b-not-running');
      vi.advanceTimersByTime(5000);
      expect(t.posts, 'once').toHaveLength(1);
      t.set('connected');
      t.set('disconnected');
      vi.advanceTimersByTime(1100);
      expect(t.posts, 'a second drop is told again').toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing when it reconnects within the second (a Stream Deck plugin switch)', () => {
    vi.useFakeTimers();
    try {
      const t = make();
      t.set('connecting');
      vi.advanceTimersByTime(500);
      t.set('connected');
      vi.advanceTimersByTime(5000);
      expect(t.posts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Open panel when B cannot open it', () => {
  it.each(['refused', 'unavailable'] as const)('says so when B says %s', async (reason) => {
    server = new BridgeServer({
      discoveryPath,
      ports: [0],
      deck: () => ({ connected: true, devices: [] }),
    });
    await server.start();
    server.on('message', (m) => {
      if (m.type === 'openPanel')
        server.send({ v: 1, type: 'openPanelResult', requestId: m.requestId, ok: false, reason });
    });
    const commands = new Map<string, () => Promise<string | void>>();
    fakeUserDirs();
    const { writeDiscovery, defaultDiscoveryPath } = await import('./discovery.ts');
    const d = await readDiscovery(discoveryPath);
    await writeDiscovery(defaultDiscoveryPath(), d!);
    vi.resetModules();
    const fresh = (await import(`${pluginPath.href}?fresh=${Date.now()}`)) as typeof plugin;
    await fresh.default({
      version: '1.4.245',
      log: () => {},
      commands: {
        register: (id: string, fn: () => Promise<string | void>) => commands.set(id, fn),
      },
      events: { on: () => {} },
    });
    expect(await commands.get('deck.map')!()).toBe(
      'Could not open the Agent Deck panel: open it from the sidebar',
    );
  });
});

describe('status bar button', () => {
  it.each([
    [{ state: 'connected', deck: { connected: true } }, 'Agent Deck'],
    [{ state: 'connected', deck: { connected: false } }, 'No Stream Deck'],
    // The last deckState of this connection wins over what helloAck said.
    [{ state: 'connected', deck: { connected: false }, deckConnected: true }, 'Agent Deck'],
    [{ state: 'b-not-running', deck: null }, 'Deck offline'],
    [{ state: 'disconnected', deck: null }, 'Deck offline'],
    [{ state: 'disconnected', deck: null, versionNote: 'B speaks bridge 2' }, 'Update Agent Deck'],
  ])('%o shows %s', (status, text) => {
    expect(plugin.statusBarItem(status)?.text).toBe(text);
  });

  it('keeps the last text while connecting, so a reconnect does not flicker', () => {
    expect(plugin.statusBarItem({ state: 'connecting', deck: null })).toBeNull();
  });

  it('activate() sets the button from the link, once per change, and skips an Orca without a status bar', async () => {
    await server.start();
    const updates: { id: string; text: string }[] = [];
    const base = {
      log: () => {},
      commands: { register: () => {} },
      events: { on: () => {} },
    };
    fakeUserDirs();
    const { writeDiscovery, defaultDiscoveryPath } = await import('./discovery.ts');
    const d = await readDiscovery(discoveryPath);
    await writeDiscovery(defaultDiscoveryPath(), d!);
    vi.resetModules();
    const fresh = (await import(`${pluginPath.href}?fresh=${Date.now()}`)) as typeof plugin;
    await fresh.default({
      ...base,
      host: {
        has: (m: string) => m === 'statusBar.update',
        call: async (m: string, p: { id: string; text: string }) => {
          if (m === 'statusBar.update') updates.push(p);
          return { ok: true };
        },
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(updates.at(-1)).toMatchObject({ id: 'deck', text: 'Agent Deck', tone: 'neutral' });
    expect(new Set(updates.map((u) => u.text)).size).toBe(updates.length);
    // Orca before 1.4.248: no host call at all.
    const calls: string[] = [];
    vi.resetModules();
    const older = (await import(`${pluginPath.href}?older=${Date.now()}`)) as typeof plugin;
    await older.default({
      ...base,
      host: { has: () => false, call: async (m: string) => calls.push(m) },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([]);
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
});

describe('plugin A end to end through activate()', () => {
  async function boot() {
    await server.start();
    fakeUserDirs();
    const { writeDiscovery, defaultDiscoveryPath } = await import('./discovery.ts');
    await writeDiscovery(defaultDiscoveryPath(), (await readDiscovery(discoveryPath))!);
    const handlers = new Map<string, (e: object) => unknown>();
    const orca = {
      version: '1.4.245',
      log: () => {},
      commands: { register: () => {} },
      events: { on: (n: string, fn: (e: object) => unknown) => handlers.set(n, fn) },
    };
    const fresh = (await import(`${pluginPath.href}?e2e=${Math.random()}`)) as typeof plugin;
    return {
      handlers,
      run: async () => {
        await fresh.default(orca);
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
    expect(
      handlers.has('workspace.created'),
      'no workspace events: the manifest has no capability',
    ).toBe(false);
  });
});

describe('panel api: deck taps select keys in the panel', () => {
  const fakeBridge = (minor: number) => {
    const sent: { type: string; on?: boolean }[] = [];
    let state = 'connected';
    return {
      sent,
      down: () => (state = 'disconnected'),
      up: () => (state = 'connected'),
      bridge: {
        status: () => ({ state, minor, session: 1 }),
        send: (m: { type: string; on?: boolean }) => (sent.push(m), true),
        ensure: async () => {},
      },
    };
  };

  it('forwards the panel state to a B of minor 3, again after a reconnect, and hands its taps back', () => {
    const b = fakeBridge(3);
    const picked: number[] = [];
    const api = plugin.createPanelApi(b.bridge, { onKeyPicked: (k: number) => picked.push(k) });
    expect(api.select(true)).toEqual({ ok: true });
    expect(b.sent).toEqual([{ v: 1, type: 'panelSelect', on: true }]);
    api.onMessage({ type: 'keyPicked', key: 4 });
    expect(picked).toEqual([4]);
    api.onMessage({ type: 'keyPicked', key: 5 });
    expect(picked, 'a hold also asks for a key when no taps were asked for').toEqual([4, 5]);
    // B forgets it with the connection: a new helloAck sends it again.
    api.resync();
    expect(b.sent.at(-1)).toEqual({ v: 1, type: 'panelSelect', on: true });
    api.select(false);
    api.resync();
    expect(b.sent.map((m) => m.on)).toEqual([true, true, false]);
  });

  it('keeps the last key B asked for until the panel gets its deck, once', async () => {
    const b = fakeBridge(4);
    const api = plugin.createPanelApi(b.bridge, { deckWaitMs: 50 });
    api.onMessage({ type: 'deckState', connected: true, cols: 3, rows: 2, keys: [] });
    api.onMessage({ type: 'keyPicked', key: 2 });
    api.onMessage({ type: 'keyPicked', key: 3 });
    expect(await api.get()).toMatchObject({ status: 'ok', picked: 3 });
    expect(await api.get(), 'handed over once').not.toHaveProperty('picked');
  });

  it('sends nothing to an older B or while disconnected', () => {
    const old = fakeBridge(2);
    plugin.createPanelApi(old.bridge).select(true);
    expect(old.sent).toEqual([]);
    const b = fakeBridge(3);
    b.down();
    plugin.createPanelApi(b.bridge).select(true);
    expect(b.sent).toEqual([]);
  });
});
