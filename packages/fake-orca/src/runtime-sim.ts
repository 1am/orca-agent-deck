import { createServer, type Server, type Socket } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { hostList, terminalList, worktreePs } from './render.ts';
import { focus, type SimState } from './sim.ts';

/**
 * Fake Orca runtime socket: NDJSON, one request per connection, token in every
 * request, `_keepalive` frames allowed first. Answers from a SimState, so the same scenario can be
 * read through the CLI shim or through this socket. Also writes the `orca-runtime.json` file.
 */
export class FakeRuntime {
  private server: Server | null = null;
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  token: string;
  private readonly getState: () => SimState;
  private readonly sockPath: string;
  private readonly metaPath: string;

  constructor(opts: { state: () => SimState; sockPath: string; metaPath: string; token?: string }) {
    this.getState = opts.state;
    this.sockPath = opts.sockPath;
    this.metaPath = opts.metaPath;
    this.token = opts.token ?? 'fake-runtime-token';
  }

  async start(): Promise<void> {
    this.server = createServer((sock) => this.serve(sock));
    await new Promise<void>((r) => this.server?.listen(this.sockPath, r));
    await this.writeMeta();
  }

  /** Simulates Orca quitting: socket gone, file left behind (as the real app does). */
  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => s.close(r));
  }

  /** Simulates an Orca restart: new token, same path in the test. */
  async restart(token: string): Promise<void> {
    await this.stop();
    this.token = token;
    await this.start();
  }

  get running(): boolean {
    return this.server !== null;
  }

  private writeMeta(): Promise<void> {
    return writeFile(
      this.metaPath,
      JSON.stringify({
        runtimeId: 'fake-runtime',
        authToken: this.token,
        transports: [
          { kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint: this.sockPath },
          { kind: 'websocket', endpoint: 'ws://127.0.0.1:1' },
        ],
      }),
      { mode: 0o600 },
    );
  }

  private serve(sock: Socket): void {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (c: string) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i)) as {
        id: string;
        authToken: string;
        method: string;
        params?: Record<string, unknown>;
      };
      this.requests.push({ method: req.method, params: req.params ?? {} });
      sock.write(JSON.stringify({ _keepalive: true }) + '\n');
      const reply = (o: object) => sock.end(JSON.stringify({ id: req.id, ...o }) + '\n');
      if (req.authToken !== this.token) {
        return reply({ ok: false, error: { code: 'unauthorized', message: 'bad token' } });
      }
      try {
        reply({ ok: true, result: this.handle(req.method, req.params ?? {}) });
      } catch (e) {
        const err = e as { code?: string; message: string };
        reply({ ok: false, error: { code: err.code ?? 'internal', message: err.message } });
      }
    });
  }

  private handle(method: string, params: Record<string, unknown>): unknown {
    const s = this.getState();
    switch (method) {
      case 'status.get':
        return { graphStatus: 'ready', appVersion: s.appVersion };
      case 'terminal.list':
        return terminalList(s).result;
      case 'worktree.ps':
        return worktreePs(s).result;
      case 'ssh.listTargets':
        return {
          targets: hostList(s)
            .result.hosts.filter((h: { kind: string }) => h.kind === 'ssh')
            .map((h: { id: string; name: string; connected?: boolean }) => ({
              id: h.id,
              label: h.name,
              connected: h.connected ?? false,
            })),
        };
      case 'terminal.focus': {
        const handle = params['terminal'];
        if (typeof handle !== 'string') {
          throw Object.assign(new Error('Missing terminal handle'), { code: 'invalid_argument' });
        }
        try {
          focus(s, handle);
        } catch (e) {
          throw Object.assign(e as Error, { code: 'terminal_handle_stale' });
        }
        return { focus: { navigated: true, handle } };
      }
      case 'worktree.set':
        if (typeof params['worktree'] !== 'string') {
          throw Object.assign(new Error('Missing worktree selector'), { code: 'invalid_argument' });
        }
        return { worktree: { id: params['worktree'], isUnread: params['isUnread'] === true } };
      case 'terminal.resolveActive':
        if (!s.focusedHandle)
          throw Object.assign(new Error('no active terminal'), { code: 'no_active_terminal' });
        return { handle: s.focusedHandle };
      case 'terminal.show': {
        const p = s.panes.find((x) => x.handle === params['terminal']);
        if (!p)
          throw Object.assign(new Error('terminal_handle_stale'), {
            code: 'terminal_handle_stale',
          });
        return { terminal: { tabId: p.tabId, leafId: p.leafId } };
      }
      default:
        throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'method_not_found' });
    }
  }
}
