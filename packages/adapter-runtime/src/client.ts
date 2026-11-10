import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Orca runtime discovery file. Contains the auth token: never log it. */
export interface RuntimeMeta {
  endpoint: string;
  authToken: string;
  runtimeId: string;
}

export function defaultMetaPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'darwin')
    return join(home, 'Library/Application Support/orca/orca-runtime.json');
  if (platform === 'win32')
    return join(env['APPDATA'] ?? join(home, 'AppData/Roaming'), 'orca/orca-runtime.json');
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'orca/orca-runtime.json');
}

/** Orca is not running, the runtime file is gone/garbled, or the socket cannot be reached. */
export class RuntimeUnavailableError extends Error {
  constructor(reason: string) {
    super(`orca runtime unavailable: ${reason}`);
    this.name = 'RuntimeUnavailableError';
  }
}

/** The runtime answered with `ok: false`. Carries the code, never the request. */
export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

export interface RuntimeFrame {
  id?: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/**
 * The runtime file holds Orca's auth token: use it only when it is a regular file of this user that
 * group and other cannot read (Orca writes it 0600). Not enforced on Windows.
 */
async function isPrivateFile(path: string): Promise<boolean> {
  if (process.platform === 'win32') return true;
  const st = await lstat(path);
  return st.isFile() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
}

export async function readMeta(path: string): Promise<RuntimeMeta | null> {
  try {
    if (!(await isPrivateFile(path))) return null;
    const j = JSON.parse(await readFile(path, 'utf8')) as {
      authToken?: unknown;
      runtimeId?: unknown;
      transports?: Array<{ kind?: unknown; endpoint?: unknown }>;
    };
    // Windows exposes the same socket as a named pipe; `createConnection` takes its path as-is.
    const t = j.transports?.find((x) => x.kind === 'unix' || x.kind === 'named-pipe');
    if (typeof j.authToken !== 'string' || typeof t?.endpoint !== 'string') return null;
    return {
      endpoint: t.endpoint,
      authToken: j.authToken,
      runtimeId: typeof j.runtimeId === 'string' ? j.runtimeId : '',
    };
  } catch {
    return null;
  }
}

/** Orca frames are NDJSON capped at 1 MB. */
const MAX_FRAME = 1_000_000;

export interface RuntimeClientOptions {
  metaPath?: string;
  timeoutMs?: number;
}

/**
 * Unix-socket client for the Orca runtime. Framing: NDJSON, ONE request per connection,
 * `{id, authToken, method, params}`; the reply is `{id, ok, result|error, _meta}`; `_keepalive`
 * frames may arrive first and are skipped. Orca rotates socket and token on every start, so
 * the file is re-read after a failed connect and the call retried once.
 */
export class RuntimeClient {
  private meta: RuntimeMeta | null = null;
  private readonly metaPath: string;
  private readonly timeoutMs: number;

  constructor(opts: RuntimeClientOptions = {}) {
    this.metaPath = opts.metaPath ?? defaultMetaPath();
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  /** Returns the `result` of a successful call. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const meta = (this.meta ??= await readMeta(this.metaPath));
      if (!meta) throw new RuntimeUnavailableError('no runtime file');
      try {
        const frame = await this.send(meta, method, params);
        if (frame.ok) return frame.result as T;
        const code = frame.error?.code ?? 'error';
        // A rotated token shows up as an auth error: refresh once like a failed connect.
        if (attempt === 0 && /auth|unauthor/i.test(code)) {
          this.meta = null;
          lastErr = new RuntimeError(code, frame.error?.message ?? '');
          continue;
        }
        throw new RuntimeError(code, frame.error?.message ?? '');
      } catch (e) {
        if (e instanceof RuntimeError) throw e;
        this.meta = null;
        lastErr = e;
      }
    }
    if (lastErr instanceof RuntimeError) throw lastErr;
    throw new RuntimeUnavailableError(String((lastErr as Error)?.message ?? lastErr));
  }

  private send(
    meta: RuntimeMeta,
    method: string,
    params: Record<string, unknown>,
  ): Promise<RuntimeFrame> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(meta.endpoint);
      let buf = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), this.timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect', () =>
        socket.write(
          JSON.stringify({ id: randomUUID(), authToken: meta.authToken, method, params }) + '\n',
        ),
      );
      socket.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_FRAME) return finish(() => reject(new Error('frame too large')));
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let frame: RuntimeFrame & { _keepalive?: unknown };
          try {
            frame = JSON.parse(line) as RuntimeFrame;
          } catch {
            return finish(() => reject(new Error('malformed frame')));
          }
          if (frame._keepalive) continue;
          return finish(() => resolve(frame));
        }
      });
      socket.on('error', (e) => finish(() => reject(e)));
      socket.on('close', () => finish(() => reject(new Error('closed before reply'))));
    });
  }
}
