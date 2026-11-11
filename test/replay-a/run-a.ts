import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeServer,
  removeDiscovery,
  writeDiscovery,
  type Discovery,
} from '@orca-agent-deck/adapter-bridge';
import type { Scenario, Step } from '@orca-agent-deck/fake-orca';

/**
 * Plays a side-`a` scenario into the real plugin A (`orca-plugin/main.mjs`) on Orca's `mountWorker`, with the real
 * BridgeServer as plugin B. A runs on real time: `at` only orders the steps, and the runner waits for frames or
 * conditions to arrive (never a fixed sleep) except a short settle to catch frames that should not be there.
 *
 * Test-only workaround: A has no stop handle and real Orca kills the worker process on idle-out, so every worker
 * start here gets a new HOME (A reads `$HOME/.orca-deck/bridge.json` on each connect) and the old discovery file
 * is removed; the old instance then finds nothing and stays quiet instead of fighting the new one over B.
 */

type Frame = Record<string, unknown>;
interface Worker {
  emit(event: string, payload: unknown): Promise<void>;
  command(id: string, args?: unknown): Promise<unknown>;
  deactivate(): Promise<void>;
  logs: string[];
}
export interface Env {
  mountWorker(
    module: unknown,
    options: { events: string[]; hooks: string[]; commands: string[] },
  ): Promise<Worker>;
  plugin: unknown;
  manifest: { contributes: { events: { on: string }[]; commands: { id: string }[] } };
}

const TIMEOUT_MS = 4000;
const SETTLE_MS = 30;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + TIMEOUT_MS;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${what}`);
    await wait(5);
  }
}

/** Every listed field of `want` equals the same field of `got` (extra fields in `got` are fine). */
function subset(want: unknown, got: unknown): boolean {
  if (want === null || typeof want !== 'object') return want === got;
  if (got === null || typeof got !== 'object') return false;
  if (Array.isArray(want))
    return (
      Array.isArray(got) && want.length === got.length && want.every((w, i) => subset(w, got[i]))
    );
  return Object.entries(want).every(([k, v]) => subset(v, (got as Record<string, unknown>)[k]));
}

const lines = (frames: Frame[]) =>
  frames.length ? frames.map((f) => `    ${JSON.stringify(f)}`).join('\n') : '    (none)';

/** The real BridgeServer, restartable, recording what A sends. */
class FakeB {
  frames: Frame[] = [];
  deck = false;
  lastRequestId = '';
  private server: BridgeServer | null = null;
  private disc: Discovery | null = null;
  path: string;
  constructor(path: string) {
    this.path = path;
  }

  get connected(): boolean {
    return this.server?.connection != null;
  }

  async up(): Promise<void> {
    const server = new BridgeServer({
      discoveryPath: this.path,
      ports: [0],
      deck: () => ({
        connected: this.deck,
        devices: this.deck ? [{ model: 'MK.2', keys: 15 }] : [],
      }),
    });
    server.on('hello', (info) => this.frames.push({ type: 'hello', ...info }));
    server.on('message', (m) => {
      if (m.type === 'pairRequest') this.lastRequestId = m.requestId;
      this.frames.push({ ...m });
    });
    this.disc = await server.start();
    this.server = server;
  }

  /** `stale` leaves the discovery file behind, as a crashed B does. */
  async down(stale: boolean): Promise<void> {
    await this.server?.stop();
    this.server = null;
    if (stale && this.disc) await writeDiscovery(this.path, this.disc);
  }

  /** A restarted worker has another HOME (see `activate`), so B publishes where it will look. */
  async move(path: string): Promise<void> {
    if (this.disc) await writeDiscovery(path, this.disc);
    await removeDiscovery(this.path);
    this.path = path;
  }

  send(frame: Frame): void {
    const text = JSON.stringify(frame).replace('"$requestId"', JSON.stringify(this.lastRequestId));
    if (!this.server?.send(JSON.parse(text))) throw new Error(`B could not send ${text}`);
  }
}

export async function runA(sc: Scenario, env: Env): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'replay-a-'));
  const homeOf = (g: number) => join(root, `home${g}`);
  const discoveryOf = (g: number) => join(homeOf(g), '.orca-deck', 'bridge.json');
  const b = new FakeB(discoveryOf(1));
  let gen = 0;
  let worker: Worker | null = null;
  let lastLogs: string[] = [];
  const realHome = process.env.HOME;

  const activate = async () => {
    gen++;
    // A reads `$HOME/.orca-deck/bridge.json` on every connect; a new HOME per start also lets an old
    // instance of A (which has no way to be killed here) find nothing and stay quiet.
    await mkdir(join(homeOf(gen), '.orca-deck'), { recursive: true, mode: 0o700 });
    process.env.HOME = homeOf(gen);
    if (gen > 1) await b.move(discoveryOf(gen));
    worker = await env.mountWorker(env.plugin, {
      events: env.manifest.contributes.events.map((e) => e.on),
      hooks: [],
      commands: env.manifest.contributes.commands.map((c) => c.id),
    });
  };

  const apply = async (step: Step): Promise<void> => {
    switch (step.do) {
      case 'orca.activate':
        return activate();
      case 'orca.deactivate':
        lastLogs = worker?.logs ?? [];
        await worker?.deactivate();
        worker = null;
        return;
      case 'orca.event':
        return worker!.emit(step.name, step.payload);
      case 'orca.command': {
        const result = await worker!.command(step.id, step.args);
        if (step.result !== undefined && result !== step.result)
          throw new Error(
            `t=${step.at}: command ${step.id} returned ${JSON.stringify(result)}, expected ${JSON.stringify(step.result)}`,
          );
        if (step.resultContains !== undefined && !String(result).includes(step.resultContains))
          throw new Error(
            `t=${step.at}: command ${step.id} returned ${JSON.stringify(result)}, expected it to contain ${JSON.stringify(step.resultContains)}`,
          );
        return;
      }
      case 'expect.log': {
        const has = () => (worker?.logs ?? lastLogs).some((l) => l.includes(step.contains));
        await until(has, `a log line containing ${JSON.stringify(step.contains)}`).catch(
          (e: Error) => {
            throw new Error(
              `t=${step.at}: ${e.message}\n${lines((worker?.logs ?? lastLogs).slice(-8).map((l) => ({ log: l })))}`,
            );
          },
        );
        return;
      }
      case 'expect.file': {
        const path = join(homeOf(gen), step.path);
        if (existsSync(path) !== step.exists)
          throw new Error(
            `t=${step.at}: ${step.path} under the worker's HOME should ${step.exists ? '' : 'not '}exist`,
          );
        if (step.contains === undefined && step.notContains === undefined) return;
        // A recording is written asynchronously and named by its start time: read every file of the folder.
        const text = (
          await Promise.all(
            (statSync(path).isDirectory()
              ? readdirSync(path).map((f) => join(path, f))
              : [path]
            ).map((f) => readFile(f, 'utf8')),
          )
        ).join('\n');
        if (step.contains !== undefined && !text.includes(step.contains))
          throw new Error(
            `t=${step.at}: ${step.path} should contain ${JSON.stringify(step.contains)}`,
          );
        if (step.notContains !== undefined && text.includes(step.notContains))
          throw new Error(
            `t=${step.at}: ${step.path} should not contain ${JSON.stringify(step.notContains)}`,
          );
        return;
      }
      case 'deck.device':
        b.deck = step.connected;
        return;
      case 'deck.restart':
        await b.down(step.up === false);
        if (step.up !== false) await b.up();
        return;
      case 'bridge.frame':
        if (step.from === 'b') {
          await until(() => b.connected, 'A to connect before B sends a frame');
          b.send(step.frame);
        }
        return;
      default:
        // Steps for the other runners of a shared scenario (Orca panes and the deck's keys), not A's.
        if (/^(orca\.(pane|agent|host|plugin|restart|focus)|deck\.|expect\.)/.test(step.do)) return;
        throw new Error(`t=${step.at}: the A runner cannot play ${step.do}`);
    }
  };

  try {
    await mkdir(join(homeOf(1), '.orca-deck'), { recursive: true, mode: 0o700 });
    await b.up();
    if (!sc.steps.some((s) => s.do === 'orca.activate')) await activate();
    for (let i = 0; i < sc.steps.length;) {
      const at = sc.steps[i]!.at;
      const group = sc.steps.filter((s) => s.at === at);
      i += group.length;
      const mark = b.frames.length;
      const expected = group.flatMap((s) =>
        s.do === 'bridge.frame' && s.from === 'a' ? [s.frame as Frame] : [],
      );
      for (const step of group) await apply(step);
      await until(
        () => b.frames.length - mark >= expected.length,
        `${expected.length} frame(s) from A at t=${at}`,
      ).catch((e: Error) => {
        throw new Error(
          `${e.message}\n  expected:\n${lines(expected)}\n  actual:\n${lines(b.frames.slice(mark))}`,
        );
      });
      await wait(SETTLE_MS);
      // A reconnect says hello each time; only a scenario that lists it asserts it.
      const wantsHello = expected.some((f) => f['type'] === 'hello');
      const actual = b.frames.slice(mark).filter((f) => wantsHello || f['type'] !== 'hello');
      if (actual.length !== expected.length || !expected.every((w, k) => subset(w, actual[k])))
        throw new Error(
          `t=${at}: frames from A differ\n  expected:\n${lines(expected)}\n  actual:\n${lines(actual)}`,
        );
    }
  } finally {
    await b.down(false).catch(() => {});
    process.env.HOME = realHome;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
