import type {
  AdapterHealth,
  AgentRawState,
  FocusResult,
  HostInfo,
  OrcaAdapter,
  PaneRef,
  PaneStatusEvent,
  Snapshot,
} from '@orca-agent-deck/core';
import type { BridgeServer } from './server.ts';

const RAW_STATES = new Set<AgentRawState>(['working', 'waiting', 'blocked', 'done', 'idle']);

/** A pushed status plus when B received it (B's clock; `stateStartedAt` may be a remote host's). */
export type PushedStatus = PaneStatusEvent & { arrivedAt: number };

/**
 * Latest agent status per pane as pushed by plugin A. Status events are idempotent: a message
 * older than what is stored (by `stateStartedAt`) never replaces it, so the replay A sends
 * after every reconnect cannot move a pane backwards. A repeat of the stored status keeps its
 * first arrival time, and an expired status is never taken back from a replay.
 */
export class BridgeStatusFeed {
  private readonly byPane = new Map<string, PushedStatus>();
  /** paneKey -> stateStartedAt of a status the poll showed was dropped by Orca. */
  private readonly expired = new Map<string, number>();
  private seenA = false;
  private readonly listeners = new Set<() => void>();
  private readonly bridge: BridgeServer;
  private readonly now: () => number;

  constructor(bridge: BridgeServer, now: () => number = Date.now) {
    this.bridge = bridge;
    this.now = now;
    bridge.on('hello', () => {
      this.seenA = true;
      this.notify();
    });
    bridge.on('disconnect', () => this.notify());
    bridge.on('message', (m) => {
      if (m.type !== 'agentStatus') return;
      if (!RAW_STATES.has(m.state as AgentRawState)) return;
      const dead = this.expired.get(m.paneKey);
      if (dead !== undefined && m.stateStartedAt <= dead) return;
      const prev = this.byPane.get(m.paneKey);
      if (prev && prev.stateStartedAt > m.stateStartedAt) return;
      if (prev && prev.stateStartedAt === m.stateStartedAt && prev.state === m.state) return;
      this.byPane.set(m.paneKey, {
        paneKey: m.paneKey,
        state: m.state as AgentRawState,
        outcome: m.outcome ?? null,
        stateStartedAt: m.stateStartedAt,
        agentType: m.agentType ?? null,
        arrivedAt: this.now(),
      });
      this.notify();
    });
  }

  /** True once A has said hello since B started. An idle A still counts: its last state stays valid. */
  get hasBridge(): boolean {
    return this.seenA;
  }
  get connected(): boolean {
    return this.bridge.connection !== null;
  }
  status(paneKey: string): PushedStatus | undefined {
    return this.byPane.get(paneKey);
  }
  all(): PushedStatus[] {
    return [...this.byPane.values()];
  }
  /** Forgets a pane's status for good: Orca sends no event when an agent row goes away. */
  expire(paneKey: string): void {
    const s = this.byPane.get(paneKey);
    if (!s) return;
    this.byPane.delete(paneKey);
    this.expired.set(paneKey, s.stateStartedAt);
  }
  /** Fires on every change; use it to refresh keys without waiting for the next poll. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

/**
 * Steady state = bridge status (push) over the base adapter (panes, handles, focus). The base
 * keeps polling for the pane list. Its own status rows are only used where the bridge has
 * nothing newer, which is also the degraded fallback when A is missing.
 */
export class BridgedAdapter implements OrcaAdapter {
  private readonly base: OrcaAdapter;
  private readonly feed: BridgeStatusFeed;
  private readonly now: () => number;
  /** When the previous poll started; null before the first one. */
  private lastPollAt: number | null = null;

  constructor(base: OrcaAdapter, feed: BridgeStatusFeed, now: () => number = Date.now) {
    this.base = base;
    this.feed = feed;
    this.now = now;
  }

  async health(): Promise<AdapterHealth> {
    const h = await this.base.health();
    return { ...h, live: h.orcaRunning && this.feed.hasBridge ? true : (h.live ?? false) };
  }

  async snapshot(): Promise<Snapshot> {
    const pollAt = this.now();
    const snap = await this.base.snapshot();
    const prevPoll = this.lastPollAt;
    this.lastPollAt = pollAt;
    if (!this.feed.hasBridge) return snap;
    const alive = new Set(snap.panes.map((p) => p.paneKey));
    const merged = new Map(snap.statuses.map((s) => [s.paneKey, s]));
    for (const { arrivedAt, ...pushed } of this.feed.all()) {
      if (!alive.has(pushed.paneKey)) continue; // pane is gone, drop its status
      const polled = merged.get(pushed.paneKey);
      if (!polled && prevPoll !== null && arrivedAt < prevPoll) {
        // Two polls since the push and Orca has no agent row for the pane: the agent is gone.
        this.feed.expire(pushed.paneKey);
        continue;
      }
      if (!polled || pushed.stateStartedAt >= polled.stateStartedAt) {
        // Keep what only the poll knows (tool name, agent type) when the state is unchanged.
        merged.set(pushed.paneKey, {
          ...(polled && polled.state === pushed.state ? polled : {}),
          ...pushed,
          agentType: pushed.agentType ?? polled?.agentType ?? null,
        });
      }
    }
    // A push-only pane (tmux hides the agent from Orca's pane identity) still gets its harness badge.
    const panes = snap.panes.map((p) =>
      p.agentType ? p : { ...p, agentType: merged.get(p.paneKey)?.agentType ?? null },
    );
    return { ...snap, panes, statuses: [...merged.values()] };
  }

  listHosts(): Promise<HostInfo[]> {
    return this.base.listHosts();
  }
  focus(pane: Parameters<OrcaAdapter['focus']>[0]): Promise<FocusResult> {
    return this.base.focus(pane);
  }
  get focusNote(): string {
    return this.base.focusNote ?? '';
  }
  get focusGuessed(): boolean {
    return this.base.focusGuessed ?? false;
  }

  get focusHostId(): string | null {
    return this.base.focusHostId ?? null;
  }
  focusedPaneKey(maxAgeMs?: number): Promise<string | null> {
    return this.base.focusedPaneKey?.(maxAgeMs) ?? Promise.resolve(null);
  }
}

export type { PaneRef };
