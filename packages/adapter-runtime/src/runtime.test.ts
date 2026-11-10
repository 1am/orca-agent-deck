import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CliAdapter, type Exec } from '@orca-agent-deck/adapter-cli';
import {
  RuntimeClient,
  RuntimeError,
  RuntimeUnavailableError,
  defaultMetaPath,
  makeRuntimeExec,
  readMeta,
} from './index.ts';

const fx = (n: string) =>
  JSON.parse(readFileSync(`test/fixtures/orca/${n}`, 'utf8')) as { result: unknown };

let dir: string;
let sockPath: string;
let metaPath: string;
let server: Server;
let token: string;
let requests: Array<{ method: string; params: Record<string, unknown>; authToken: string }>;
let handler: (method: string, params: Record<string, unknown>) => unknown;
let preamble: string[];
let connections: number;

const socketPathAt = (name: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\orca-rt-${process.pid}-${name}`
    : join(dir, `${name}.sock`);

const writeMeta = (t = token, endpoint = sockPath) =>
  writeFile(
    metaPath,
    JSON.stringify({
      runtimeId: 'rt1',
      authToken: t,
      transports: [
        { kind: 'websocket', endpoint: 'ws://127.0.0.1:1' },
        { kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint },
      ],
    }),
    { mode: 0o600 },
  );

function listen(path: string): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((sock: Socket) => {
      connections++;
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (c: string) => {
        buf += c;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        const req = JSON.parse(buf.slice(0, i));
        requests.push(req);
        for (const p of preamble) sock.write(p + '\n');
        if (req.authToken !== token) {
          sock.end(
            JSON.stringify({
              id: req.id,
              ok: false,
              error: { code: 'unauthorized', message: 'bad token' },
            }) + '\n',
          );
          return;
        }
        try {
          const result = handler(req.method, req.params);
          sock.end(
            JSON.stringify({ id: req.id, ok: true, result, _meta: { runtimeId: 'rt1' } }) + '\n',
          );
        } catch (e) {
          const err = e as { code?: string; message: string };
          sock.end(
            JSON.stringify({
              id: req.id,
              ok: false,
              error: { code: err.code ?? 'boom', message: err.message },
            }) + '\n',
          );
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(path, () => resolve(srv));
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rt-'));
  // Windows sockets are named pipes: node:net takes the pipe path wherever it takes a socket path.
  sockPath = socketPathAt('s');
  metaPath = join(dir, 'orca-runtime.json');
  token = 'tok-1';
  requests = [];
  preamble = [];
  connections = 0;
  handler = () => ({});
  server = await listen(sockPath);
  await writeMeta();
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe('defaultMetaPath', () => {
  it('follows each platform', () => {
    expect(defaultMetaPath('darwin', {}, '/h')).toBe(
      join('/h', 'Library/Application Support/orca/orca-runtime.json'),
    );
    expect(defaultMetaPath('linux', {}, '/h')).toBe(join('/h', '.config/orca/orca-runtime.json'));
    expect(defaultMetaPath('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe(
      join('/x', 'orca/orca-runtime.json'),
    );
    expect(defaultMetaPath('win32', { APPDATA: 'C:\\A' }, 'C:\\h')).toContain('orca');
  });
});

describe('readMeta', () => {
  it('picks the unix transport', async () => {
    expect(await readMeta(metaPath)).toEqual({
      endpoint: sockPath,
      authToken: token,
      runtimeId: 'rt1',
    });
  });
  it('picks the Windows named-pipe transport', async () => {
    await writeFile(
      metaPath,
      JSON.stringify({
        runtimeId: 'rt1',
        authToken: token,
        transports: [{ kind: 'named-pipe', endpoint: '\\\\.\\pipe\\orca-1-abc' }],
      }),
      { mode: 0o600 },
    );
    expect(await readMeta(metaPath)).toEqual({
      endpoint: '\\\\.\\pipe\\orca-1-abc',
      authToken: token,
      runtimeId: 'rt1',
    });
  });
  it.skipIf(process.platform === 'win32')(
    'refuses a runtime file others can read, or a symlink to one',
    async () => {
      await chmod(metaPath, 0o644);
      expect(await readMeta(metaPath)).toBeNull();
      await chmod(metaPath, 0o600);
      const link = join(dir, 'link.json');
      await symlink(metaPath, link);
      expect(await readMeta(link)).toBeNull();
    },
  );
  it('returns null for a missing, garbled or unix-less file', async () => {
    expect(await readMeta(join(dir, 'none.json'))).toBeNull();
    await writeFile(metaPath, 'nope');
    expect(await readMeta(metaPath)).toBeNull();
    await writeFile(
      metaPath,
      JSON.stringify({ authToken: 'x', transports: [{ kind: 'websocket', endpoint: 'ws://x' }] }),
    );
    expect(await readMeta(metaPath)).toBeNull();
  });
});

describe('RuntimeClient', () => {
  it('sends one authenticated request per connection and returns the result', async () => {
    handler = (m, p) => ({ m, p });
    const c = new RuntimeClient({ metaPath });
    expect(await c.call('a.b', { x: 1 })).toEqual({ m: 'a.b', p: { x: 1 } });
    await c.call('a.c');
    expect(connections).toBe(2);
    expect(requests.map((r) => r.authToken)).toEqual([token, token]);
  });

  it('skips keepalive frames before the reply', async () => {
    preamble = [JSON.stringify({ _keepalive: true }), JSON.stringify({ _keepalive: true })];
    handler = () => ({ ok: 1 });
    expect(await new RuntimeClient({ metaPath }).call('x')).toEqual({ ok: 1 });
  });

  it('raises RuntimeError with the code for ok:false and does not retry it', async () => {
    handler = () => {
      throw Object.assign(new Error('Missing terminal handle'), { code: 'invalid_argument' });
    };
    const c = new RuntimeClient({ metaPath });
    await expect(c.call('terminal.focus')).rejects.toMatchObject({
      name: 'RuntimeError',
      code: 'invalid_argument',
    });
    expect(requests).toHaveLength(1);
  });

  it('is unavailable when the runtime file does not exist', async () => {
    await expect(
      new RuntimeClient({ metaPath: join(dir, 'none') }).call('x'),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });

  it('is unavailable when the socket is dead', async () => {
    await writeMeta(token, join(dir, 'gone.sock'));
    await expect(new RuntimeClient({ metaPath }).call('x')).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
  });

  it('re-reads the file after Orca restarted with a new socket and token', async () => {
    handler = () => 'old';
    const c = new RuntimeClient({ metaPath });
    expect(await c.call('x')).toBe('old');
    // restart: new socket + token, old socket gone
    await new Promise((r) => server.close(r));
    const newSock = socketPathAt('n');
    token = 'tok-2';
    server = await listen(newSock);
    handler = () => 'new';
    await writeMeta('tok-2', newSock);
    expect(await c.call('x')).toBe('new');
  });

  it('refreshes once on an auth error (rotated token, same socket)', async () => {
    const c = new RuntimeClient({ metaPath });
    await c.call('x');
    token = 'tok-3';
    await writeMeta('tok-3');
    handler = () => 'fresh';
    expect(await c.call('x')).toBe('fresh');
  });

  it('gives up after one refresh when the token stays wrong', async () => {
    token = 'other';
    await expect(new RuntimeClient({ metaPath }).call('x')).rejects.toBeInstanceOf(RuntimeError);
    expect(requests).toHaveLength(2);
  });

  it('times out on a server that never answers', async () => {
    await new Promise((r) => server.close(r));
    server = createServer((s) => s.on('data', () => {}).on('error', () => {}));
    await new Promise<void>((r) => server.listen(sockPath, r));
    await expect(new RuntimeClient({ metaPath, timeoutMs: 80 }).call('x')).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
  });

  it('rejects a reply larger than 1 MB instead of buffering it', async () => {
    handler = () => 'x'.repeat(1_200_000);
    await expect(new RuntimeClient({ metaPath }).call('x')).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
  });

  it('never puts the token in an error message', async () => {
    token = 'super-secret-token';
    await writeMeta('wrong');
    const e = await new RuntimeClient({ metaPath }).call('x').catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain('super-secret-token');
    expect(String((e as Error).message)).not.toContain('wrong');
  });
});

describe('runtime exec mapped onto CliAdapter', () => {
  let cliCalls: string[][];
  const fallback: Exec = async (args) => {
    cliCalls.push(args);
    if (args[0] === 'environment') {
      return JSON.stringify({ ok: true, result: { environments: [{ id: 'env1', name: 'box' }] } });
    }
    if (args.includes('--environment')) {
      const k = args.slice(0, 2).join(' ');
      if (k === 'terminal list') return JSON.stringify({ ok: true, result: { terminals: [] } });
      if (k === 'worktree ps') return JSON.stringify({ ok: true, result: { worktrees: [] } });
    }
    return JSON.stringify({ ok: true, result: {} });
  };
  let now = 1000;
  const mk = (extra: object = {}) =>
    makeRuntimeExec({
      client: new RuntimeClient({ metaPath }),
      fallback,
      environmentsFile: join(dir, 'orca-environments.json'),
      now: () => now,
      ...extra,
    });

  beforeEach(() => {
    cliCalls = [];
    now = 1000;
    handler = (m) => {
      if (m === 'status.get') return { graphStatus: 'ready', appVersion: '1.4.245' };
      if (m === 'terminal.list') return fx('terminal-list.json').result;
      if (m === 'worktree.ps') return fx('worktree-ps.json').result;
      if (m === 'ssh.listTargets')
        return { targets: [{ id: 'ssh-1', label: 'dev box', connected: true }] };
      if (m === 'terminal.focus') return { focus: { navigated: true } };
      if (m === 'terminal.resolveActive') return { handle: 'h1' };
      if (m === 'terminal.show') return { terminal: { tabId: 'T', leafId: 'L' } };
      throw Object.assign(new Error('nope'), { code: 'method_not_found' });
    };
  });

  it('focuses a paired-server pane with one local terminal.reveal, no CLI spawn', async () => {
    const base = handler;
    handler = (m, p) =>
      m === 'terminal.reveal' ? { reveal: { ...p, navigated: true } } : base(m, p);
    const a = new CliAdapter(mk());
    const r = await a.focus({
      paneKey: 'T:L',
      hostId: 'env:env 1',
      handle: 'h-remote',
      environment: 'env 1',
      worktreeId: 'W',
    });
    expect(r).toEqual({ ok: true });
    expect(cliCalls).toEqual([]);
    expect(requests.at(-1)).toMatchObject({
      method: 'terminal.reveal',
      params: { worktreeId: 'W', tabId: 'T', leafId: 'L', executionHostId: 'runtime:env%201' },
    });
  });

  it('falls back to the CLI switch when this Orca cannot reveal the pane', async () => {
    const base = handler;
    handler = (m, p) => (m === 'terminal.reveal' ? { reveal: { navigated: false } } : base(m, p));
    const pane = {
      paneKey: 'T:L',
      hostId: 'env:e',
      handle: 'h',
      environment: 'e',
      worktreeId: 'W',
    };
    await new CliAdapter(mk()).focus(pane);
    expect(cliCalls.map((c) => c.slice(0, 2).join(' '))).toEqual(['terminal switch']);
  });

  it('never spawns the CLI for reveal while the socket is down', async () => {
    await new Promise((r) => server.close(r));
    const pane = {
      paneKey: 'T:L',
      hostId: 'env:e',
      handle: 'h',
      environment: 'e',
      worktreeId: 'W',
    };
    await new CliAdapter(mk()).focus(pane);
    expect(cliCalls.map((c) => c.slice(0, 2).join(' '))).toEqual(['terminal switch']);
    server = await listen(sockPath);
  });

  it('builds a full snapshot with zero CLI spawns', async () => {
    const a = new CliAdapter(mk());
    const snap = await a.snapshot();
    expect(snap.panes.length).toBeGreaterThan(0);
    expect(snap.statuses.length).toBeGreaterThan(0);
    expect((await a.health()).version).toBe('1.4.245');
    expect(cliCalls).toEqual([]);
  });

  it('matches the CLI-only snapshot for the same fixture data', async () => {
    const viaCli: Exec = async (args) => {
      const k = args.slice(0, 2).join(' ');
      if (k === 'terminal list') return JSON.stringify(fx('terminal-list.json'));
      if (k === 'worktree ps') return JSON.stringify(fx('worktree-ps.json'));
      if (k === 'host list')
        return JSON.stringify({
          ok: true,
          result: { hosts: [{ kind: 'local', name: 'this machine', id: 'local' }] },
        });
      throw new Error(k);
    };
    const a = await new CliAdapter(mk()).snapshot();
    const b = await new CliAdapter(viaCli).snapshot();
    expect(a.panes).toEqual(b.panes);
    expect(a.statuses).toEqual(b.statuses);
  });

  it('lists hosts from the socket (local + ssh) without the CLI when there is no environments file', async () => {
    const hosts = await new CliAdapter(mk()).listHosts();
    expect(hosts).toEqual([
      { id: 'local', kind: 'local', name: 'this machine', connected: true },
      { id: 'ssh-1', kind: 'ssh', name: 'dev box', connected: true },
    ]);
    expect(cliCalls).toEqual([]);
  });

  it('asks the CLI for environments only when Orca changed its environments file', async () => {
    const f = join(dir, 'orca-environments.json');
    await writeFile(f, '{}');
    await utimes(f, 1000, 1000);
    const a = new CliAdapter(mk());
    expect((await a.listHosts()).find((h) => h.kind === 'environment')).toMatchObject({
      id: 'env1',
      name: 'box',
    });
    await a.listHosts();
    await a.listHosts();
    expect(cliCalls.filter((c) => c[0] === 'environment')).toHaveLength(1);
    await utimes(f, 2000, 2000);
    await a.listHosts();
    expect(cliCalls.filter((c) => c[0] === 'environment')).toHaveLength(2);
  });

  it('polls a paired server through the CLI at most once per interval', async () => {
    const exec = mk({ environmentPollMs: 5000 });
    const args = ['terminal', 'list', '--environment', 'box', '--json'];
    await exec(args);
    now += 1000;
    await exec(args);
    expect(cliCalls).toHaveLength(1);
    now += 5000;
    await exec(args);
    expect(cliCalls).toHaveLength(2);
  });

  it('serves a stale paired-server answer at once while the refresh runs in the background', async () => {
    let release: (v: string) => void = () => {};
    let calls = 0;
    const slow: Exec = (args) => {
      cliCalls.push(args);
      calls++;
      return calls === 1 ? Promise.resolve('{"first":true}') : new Promise((r) => (release = r));
    };
    const exec = makeRuntimeExec({
      client: new RuntimeClient({ metaPath }),
      fallback: slow,
      now: () => now,
    });
    const args = ['terminal', 'list', '--environment', 'box', '--json'];
    expect(await exec(args)).toBe('{"first":true}');
    now += 6000;
    // The refresh is pending, yet the poll returns the old answer without waiting for it.
    expect(await exec(args)).toBe('{"first":true}');
    expect(await exec(args)).toBe('{"first":true}');
    expect(cliCalls).toHaveLength(2); // one refresh in flight, not one per poll
    release('{"second":true}');
    await new Promise((r) => setTimeout(r, 0));
    expect(await exec(args)).toBe('{"second":true}');
  });

  it('also throttles a paired server that fails, so an unreachable box costs one timeout per interval', async () => {
    const failing: Exec = async (args) => {
      cliCalls.push(args);
      throw new Error('unreachable');
    };
    const exec = makeRuntimeExec({
      client: new RuntimeClient({ metaPath }),
      fallback: failing,
      now: () => now,
    });
    const args = ['worktree', 'ps', '--environment', 'box', '--json'];
    await expect(exec(args)).rejects.toThrow('unreachable');
    now += 1000;
    await expect(exec(args)).rejects.toThrow('unreachable');
    expect(cliCalls).toHaveLength(1);
    now += 5000;
    await expect(exec(args)).rejects.toThrow('unreachable');
    expect(cliCalls).toHaveLength(2);
  });

  it('never caches or throttles a focus on a paired server', async () => {
    const exec = mk();
    const args = ['terminal', 'switch', '--terminal', 'h', '--environment', 'box', '--json'];
    await exec(args);
    await exec(args);
    expect(cliCalls).toHaveLength(2);
  });

  it('focuses over the socket with the terminal param', async () => {
    const r = await new CliAdapter(mk()).focus({ paneKey: 'a:b', hostId: 'local', handle: 'h9' });
    expect(r).toEqual({ ok: true });
    expect(requests.at(-1)).toMatchObject({ method: 'terminal.focus', params: { terminal: 'h9' } });
    expect(cliCalls).toEqual([]);
  });

  it('reports a focus failure from the runtime as an error result, not a throw', async () => {
    handler = () => {
      throw Object.assign(new Error('terminal_handle_stale'), { code: 'terminal_handle_stale' });
    };
    const r = await new CliAdapter(mk()).focus({ paneKey: 'a:b', hostId: 'local', handle: 'old' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('terminal_handle_stale');
    expect(cliCalls).toEqual([]);
  });

  it('marks a worktree read over the socket with isUnread=false (no CLI)', async () => {
    handler = (m, p) => {
      if (m === 'worktree.set') return { got: p };
      throw new Error('x');
    };
    await new CliAdapter(mk()).markWorktreeRead('repo::/p');
    expect(requests.at(-1)).toMatchObject({
      method: 'worktree.set',
      params: { worktree: 'id:repo::/p', isUnread: false },
    });
    expect(cliCalls).toEqual([]);
  });

  it('marks a worktree unread when asked for --unread', async () => {
    handler = () => ({});
    await mk()(['worktree', 'set', '--worktree', 'id:w', '--unread', '--json']);
    expect(requests.at(-1)?.params).toMatchObject({ isUnread: true });
  });

  it('worktree set without --read/--unread (comment, status) still goes to the CLI', async () => {
    await mk()(['worktree', 'set', '--worktree', 'id:w', '--comment', 'x', '--json']);
    expect(cliCalls).toHaveLength(1);
  });

  it('reads the focused pane from the selected tab of the layout', async () => {
    handler = (m) => {
      if (m === 'worktree.ps')
        return { worktrees: [{ worktreeId: 'w', isActive: true, agents: [] }] };
      if (m === 'terminal.list')
        return {
          terminals: [],
          visualLayouts: [
            {
              worktreeId: 'w',
              root: {
                type: 'group',
                activeTabId: 'B',
                tabs: [
                  { tabId: 'A', activeLeafId: 'a1', panes: {} },
                  { tabId: 'B', activeLeafId: 'b2', panes: {} },
                ],
              },
            },
          ],
        };
      throw new Error('x');
    };
    expect(await new CliAdapter(mk()).focusedPaneKey()).toBe('B:b2');
  });

  it('reads the focused pane through resolveActive + show when the layout has no active tab', async () => {
    handler = (m) => {
      if (m === 'worktree.ps')
        return { worktrees: [{ worktreeId: 'w', isActive: true, agents: [] }] };
      if (m === 'terminal.list') return { terminals: [] };
      if (m === 'terminal.resolveActive') return { handle: 'h1' };
      if (m === 'terminal.show') return { terminal: { tabId: 'T', leafId: 'L' } };
      throw new Error('x');
    };
    expect(await new CliAdapter(mk()).focusedPaneKey()).toBe('T:L');
    expect(requests.find((r) => r.method === 'terminal.show')?.params).toEqual({ terminal: 'h1' });
  });

  it('falls back to the CLI for everything when the socket is unusable (degraded)', async () => {
    await writeMeta(token, join(dir, 'gone.sock'));
    const seen = vi.fn();
    const exec = mk({ client: new RuntimeClient({ metaPath }), onFallback: seen });
    await exec(['worktree', 'ps', '--json']);
    expect(cliCalls).toEqual([['worktree', 'ps', '--json']]);
    expect(seen).toHaveBeenCalledOnce();
  });

  it('reports the fallback once per outage, not on every poll, and reports the recovery', async () => {
    await writeMeta(token, join(dir, 'gone.sock'));
    const down = vi.fn();
    const up = vi.fn();
    const exec = mk({ client: new RuntimeClient({ metaPath }), onFallback: down, onRecover: up });
    await exec(['worktree', 'ps', '--json']);
    await exec(['terminal', 'list', '--json']);
    expect(down).toHaveBeenCalledOnce();
    await writeMeta();
    await exec(['worktree', 'ps', '--json']);
    await exec(['worktree', 'ps', '--json']);
    expect(up).toHaveBeenCalledOnce();
    expect(down).toHaveBeenCalledOnce();
  });

  it('returns to the socket once Orca is back, with no further CLI spawns', async () => {
    await writeMeta(token, join(dir, 'gone.sock'));
    const exec = mk({ client: new RuntimeClient({ metaPath }) });
    await exec(['worktree', 'ps', '--json']);
    expect(cliCalls).toHaveLength(1);
    await writeMeta();
    await exec(['worktree', 'ps', '--json']);
    await exec(['terminal', 'list', '--json']);
    expect(cliCalls).toHaveLength(1);
  });

  it('does not fall back on a runtime error: the caller must see it', async () => {
    handler = () => {
      throw Object.assign(new Error('bad'), { code: 'invalid_argument' });
    };
    await expect(mk()(['worktree', 'ps', '--json'])).rejects.toBeInstanceOf(RuntimeError);
    expect(cliCalls).toEqual([]);
  });

  it('passes unknown commands to the CLI', async () => {
    await mk()(['worktree', 'set', '--read', '--json']);
    expect(cliCalls).toEqual([['worktree', 'set', '--read', '--json']]);
  });

  it('reports a not-ready graph as a runtime state, not as running', async () => {
    handler = () => ({ graphStatus: 'starting', appVersion: '1.4.245' });
    const h = await new CliAdapter(mk()).health();
    expect(h.orcaRunning).toBe(false);
  });
});
