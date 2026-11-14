import { type ChildProcess, spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import type { Profile } from './profiles.ts';

type Msg = Record<string, unknown> & { event?: string; context?: string };

/** What plugin B may send to a host: the SDK calls on the allowlist in `host.ts` (SDK_CALLS), as wire events. */
const KNOWN = new Set([
  'registerPlugin',
  'getGlobalSettings',
  'setGlobalSettings',
  'setImage',
  'setTitle',
  'sendToPropertyInspector',
  'showAlert',
  'showOk',
  'logMessage',
]);

const UUID = 'pl.1am.orca-agent-deck';
export const ACTION = {
  pane: `${UUID}.pane`,
  status: `${UUID}.status`,
  attention: `${UUID}.attention`,
} as const;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HostOptions {
  /** Staged copy of the .sdPlugin folder: the SDK reads manifest.json from, and logs to, the working directory. */
  stage: string;
  env: NodeJS.ProcessEnv;
  deck: { cols: number; rows: number };
}

/** A Stream Deck host for tests: speaks the plugin protocol to the built `bin/plugin.js` and records what it sends. */
export class FakeHost {
  profile: Profile;
  readonly images = new Map<string, string>();
  readonly piMessages: { context: string; payload: unknown }[] = [];
  readonly alerts: string[] = [];
  /** Messages B sent that a host has no business receiving; any entry fails the run. */
  readonly unknown: string[] = [];
  globalSettings: Record<string, unknown> = {};
  /** Every setGlobalSettings payload, so a test can see mappings being saved. */
  readonly settingsLog: Record<string, unknown>[] = [];
  private readonly opts: HostOptions;
  private wss: WebSocketServer | null = null;
  private ws: WebSocket | null = null;
  private child: ChildProcess | null = null;
  private output = '';
  private opened: string | null = null;

  constructor(profile: Profile, opts: HostOptions) {
    this.profile = profile;
    this.opts = opts;
  }

  get stderr(): string {
    return this.output;
  }

  /** Starts the plugin as this host's current profile and waits until it has registered. */
  async start(): Promise<void> {
    this.opened = null;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.on('listening', r));
    this.wss = wss;
    const registered = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        this.ws = ws;
        ws.on('message', (raw) => {
          const m = JSON.parse(String(raw)) as Msg;
          this.receive(m);
          if (m.event === 'registerPlugin') resolve();
        });
      });
    });
    const p = this.profile;
    const info = {
      application: {
        font: 'x',
        language: 'en',
        platform: p.platform,
        platformVersion: p.platformVersion,
        version: p.version,
      },
      plugin: { uuid: UUID, version: '0.0.0' },
      devicePixelRatio: p.devicePixelRatio,
      colors: {},
      devices: [this.deviceInfo()],
    };
    const port = (wss.address() as { port: number }).port;
    this.output = '';
    this.child = spawn(
      // REPLAY_NODE picks the node binary the plugin runs on (the Node 20 floor check); default: this one.
      process.env['REPLAY_NODE'] || process.execPath,
      [
        'bin/plugin.js',
        '-port',
        String(port),
        '-pluginUUID',
        UUID,
        '-registerEvent',
        'registerPlugin',
        '-info',
        JSON.stringify(info),
      ],
      { cwd: this.opts.stage, env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const s of [this.child.stdout, this.child.stderr])
      s?.on('data', (d: Buffer) => (this.output += String(d)));
    this.child.on('exit', (code) => {
      if (this.child && code) this.unknown.push(`plugin exited with code ${code}`);
    });
    await Promise.race([
      registered,
      wait(5000).then(() => {
        throw new Error(`plugin did not register within 5 s\n${this.output}`);
      }),
    ]);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, wait(2000).then(() => child.kill('SIGKILL'))]);
    }
    this.ws?.terminate();
    this.ws = null;
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.wss = null;
  }

  private deviceInfo() {
    const { cols, rows } = this.opts.deck;
    return {
      id: this.profile.deviceId,
      name: 'Stream Deck MK.2',
      type: 7,
      size: { columns: cols, rows },
    };
  }

  private receive(m: Msg): void {
    const ev = m.event ?? '';
    if (process.env['REPLAY_DEBUG']) console.error('B>', JSON.stringify(m).slice(0, 160));
    if (!KNOWN.has(ev)) {
      this.unknown.push(`B sent ${ev || '(no event)'}: ${JSON.stringify(m).slice(0, 200)}`);
      return;
    }
    const ctx = m.context ?? '';
    const payload = m['payload'] as Record<string, unknown> | undefined;
    if (ev === 'getGlobalSettings')
      this.send({ event: 'didReceiveGlobalSettings', payload: { settings: this.globalSettings } });
    else if (ev === 'setGlobalSettings') {
      this.globalSettings = (payload ?? {}) as Record<string, unknown>;
      this.settingsLog.push(this.globalSettings);
    } else if (ev === 'setImage' && typeof payload?.['image'] === 'string')
      this.images.set(ctx, payload['image']);
    else if (ev === 'sendToPropertyInspector') this.piMessages.push({ context: ctx, payload });
    else if (ev === 'showAlert') this.alerts.push(ctx);
  }

  private send(msg: object): void {
    if (process.env['REPLAY_DEBUG']) console.error('H>', JSON.stringify(msg).slice(0, 160));
    this.ws?.send(JSON.stringify(msg));
  }

  // --- host to plugin -------------------------------------------------------------------------

  connectDevice(): void {
    this.send({
      event: 'deviceDidConnect',
      device: this.profile.deviceId,
      deviceInfo: this.deviceInfo(),
    });
  }

  disconnectDevice(): void {
    this.send({ event: 'deviceDidDisconnect', device: this.profile.deviceId });
  }

  context(key: number): string {
    return this.profile.context(key);
  }

  private coordinates(key: number) {
    const { cols } = this.opts.deck;
    return { column: (key - 1) % cols, row: Math.floor((key - 1) / cols) };
  }

  appear(key: number, action: keyof typeof ACTION): void {
    this.send({
      event: 'willAppear',
      action: ACTION[action],
      context: this.context(key),
      device: this.profile.deviceId,
      payload: {
        settings: {},
        coordinates: this.coordinates(key),
        controller: 'Keypad',
        state: 0,
        isInMultiAction: false,
      },
    });
    // OpenDeck mounts every action's PI at once, hidden, and it asks for its state at once.
    if (this.profile.hiddenPis && action !== 'attention') this.pi(key, action, { type: 'load' });
  }

  disappear(key: number, action: keyof typeof ACTION): void {
    this.send({
      event: 'willDisappear',
      action: ACTION[action],
      context: this.context(key),
      device: this.profile.deviceId,
      payload: {
        settings: {},
        coordinates: this.coordinates(key),
        controller: 'Keypad',
        state: 0,
        isInMultiAction: false,
      },
    });
  }

  key(event: 'keyDown' | 'keyUp', key: number, action: keyof typeof ACTION): void {
    this.send({
      event,
      action: ACTION[action],
      context: this.context(key),
      device: this.profile.deviceId,
      payload: {
        settings: {},
        coordinates: this.coordinates(key),
        controller: 'Keypad',
        state: 0,
        userDesiredState: 0,
        isInMultiAction: false,
      },
    });
  }

  /** The user selects this key; Elgato loads its PI now (it asks for its state), OpenDeck's was loaded at appear. */
  openPi(key: number, action: keyof typeof ACTION): void {
    const context = this.context(key);
    if (this.opened && this.opened !== context)
      this.send({
        event: 'propertyInspectorDidDisappear',
        action: ACTION[action],
        context: this.opened,
        device: this.profile.deviceId,
      });
    this.opened = context;
    // The Elgato app's inspector connects and asks for its state before the app announces it (seen on macOS).
    if (!this.profile.hiddenPis) this.pi(key, action, { type: 'load' });
    this.send({
      event: 'propertyInspectorDidAppear',
      action: ACTION[action],
      context,
      device: this.profile.deviceId,
    });
  }

  pi(key: number, action: keyof typeof ACTION, message: unknown): void {
    this.send({
      event: 'sendToPlugin',
      action: ACTION[action],
      context: this.context(key),
      payload: message,
    });
  }
}
