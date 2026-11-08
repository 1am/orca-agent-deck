import { WebSocket } from 'ws';
import { authMac, newNonce, proofMac, readDiscovery } from '@orca-agent-deck/adapter-bridge';
import type { SimState } from './sim.ts';

type Sent = Record<string, unknown>;

/**
 * Plays plugin A against a real plugin B bridge server, driven by the same SimState
 * the CLI shim uses, so one scenario can be replayed over the CLI and over the bridge.
 */
export class BridgeSimulator {
  private ws: WebSocket | null = null;
  readonly received: Sent[] = [];
  private readonly discoveryPath: string;
  private readonly versions: { orca: string; plugin: string };

  constructor(discoveryPath: string, versions = { orca: '1.4.245', plugin: '0.1.0' }) {
    this.discoveryPath = discoveryPath;
    this.versions = versions;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Reads the discovery file (like A does on every connect), answers B's challenge, checks B's
   * proof and says hello. Resolves after the ack. `token` overrides the one used for the MAC.
   */
  async connect(overrides: { token?: string; v?: number } = {}): Promise<void> {
    const d = await readDiscovery(this.discoveryPath);
    if (!d) throw new Error('no bridge discovery file');
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
    this.ws = ws;
    // Only messages of this connection count for the handshake.
    const from = this.received.length;
    const fresh = (type: string) => (m: Sent) =>
      m['type'] === type && this.received.indexOf(m) >= from;
    ws.on('message', (raw) => this.received.push(JSON.parse(String(raw)) as Sent));
    ws.on('error', () => {});
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const closed = new Promise<never>((_, rej) =>
      ws.once('close', (code) => rej(new Error(`bridge closed the connection (${code})`))),
    );
    const token = overrides.token ?? d.token;
    const challenge = await Promise.race([this.waitFor(fresh('challenge')), closed]);
    const nonceB = String(challenge['nonce']);
    const nonceA = newNonce();
    this.send({ v: 1, type: 'auth', nonce: nonceA, mac: authMac(token, nonceB, nonceA) });
    const proof = await Promise.race([this.waitFor(fresh('proof')), closed]);
    if (proof['mac'] !== proofMac(token, nonceA, nonceB))
      throw new Error('bridge failed the proof');
    this.send({
      v: overrides.v ?? 1,
      type: 'hello',
      orcaVersion: this.versions.orca,
      pluginVersion: this.versions.plugin,
    });
    await Promise.race([this.waitFor(fresh('helloAck')), closed]);
  }

  send(msg: Sent): void {
    this.ws?.send(JSON.stringify(msg));
  }

  /** Sends the current agent state of a pane in the sim (what `agent.status.changed` would carry). */
  sendStatus(s: SimState, key: string): void {
    const p = s.panes.find((x) => x.leafId === `leaf-${key}`);
    if (!p?.agent) throw new Error(`pane ${key} has no agent`);
    this.send({
      v: 1,
      type: 'agentStatus',
      paneKey: `${p.tabId}:${p.leafId}`,
      workspaceId: 'ws1',
      state: p.agent.state,
      outcome: null,
      stateStartedAt: p.agent.stateStartedAt,
      receivedAt: s.now,
    });
  }

  /** Re-sends every agent's state, like A does after a reconnect or `requestSnapshot`. */
  replay(s: SimState): void {
    for (const p of s.panes) if (p.agent) this.sendStatus(s, p.leafId.slice(5));
  }

  pairRequest(
    requestId: string,
    pane: { paneKey: string; worktreeId: string } | null = null,
  ): void {
    this.send({ v: 1, type: 'pairRequest', requestId, pane });
  }

  async waitFor(pred: (m: Sent) => boolean, ms = 3000): Promise<Sent> {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.received.find(pred);
      if (m) return m;
      if (Date.now() > end) throw new Error('bridge simulator: timeout waiting for message');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Drops the connection without a goodbye (worker idled out or Orca quit). */
  drop(): void {
    this.ws?.terminate();
    this.ws = null;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
