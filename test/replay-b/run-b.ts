import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { decodeKey } from '@orca-agent-deck/core';
import { defaultMetaPath } from '@orca-agent-deck/adapter-runtime';
import {
  BridgeSimulator,
  FakeRuntime,
  applyOrca,
  newState,
  row,
  advance,
  writeStateFile,
  type Scenario,
  type Step,
} from '@orca-agent-deck/fake-orca';
import { ACTION, FakeHost } from './host.ts';
import { PROFILES, type Profile } from './profiles.ts';
import { replayBudget } from '../replay-budget.ts';

/**
 * Plays a side-`b` scenario into the built `bin/plugin.js` through a fake Stream Deck host (host.ts), with Orca
 * simulated by the same SimState the other runners use: the runtime socket (or, with `runtime: false`, the CLI
 * shim) and plugin A played by the BridgeSimulator from the `bridge.frame from:"a"` lines.
 * Plugin B runs on real time, so `at` only orders steps, except the gap between a keyDown and its keyUp (a hold).
 * Checks wait for the state to arrive (one scaled deadline for every scenario, see replay-budget.ts); nothing here sleeps for a fixed time except a short settle
 * to catch messages that should not be there. There is no timeline snapshot: spinner frames and poll timing
 * make one unstable, the `expect.*` lines carry the intent.
 */

const SETTLE_MS = 30;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A bundled runner (replay-e2e) has no source tree next to it: the script says where the repository is.
const REPO = process.env['REPLAY_REPO'] ?? resolve(import.meta.dirname, '../..');
const SD = join(REPO, 'packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin');

type Frame = Record<string, unknown>;
type Action = keyof typeof ACTION;

function subset(want: unknown, got: unknown): boolean {
  if (want === null || typeof want !== 'object') return want === got;
  if (got === null || typeof got !== 'object') return false;
  // A list inside a message (the Setup checks, the pane list) is matched as an ordered subsequence.
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return false;
    let at = 0;
    return want.every((w) => {
      while (at < got.length && !subset(w, got[at])) at++;
      return at++ < got.length;
    });
  }
  return Object.entries(want).every(([k, v]) => subset(v, (got as Record<string, unknown>)[k]));
}
const lines = (xs: unknown[]) =>
  xs.length ? xs.map((x) => `    ${JSON.stringify(x)}`).join('\n') : '    (none)';

/** A profile id, or a family (`elgato`, `opendeck`) resolved to the profile of that family for this OS. */
function resolveProfile(name: string): Profile {
  const p =
    PROFILES[name] ??
    Object.values(PROFILES).find((x) => x.os === process.platform && x.expect.host === name);
  if (!p) throw new Error(`no host profile "${name}" for ${process.platform}`);
  return p;
}

/** Orca's runtime endpoint: a unix socket, or a named pipe on Windows (what Orca publishes there). */
const runtimeEndpoint = (root: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\orca-replay-${process.pid}-${Date.now()}-rt`
    : join(root, 'rt.sock');

/** Writes a node-script shim `name`; returns what to run (`name`, or `name.cmd` on Windows). */
async function writeShim(dir: string, name: string, js: string): Promise<string> {
  if (process.platform === 'win32') {
    await writeFile(join(dir, `${name}.js`), js);
    const cmd = join(dir, `${name}.cmd`);
    await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${join(dir, `${name}.js`)}" %*\r\n`);
    return cmd;
  }
  const file = join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\n${js}\n`);
  await chmod(file, 0o755);
  return file;
}

/**
 * Why a scenario cannot run starting on this profile, or null. A `deck.restart` that names a host with no profile for
 * the OS (there is no Elgato app on Linux) is a scenario for other machines: skipped there, not failed.
 */
export function missingHost(sc: Scenario, p: Profile): string | null {
  for (const st of sc.steps) {
    if (st.do !== 'deck.restart' || !st.profile) continue;
    const named = PROFILES[st.profile];
    const found = named
      ? named.os === p.os
      : Object.values(PROFILES).some((x) => x.os === p.os && x.expect.host === st.profile);
    if (!found) return `no ${st.profile} on ${p.os}`;
  }
  return null;
}

export const canRun = (p: Profile): string | null =>
  p.os === process.platform ? null : `needs ${p.os} (this is ${process.platform})`;

/**
 * Plugin A for the end-to-end loop: the real worker on Orca's `mountWorker`, started once B has published its
 * discovery file. With it, `orca.event` steps go to A and the frames A sends reach B for real, so a scenario's
 * `bridge.frame` lines from A are not played (the simulator would be a second A).
 */
export interface PluginA {
  mount(home: string): Promise<void>;
  emit(name: string, payload: unknown): Promise<void>;
  /** What the sidebar panel's `plugin.request` gets from the worker. */
  request(name: string, input?: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

/** Plays one scenario on one profile; resolves with how often the `orca` CLI shim ran (each run is a node start). */
export async function runB(
  sc: Scenario,
  profileId: string,
  a?: PluginA,
): Promise<{ orcaCalls: number }> {
  const budget = replayBudget();
  const TIMEOUT_MS = budget.ms;
  const profile = PROFILES[profileId]!;
  const root = await mkdtemp(join(tmpdir(), 'rb-'));
  const home = join(root, 'h');
  const bin = join(root, 'bin');
  const stage = join(root, 'sd');
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  await cp(SD, stage, { recursive: true, filter: (p) => basename(p) !== 'logs' });
  const stateFile = join(root, 'state.json');
  const openLog = join(root, 'open.log');
  const orcaLog = join(root, 'orca-calls.log');
  // Orca's CLI (the degraded path) and `open` (the window raise) are shims: nothing reaches the real Orca. One node
  // script each, on every OS; Windows runs it through a `.cmd` launcher (an `orca.cmd`, like Orca's own).
  const orcaBin = await writeShim(
    bin,
    'orca',
    `require('node:fs').appendFileSync(${JSON.stringify(orcaLog)}, 'x');
const { spawnSync } = require('node:child_process');
const r = spawnSync(process.execPath, ['--experimental-strip-types', ${JSON.stringify(join(REPO, 'packages/fake-orca/src/bin.ts'))}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);`,
  );
  await writeShim(
    bin,
    'open',
    `require('node:fs').appendFileSync(${JSON.stringify(openLog)}, process.argv.slice(2).join(' ') + '\\n');`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    XDG_CONFIG_HOME: join(home, '.config'),
    PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    ORCA_BIN: orcaBin,
    FAKE_ORCA_STATE: stateFile,
    ORCA_DECK_BRIDGE_PORTS: '0',
  };
  delete env['ORCA_DECK_HOST'];

  const s = newState();
  const t0 = s.now;
  const persist = () => writeStateFile(stateFile, s);
  persist();
  let runtime: FakeRuntime | null = null;
  if (sc.header.runtime) {
    const meta = defaultMetaPath(process.platform, env, home);
    await mkdir(dirname(meta), { recursive: true });
    runtime = new FakeRuntime({ state: () => s, sockPath: runtimeEndpoint(root), metaPath: meta });
    await runtime.start();
  }

  const host = new FakeHost(profile, { stage, env, deck: sc.header.deck });
  const layout = Object.entries(sc.header.keys).map(([k, v]) => ({
    key: Number(k),
    action: (typeof v === 'string' ? 'pane' : v.action) as Action,
    pane: typeof v === 'string' ? v : null,
  }));
  const actionOf = (key: number): Action => layout.find((l) => l.key === key)?.action ?? 'pane';
  const paneKey = (pane: string) => `tab-1:leaf-${pane}`;
  const handleOf = (pane: string) => s.panes.find((p) => p.leafId === `leaf-${pane}`)?.handle;
  const observed: string[] = [];
  const seen = new Map<number, string>();
  // Steps at t=0 are applied before the deck appears.
  const applied = new Set<Step>();
  let sim = null as BridgeSimulator | null;
  const discovery = join(home, '.orca-deck', 'bridge.json');
  let t = 0;

  const until = async (cond: () => boolean, what: string, detail: () => string) => {
    const end = Date.now() + TIMEOUT_MS;
    while (!cond()) {
      failIfBroken();
      if (Date.now() > end)
        throw new Error(
          `timed out after ${TIMEOUT_MS} ms (${budget.note}) waiting for ${what}\n${detail()}`,
        );
      await wait(10);
    }
  };
  const failIfBroken = () => {
    if (host.unknown.length)
      throw new Error(`plugin misbehaved: ${host.unknown.join('; ')}\n${host.stderr.slice(-800)}`);
  };
  const keyOfContext = (ctx: string) =>
    Array.from({ length: sc.header.deck.cols * sc.header.deck.rows }, (_, i) => i + 1).find(
      (k) => host.context(k) === ctx,
    ) ?? 0;
  const keyNow = (key: number) => {
    const img = host.images.get(host.context(key));
    return img ? decodeKey(img) : null;
  };
  const noteKeys = () => {
    for (const l of [
      ...layout,
      ...[...host.images.keys()].map((c) => ({ key: keyOfContext(c) })),
    ]) {
      const d = keyNow(l.key);
      const sig = d ? `${d.state}|${d.label}|${d.line2}` : '';
      if (d && seen.get(l.key) !== sig) {
        seen.set(l.key, sig);
        observed.push(
          row(t, l.key, '', { state: d.state, label: d.label, line2: d.line2 } as never),
        );
      }
    }
  };
  /**
   * A failure is easier to explain with the whole run than with its last lines: the plugin log, what
   * the host recorded and every key change go to a folder under the OS temp dir (never the repository).
   * The fakes produce no terminal content, so nothing here carries any.
   */
  const keepEvidence = async (name: string, profileId: string, message: string) => {
    const evidence = await mkdtemp(join(tmpdir(), `replay-fail-${name}-${profileId}-`));
    const save = (file: string, text: string) =>
      writeFile(join(evidence, file), text).catch(() => {});
    await save('error.txt', `${message}\n\nbudget: ${budget.note}\n`);
    await save('plugin.log', await readLogs(stage));
    await save('timeline.txt', `${observed.join('\n')}\n`);
    await save(
      'host.json',
      JSON.stringify(
        {
          piMessages: host.piMessages,
          alerts: host.alerts,
          unknown: host.unknown,
          settingsLog: host.settingsLog,
          globalSettings: host.globalSettings,
          stderr: host.stderr.slice(-4000),
          runtimeMethods: runtime ? runtime.requests.map((r) => r.method) : null,
        },
        null,
        2,
      ),
    );
    return evidence;
  };
  const timeline = () =>
    `  observed:\n${
      observed
        .slice(-12)
        .map((r) => `    ${r}`)
        .join('\n') || '    (no key images yet)'
    }`;

  const connectSim = async () => {
    await until(
      () => existsSync(discovery),
      'the bridge discovery file',
      () => '',
    );
    sim = new BridgeSimulator(discovery);
    await sim.connect();
  };

  /** The layout keys appear; a pane-slot key is pinned to its pane once B can see the pane. */
  const appearAll = () => {
    host.connectDevice();
    for (const l of layout) host.appear(l.key, l.action);
  };
  const pinAll = async () => {
    for (const l of layout) {
      if (!l.pane || !handleOf(l.pane)) continue;
      const pk = paneKey(l.pane);
      const pinned = () =>
        JSON.stringify(host.globalSettings).includes(`"paneKey":"${pk}"`) &&
        Object.values(
          (host.globalSettings['slots'] ?? {}) as Record<
            string,
            { mode?: string; pane?: { paneKey: string } }
          >,
        ).some((sl) => sl.mode === 'pinned' && sl.pane?.paneKey === pk);
      const end = Date.now() + TIMEOUT_MS;
      while (!pinned()) {
        failIfBroken();
        if (Date.now() > end)
          throw new Error(`pane ${l.pane} could not be pinned to key ${l.key}\n${timeline()}`);
        host.pi(l.key, 'pane', { type: 'configure', paneKey: pk });
        await wait(150);
      }
    }
  };

  try {
    await host.start();
    const steps = sc.steps;
    // Orca is up before the deck appears.
    for (const st of steps) {
      if (st.at !== 0 || !applyOrca(s, st)) continue;
      persist();
      applied.add(st);
    }
    appearAll();
    await pinAll();
    if (a) {
      await until(
        () => existsSync(discovery),
        'the bridge discovery file',
        () => '',
      );
      await a.mount(home);
    }
    for (let i = 0; i < steps.length;) {
      const at = steps[i]!.at;
      const group = steps.filter((x) => x.at === at);
      i += group.length;
      advance(s, at - (s.now - t0));
      t = at;
      const marks = {
        pi: host.piMessages.length,
        focus: runtime?.requests.length ?? 0,
        frames: sim?.received.length ?? 0,
      };
      const wantFrames: Frame[] = [];
      for (const st of group) {
        await apply(st, wantFrames);
      }
      for (const st of group) await check(st, marks);
      if (wantFrames.length) {
        const own = (m: Frame) =>
          !['challenge', 'proof', 'helloAck'].includes(String(m['type'])) ||
          wantFrames.some((w) => w['type'] === m['type']);
        const got = () => (sim?.received ?? []).slice(marks.frames).filter(own);
        await until(
          () => got().length >= wantFrames.length,
          `${wantFrames.length} frame(s) from B at t=${at}`,
          () => `  expected:\n${lines(wantFrames)}\n  actual:\n${lines(got())}`,
        );
        await wait(SETTLE_MS);
        if (got().length !== wantFrames.length || !wantFrames.every((w, k) => subset(w, got()[k])))
          throw new Error(
            `t=${at}: frames from B differ\n  expected:\n${lines(wantFrames)}\n  actual:\n${lines(got())}`,
          );
      }
    }
    failIfBroken();
    const log = await readLogs(stage);
    const want = `host: ${profile.expect.host} (${profile.expect.basis})`;
    // The plugin logs the Node it runs on: with REPLAY_NODE set (the Node 20 floor check) it must be that one.
    const nodeWant = process.env['REPLAY_NODE']
      ? `node ${execFileSync(process.env['REPLAY_NODE'], ['--version'], { encoding: 'utf8' }).trim()}`
      : `node ${process.version}`;
    if (!log.includes(nodeWant))
      throw new Error(
        `the plugin's host: line should end with "${nodeWant}"\n${log
          .split('\n')
          .filter((l) => l.includes('host:'))
          .join('\n')}`,
      );
    if (!log.includes(want))
      throw new Error(
        `the plugin's host: line should say "${want}"\n${
          log
            .split('\n')
            .filter((l) => l.includes('host:'))
            .join('\n') || '(no host: line)'
        }`,
      );
    return { orcaCalls: existsSync(orcaLog) ? readFileSync(orcaLog, 'utf8').length : 0 };
  } catch (e) {
    const log = (await readLogs(stage)).trim().split('\n').slice(-12).join('\n');
    const reqs = runtime
      ? ` runtime requests: ${[...new Set(runtime.requests.map((r) => r.method))].join(', ') || 'none'}\n`
      : '';
    const evidence = await keepEvidence(sc.header.name, profileId, (e as Error).message);
    throw new Error(
      `${(e as Error).message}\n${reqs}  plugin log:\n${log.replace(/^/gm, '    ')}\n  evidence: ${evidence}`,
    );
  } finally {
    sim?.close();
    await a?.stop().catch(() => {});
    await host.stop().catch(() => {});
    await runtime?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  async function apply(st: Step, wantFrames: Frame[]): Promise<void> {
    switch (st.do) {
      case 'deck.device':
        return void (st.connected ? host.connectDevice() : host.disconnectDevice());
      case 'deck.appear':
        return host.appear(st.key, actionOf(st.key));
      case 'deck.disappear':
        return host.disappear(st.key, actionOf(st.key));
      case 'deck.down':
        return host.key('keyDown', st.key, actionOf(st.key));
      case 'deck.up': {
        // A hold is a real wait between down and up; everything else runs as fast as B answers.
        const down = [...sc.steps]
          .reverse()
          .find((x) => x.do === 'deck.down' && x.key === st.key && x.at <= st.at);
        if (down && st.at > down.at) await wait(st.at - down.at);
        return host.key('keyUp', st.key, actionOf(st.key));
      }
      case 'deck.pi.open':
        return host.openPi(st.key, actionOf(st.key));
      case 'deck.pi.send':
        return host.pi(st.key, actionOf(st.key), st.message);
      case 'deck.restart': {
        sim?.close();
        sim = null;
        await host.stop();
        // What the old process drew is gone with it: only the new one's images count.
        host.images.clear();
        seen.clear();
        if (st.profile) {
          const next = resolveProfile(st.profile);
          // Another host app has its own settings store: only the mappings file is shared.
          if (next.id !== host.profile.id) host.globalSettings = {};
          host.profile = next;
        }
        await host.start();
        // Not pinned again: the mappings must have survived the restart (and the host switch) by themselves.
        appearAll();
        return;
      }
      case 'orca.event':
        if (a) await a.emit(st.name, st.payload);
        return;
      case 'bridge.frame':
        if (st.from === 'a') {
          if (a) return;
          if (!sim) await connectSim();
          sim!.send({ v: 1, ...st.frame });
        } else wantFrames.push(st.frame as Frame);
        return;
      default:
        if (applied.has(st)) return;
        if (applyOrca(s, st)) return persist();
        // Steps of the other runners (plugin A's events, expectations checked below).
        if (/^(orca\.|expect\.)/.test(st.do)) return;
        throw new Error(`t=${st.at}: the B runner cannot play ${st.do}`);
    }
  }

  async function check(st: Step, marks: { pi: number; focus: number }): Promise<void> {
    if (st.do === 'expect.key') {
      if ('host' in st && st.host !== undefined)
        throw new Error(`t=${st.at}: the B runner cannot evaluate expect.key host`);
      const mismatch = () => {
        const d = keyNow(st.key);
        const got = {
          state: d?.state,
          label: d?.label,
          line2: d?.line2,
          badge: d ? d.agent || null : undefined,
          number: d?.number,
        };
        return (['state', 'label', 'line2', 'badge', 'number'] as const).flatMap((f) => {
          const want = st[f];
          return want !== undefined && got[f] !== want
            ? [`${f}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got[f])}`]
            : [];
        });
      };
      await until(
        () => (noteKeys(), mismatch().length === 0),
        `key ${st.key} at t=${st.at}`,
        () => `  ${mismatch().join('\n  ')}\n${timeline()}`,
      );
    } else if (st.do === 'expect.pi') {
      const ctx = host.context(st.key);
      // Consecutive identical messages count once: Elgato's inspector asks for its state at appear and again on load.
      const got = () =>
        host.piMessages
          .slice(marks.pi)
          .filter((m) => m.context === ctx)
          .map((m) => m.payload as Frame)
          .filter((x, i, xs) => i === 0 || JSON.stringify(x) !== JSON.stringify(xs[i - 1]));
      await until(
        () => got().length >= st.messages.length,
        `${st.messages.length} message(s) to key ${st.key}'s inspector at t=${st.at}`,
        () => `  expected:\n${lines(st.messages)}\n  actual:\n${lines(got())}`,
      );
      await wait(SETTLE_MS);
      if (got().length !== st.messages.length || !st.messages.every((w, k) => subset(w, got()[k])))
        throw new Error(
          `t=${st.at}: messages to key ${st.key}'s inspector differ\n  expected:\n${lines(st.messages)}\n  actual:\n${lines(got())}`,
        );
    } else if (st.do === 'expect.focus') {
      const handle = handleOf(st.pane);
      // Through the runtime socket the fake records the request; on the CLI path the shim saves what it focused.
      const calls = () =>
        runtime
          ? runtime.requests
              .slice(marks.focus)
              .filter((r) => r.method === 'terminal.focus')
              .map((r) => r.params['terminal'])
          : [
              (JSON.parse(readFileSync(stateFile, 'utf8')) as { focusedHandle?: string })
                .focusedHandle,
            ];
      await until(
        () => calls().includes(handle),
        `Orca to be asked to focus pane ${st.pane} at t=${st.at}`,
        () => `  focus requests: ${JSON.stringify(calls())}`,
      );
    } else if (st.do === 'expect.panel') {
      if (!a) throw new Error(`t=${st.at}: expect.panel needs plugin A (the end-to-end suite)`);
      let got: unknown;
      const once = async () => (got = await a.request(st.request, st.input));
      if (st.request === 'deck.get') {
        const end = Date.now() + TIMEOUT_MS;
        while (!subset(st.result, await once())) {
          if (Date.now() > end) break;
          await wait(100);
        }
      } else await once();
      if (!subset(st.result, got))
        throw new Error(
          `t=${st.at}: panel ${st.request} answered ${JSON.stringify(got)}, wanted ${JSON.stringify(st.result)}`,
        );
    } else if (st.do === 'expect.reveal') {
      throw new Error(`t=${st.at}: the B runner cannot evaluate expect.reveal`);
    }
  }
}

async function readLogs(stage: string): Promise<string> {
  const dir = join(stage, 'logs');
  const files = existsSync(dir) ? await readdir(dir) : [];
  return (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n');
}
