import type { OrcaAdapter, PaneInfo, PaneStatusEvent, Snapshot } from './adapter.ts';
import { isLocalHost, LOCAL_HOST, readableHostId } from './host-id.ts';
import { splitPaneKey } from './pane-key.ts';
import { MappingStore, type PaneBinding, type SlotPosition } from './mapping.ts';
import { PaneRegistry } from './registry.ts';
import { ShellActivity } from './shell-activity.ts';
import { AckTracker, type AckSource } from './ack.ts';
import { Pairing, type PairingResult, type PairingState } from './pairing.ts';
import { rank } from './priority.ts';
import { deriveDeckState, lineTwo, type DeckState } from './status.ts';

export interface SlotView {
  state: DeckState;
  stale: boolean;
  /** Key line 1: project/branch or pane title. */
  label: string;
  /** Key line 2: state text. */
  line2: string;
  agent?: string | null;
  /** Short host name for remote panes. */
  host?: string | null;
  /** Pairing mode: this free key shows its number large ("Assign here"). */
  assign?: boolean;
  /** Orca has this pane selected (local panes only: Orca does not publish remote focus). */
  focused?: boolean;
}

const short = (id: string) => id.slice(0, 6);

/** How old the snapshot's pane reads may be for the per-refresh focus check. */
const FOCUS_FROM_SNAPSHOT_MS = 300;

export type HealthMode = 'live' | 'degraded' | 'down';

/** What the Status and Attention keys show. */
export interface Overview {
  mode: HealthMode;
  version: string | null;
  unsupported: boolean;
  /** Hosts whose panes are currently missing. */
  hostsDown: number;
  /** The same hosts by name (alias, Orca's name, else the id), for the Setup list. */
  hostsDownNames: string[];
  /** Number of panes that need the user (needs_input, awaiting_reply, error). */
  urgent: number;
  /** State of the most urgent pane; null when nothing is urgent. */
  topState: DeckState | null;
  /** Urgent panes that are on no key (overflow): the Attention key shows them as "+N". */
  offDeck: number;
  /** Reads are served by the runtime socket (no CLI spawns). */
  fast: boolean;
}

/** One row of the Property Inspector picker. */
export interface PickerPane {
  paneKey: string;
  host: string;
  remote: boolean;
  repo: string;
  branch: string;
  tab: string;
  title: string;
  agent: string | null;
  state: DeckState;
}

/** What the Property Inspector shows for one slot. */
export interface SlotConfig {
  mode: 'pinned' | 'auto';
  paneKey: string | null;
  /** Whether free slots fill with agent panes; off, a key shows only the pane pinned to it. */
  autofill: boolean;
}

export interface DeckOptions {
  /** Fill slots without a pane with free agent panes (default true). */
  autofill?: boolean;
}

export type PressResult = 'focused' | 'failed' | 'unmapped';

export type HoldResult = 'mapped' | 'replaced' | 'released' | 'failed';

function bindingOf(p: PaneInfo): PaneBinding {
  const { tabId, leafId } = splitPaneKey(p.paneKey);
  const lastKnown: PaneBinding['lastKnown'] = {};
  if (p.repo) lastKnown.repo = p.repo;
  if (p.branch) lastKnown.branch = p.branch;
  if (p.worktreePath) lastKnown.worktreePath = p.worktreePath;
  if (p.title) lastKnown.paneTitle = p.title;
  if (p.agentType) lastKnown.agent = p.agentType;
  if (p.hostName) lastKnown.host = p.hostName;
  return {
    paneKey: p.paneKey,
    worktreeId: p.worktreeId,
    tabId,
    leafId,
    executionHostId: p.hostId,
    lastKnown,
  };
}

/** Remote panes show their host name; "Remote" when Orca did not tell us one. */
function hostLabel(hostId: string | undefined, name?: string | null): string | null {
  return !hostId || isLocalHost(hostId) ? null : name || 'Remote';
}

function labelOf(b: PaneBinding): string {
  const k = b.lastKnown;
  return k.paneTitle || k.branch || k.repo || b.paneKey;
}

/** Brings the Orca window to the front; must not throw. */
export type Raise = () => Promise<unknown>;

/** Orca titles a pane running a tmux client `tmux`. */
const TMUX_TITLE = /^tmux\b/;

/**
 * Glue between the adapter and the slots: one `refresh` per poll yields the view of every
 * slot, `press` focuses the pane behind a slot. Slots without a pane are auto-filled with
 * free agent panes (stable order), so the deck works without any configuration, unless
 * `autofill` is off.
 */
export class DeckController {
  private readonly registry = new PaneRegistry();
  private readonly acks = new AckTracker();
  private readonly shell = new ShellActivity();
  /** Pane focused in Orca at the last refresh (null when unknown, undefined before the first read). */
  private focusedKey: string | null | undefined = undefined;
  /**
   * Pane the deck focused last. Orca reports no focus while it shows a paired server, so this
   * keeps that key highlighted until Orca reports the user in another pane.
   */
  private pressedKey: string | null = null;
  private snapshot: Snapshot = { panes: [], statuses: [], omittedHostIds: [] };
  private orcaRunning = false;
  private health: { version: string | null; live: boolean; unsupported: boolean; fast: boolean } = {
    version: null,
    live: false,
    unsupported: false,
    fast: false,
  };
  private attentionCursor = 0;
  private refreshedAt = 0;
  /** When the adapter was last read (see `OrcaAdapter.minReadIntervalMs`). */
  private polledAt = 0;
  private lastKnown = new Map<string, DeckState>();
  /** Last seen panes per remote host, so the picker keeps listing a host that drops out for a poll. */
  private remotePanes = new Map<string, PaneInfo[]>();
  /**
   * Panes the user took off a key (hold release, picker clear) -> their host and that key.
   * Auto-fill skips them until they are pinned again, their key goes back to auto, or they are
   * gone; else another auto key grabs them at once.
   */
  private released = new Map<string, { host: string; slot: string }>();
  /** Refreshes run one at a time; `pending` counts the queued and running ones. */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  private readonly adapter: OrcaAdapter;
  private readonly store: MappingStore;
  private readonly raise: Raise | undefined;
  private readonly autofillOn: boolean;

  /** Pairing mode (Map pane to key). The plugin sets the callbacks to render state and answer A. */
  readonly pairing: Pairing;
  onPairingState?: (state: PairingState) => void;
  onPairingResult?: (result: PairingResult) => void;

  constructor(adapter: OrcaAdapter, store: MappingStore, raise?: Raise, options: DeckOptions = {}) {
    this.adapter = adapter;
    this.store = store;
    this.raise = raise;
    this.autofillOn = options.autofill ?? true;
    this.pairing = new Pairing(store, {
      onState: (s) => this.onPairingState?.(s),
      onResult: (r) => {
        // A pane pinned by pairing may have been released before; it is wanted on a key again.
        if (r.ok) {
          const key = this.store.get(r.slot)?.pane?.paneKey;
          if (key) this.released.delete(key);
          this.diag?.(`pairing: slot ${short(r.slot)} ${r.action}`);
        } else this.diag?.(`pairing: ${r.reason}`);
        this.onPairingResult?.(r);
      },
    });
  }

  /**
   * The pane a pairing request is about: the one A named, else the one focused in Orca. Null when
   * neither can be resolved (the request then ends with noFocusedPane).
   */
  async pairingTarget(paneKey: string | null): Promise<PaneBinding | null> {
    if (paneKey) {
      const named = this.registry.get(paneKey);
      if (named && !named.orphaned) return bindingOf(named);
    }
    const focused = paneKey ? null : await this.focusedPane();
    return focused ? bindingOf(focused) : null;
  }

  /** Unmaps every slot showing a pane (named, or the focused one); returns how many were cleared. */
  async unmapPane(paneKey: string | null): Promise<number> {
    const key = paneKey ?? (await this.focusedPane())?.paneKey;
    if (!key) return 0;
    const slots = this.store.slotsFor(key);
    for (const s of slots) this.release(s);
    return slots.length;
  }

  /** User-chosen short names per host id (Orca's `ssh:build-1` etc.); they win over Orca's own name. */
  hostAliases: Record<string, string> = {};

  private hostName(hostId: string | undefined, name?: string | null): string | null {
    return hostLabel(hostId, (hostId && this.hostAliases[hostId]?.trim()) || name);
  }

  private downHostName(hostId: string): string {
    const seen = this.remotePanes.get(hostId)?.find((p) => p.hostName)?.hostName;
    return this.hostAliases[hostId]?.trim() || seen || readableHostId(hostId);
  }

  /** Optional trace of mapping changes and slow refreshes, for the plugin log. Ids only, never content. */
  diag?: (message: string) => void;

  /**
   * Pane keys and the Status/Attention keys refresh on their own timers. Overlapping refreshes
   * each paid the full Orca round trip and raced on the snapshot, so they are queued, and an info
   * refresh (no slots) rides on one that is running or just ran.
   */
  async refresh(slots: string[]): Promise<Map<string, SlotView>> {
    if (slots.length === 0) {
      if (this.pending > 0) {
        await this.queue;
        return new Map();
      }
      if (Date.now() - this.refreshedAt < 1500) return new Map();
    }
    this.pending++;
    const run = this.queue.then(() => this.refreshNow(slots));
    this.queue = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.pending--;
    }
  }

  private async refreshNow(slots: string[]): Promise<Map<string, SlotView>> {
    this.refreshedAt = Date.now();
    const started = this.refreshedAt;
    const phase = { health: 0, snapshot: 0, focus: 0 };
    const reuse =
      this.orcaRunning &&
      !this.health.fast &&
      Date.now() - this.polledAt < (this.adapter.minReadIntervalMs ?? 0);
    if (!reuse) {
      try {
        this.polledAt = Date.now();
        const h = await this.adapter.health();
        phase.health = Date.now() - started;
        this.orcaRunning = h.orcaRunning;
        this.health = {
          version: h.version,
          live: h.live ?? false,
          unsupported: h.unsupported ?? false,
          fast: h.fast ?? false,
        };
        if (this.orcaRunning) this.snapshot = await this.adapter.snapshot();
        phase.snapshot = Date.now() - started - phase.health;
      } catch {
        this.orcaRunning = false;
      }
    }
    if (this.orcaRunning) this.applyShellActivity();
    const snap = this.snapshot;
    this.registry.update(snap.panes);
    const byHost = new Map<string, PaneInfo[]>();
    for (const p of snap.panes)
      if (!isLocalHost(p.hostId)) byHost.set(p.hostId, [...(byHost.get(p.hostId) ?? []), p]);
    for (const [h, list] of byHost) this.remotePanes.set(h, list);
    for (const h of [...this.remotePanes.keys()])
      if (!byHost.has(h) && !snap.omittedHostIds.includes(h)) this.remotePanes.delete(h);
    // A pane that is only temporarily missing (host down) must keep its mapping.
    const keep = new Set(snap.panes.map((p) => p.paneKey));
    for (const s of slots) {
      const b = this.store.get(s)?.pane;
      if (b && snap.omittedHostIds.includes(b.executionHostId ?? LOCAL_HOST)) keep.add(b.paneKey);
    }
    if (this.orcaRunning) {
      for (const [k, r] of this.released)
        if (!keep.has(k) && !snap.omittedHostIds.includes(r.host)) this.released.delete(k);
      const before = new Map(slots.map((x) => [x, this.store.get(x)?.pane?.paneKey]));
      const cleared = this.store.reconcile(keep);
      for (const c of cleared) this.diag?.(`slot ${short(c)} freed: pane ${before.get(c)} gone`);
      this.autofill(slots);
      for (const x of slots) {
        const now = this.store.get(x)?.pane?.paneKey;
        if (now && now !== before.get(x))
          this.diag?.(`slot ${short(x)} auto-filled with ${now} (was ${before.get(x) ?? 'empty'})`);
      }
    }
    if (this.orcaRunning) this.refreshBindings(slots);
    if (this.orcaRunning) {
      const t0 = Date.now();
      await this.trackAcks();
      phase.focus = Date.now() - t0;
    }

    const out = new Map<string, SlotView>();
    for (const s of slots) out.set(s, this.view(s));
    const took = Date.now() - started;
    if (took > 1000) {
      this.diag?.(
        `slow refresh ${took}ms: health ${phase.health}, snapshot ${phase.snapshot}, focus ${phase.focus} (${this.health.fast ? 'socket' : 'CLI'}, ${snap.panes.length} panes)`,
      );
    }
    return out;
  }

  async press(slot: string): Promise<PressResult> {
    const b = this.store.get(slot)?.pane;
    if (!b) return 'unmapped';
    const pane = this.registry.get(b.paneKey);
    if (!pane) {
      // The pane is missing for now (a paired server reconnecting after wake): at least bring
      // Orca forward, the key still shows the alert.
      await this.raise?.();
      return 'failed';
    }
    const r = await this.focus(pane);
    if (r === 'focused') this.ack(b.paneKey, 'press');
    return r;
  }

  /**
   * Panes without an agent get a working / done status from their output activity, so a long
   * build or a tail shows on its key like an agent would. Agent panes are left alone.
   */
  private applyShellActivity(): void {
    const now = Date.now();
    const real = this.snapshot.statuses.filter((e) => !e.synthetic);
    const extra: PaneStatusEvent[] = [];
    const hasStatus = new Set(real.map((e) => e.paneKey));
    for (const p of this.snapshot.panes) {
      if (p.agentType || p.orphaned || hasStatus.has(p.paneKey)) continue;
      if (this.snapshot.omittedHostIds.includes(p.hostId)) continue;
      const st = this.shell.observe(p.paneKey, p.lastOutputAt, now);
      if (!st) continue;
      extra.push({
        paneKey: p.paneKey,
        state: st === 'working' ? 'working' : 'done',
        outcome: st === 'done' ? 'unconfirmed' : null,
        toolName: null,
        agentType: null,
        stateStartedAt: st === 'working' ? now - this.shell.busyFor(p.paneKey, now) : now,
        synthetic: true,
      });
    }
    this.shell.prune(new Set(this.snapshot.panes.map((p) => p.paneKey)));
    this.snapshot = { ...this.snapshot, statuses: [...real, ...extra] };
  }

  /**
   * Feeds every agent pane's state into the ack tracker and applies the focus-in-Orca ack
   * (the way highlights clear with notifications off). The focus read is only
   * done when reads are cheap (runtime socket), never as two CLI spawns per poll.
   */
  private async trackAcks(): Promise<void> {
    const now = Date.now();
    for (const pane of this.snapshot.panes) {
      const synthetic = this.snapshot.statuses.some(
        (e) => e.synthetic && e.paneKey === pane.paneKey,
      );
      if ((!pane.agentType && !synthetic) || pane.orphaned) continue;
      const state = this.paneState(pane);
      if (state) this.acks.update(pane.paneKey, state, now);
    }
    if (!this.health.fast || !this.adapter.focusedPaneKey) {
      this.focusedKey = undefined;
      return;
    }
    const prev = this.focusedKey;
    // The snapshot just read the same worktree and terminal lists: no second round trip.
    this.focusedKey = await this.adapter.focusedPaneKey(FOCUS_FROM_SNAPSHOT_MS).catch(() => null);
    // The user moved to another pane Orca can report: the deck's last focus is over.
    if (this.focusedKey && this.focusedKey !== prev && this.focusedKey !== this.pressedKey) {
      this.pressedKey = null;
    }
    // Only focus arriving acknowledges. Orca keeps reporting its last active pane while the
    // window is in the background, and a pane you are already in when the agent asks has not
    // been looked at since: both must stay highlighted.
    if (this.focusedKey && prev !== undefined && this.focusedKey !== prev) {
      this.ack(this.focusedKey, 'focus');
    }
  }

  /** Derived deck state of a live pane, ignoring acknowledgement. Null when its host is down. */
  private paneState(pane: PaneInfo): DeckState | null {
    if (this.snapshot.omittedHostIds.includes(pane.hostId)) return null;
    const status = this.snapshot.statuses.find((e) => e.paneKey === pane.paneKey);
    return deriveDeckState({
      mapped: true,
      orcaRunning: this.orcaRunning,
      found: true,
      connected: pane.connected,
      hostDown: false,
      agentType: pane.agentType,
      agent: status
        ? {
            state: status.state,
            outcome: status.outcome ?? null,
            awaiting: status.awaiting ?? null,
          }
        : null,
      exitCause: pane.exitCause ?? null,
    }).state;
  }

  /** Acknowledges a pane and, once nothing in its worktree is unread any more, clears Orca's dot. */
  private ack(paneKey: string, source: AckSource): void {
    const pane = this.snapshot.panes.find((p) => p.paneKey === paneKey);
    if (!pane) return;
    this.acks.ack(paneKey, source);
    const stillUnread = this.snapshot.panes.some(
      (p) =>
        p.worktreeId === pane.worktreeId &&
        p.paneKey !== paneKey &&
        this.acks.view(p.paneKey, Date.now())?.unread,
    );
    if (!stillUnread && isLocalHost(pane.hostId)) {
      void this.adapter.markWorktreeRead?.(pane.worktreeId)?.catch(() => {});
    }
  }

  /** Panes that can be mapped, grouped by the caller as host > repo > branch > tab > pane. */
  listPanes(): PickerPane[] {
    const down = new Set(this.snapshot.omittedHostIds);
    const live = new Set(this.snapshot.panes.map((p) => p.paneKey));
    const missing = [...this.remotePanes.values()].flat().filter((p) => !live.has(p.paneKey));
    return [...this.snapshot.panes, ...missing]
      .filter((p) => !p.orphaned)
      .map((p) => {
        const status = this.snapshot.statuses.find((e) => e.paneKey === p.paneKey);
        const { state } = deriveDeckState({
          mapped: true,
          orcaRunning: this.orcaRunning,
          found: true,
          connected: p.connected,
          hostDown: down.has(p.hostId),
          agentType: p.agentType,
          agent: status
            ? {
                state: status.state,
                outcome: status.outcome ?? null,
                awaiting: status.awaiting ?? null,
              }
            : null,
          exitCause: p.exitCause ?? null,
        });
        return {
          paneKey: p.paneKey,
          host: this.hostName(p.hostId, p.hostName) ?? 'This machine',
          remote: !isLocalHost(p.hostId),
          repo: p.repo ?? '',
          branch: p.branch ?? '',
          tab: p.tabTitle ?? '',
          title: p.title,
          agent: p.agentType,
          state,
        };
      });
  }

  slotConfig(slot: string): SlotConfig {
    const s = this.store.get(slot);
    return {
      mode: s?.mode ?? 'auto',
      paneKey: s?.pane?.paneKey ?? null,
      autofill: this.autofillOn,
    };
  }

  /** Empties a slot and keeps it empty: auto-fill never touches a pinned slot without a pane. */
  clear(slot: string): void {
    this.diag?.(`slot ${short(slot)} emptied by the picker`);
    this.release(slot);
  }

  /** Empties a slot for good and keeps its pane off auto-fill. */
  private release(slot: string): void {
    const b = this.store.get(slot)?.pane;
    if (b) this.released.set(b.paneKey, { host: b.executionHostId ?? LOCAL_HOST, slot });
    this.store.set(slot, { mode: 'pinned' });
  }

  /** Execution host of the pane on a slot ('local', 'ssh:..', 'env:..'), for the press log. */
  slotHost(slot: string): string | null {
    const b = this.store.get(slot)?.pane;
    return b ? (b.executionHostId ?? LOCAL_HOST) : null;
  }

  /** Pins a pane to a slot (null = back to auto-fill); a pane lives on one slot at a time. */
  configure(slot: string, c: { paneKey: string | null }): void {
    if (c.paneKey === null) {
      this.diag?.(`slot ${short(slot)} unmapped by the picker`);
      // Unmap: an empty auto slot would be refilled at once, which is the wanted "reset".
      for (const [k, r] of this.released) if (r.slot === slot) this.released.delete(k);
      this.store.remove(slot);
      return;
    }
    const pane = this.registry.get(c.paneKey);
    if (!pane) return;
    for (const other of this.store.slotsFor(c.paneKey)) {
      if (other === slot) continue;
      this.diag?.(`slot ${short(other)} loses ${c.paneKey}: pinned to slot ${short(slot)}`);
      this.store.remove(other);
    }
    this.released.delete(c.paneKey);
    this.diag?.(`slot ${short(slot)} pinned to ${c.paneKey}`);
    this.store.set(slot, { mode: 'pinned', pane: bindingOf(pane) });
  }

  /** The pane focused in Orca right now (local runtime), or null when unknown. */
  private async focusedPane(): Promise<PaneInfo | null> {
    const key = await this.adapter.focusedPaneKey?.().catch(() => null);
    this.focusUnreadable = !key;
    if (!key) {
      const note = this.adapter.focusNote || 'no detail';
      this.holdError = `cannot read the focused pane (${note}): use the picker`;
      // Orca marks no local worktree active while it shows a paired server.
      this.holdHint = note.includes('no-active-worktree')
        ? 'Remote pane: use the picker'
        : 'No pane selected in Orca';
      return null;
    }
    this.holdHint = 'Pane not found';
    const find = () => this.snapshot.panes.find((p) => p.paneKey === key);
    let pane = find();
    if (!pane) {
      // The pane may be newer than the last poll.
      this.snapshot = await this.adapter.snapshot().catch(() => this.snapshot);
      this.registry.update(this.snapshot.panes);
      pane = find();
    }
    if (!pane) this.holdError = `focused pane ${key} is not in the pane list`;
    else if (pane.orphaned) this.holdError = `focused pane ${key} is orphaned`;
    return pane && !pane.orphaned ? pane : null;
  }

  /** Why the last hold failed, for the plugin log. */
  holdError = '';
  /** The same, short enough to show on the key for a moment. */
  holdHint = '';
  /** The last focus read found no pane (a paired server or SSH host is shown, or nothing is). */
  private focusUnreadable = false;

  /**
   * Hold: one gesture, three outcomes. The slot shows the focused pane already
   * -> release it (the slot stays empty, no auto-fill); otherwise pin the focused pane here.
   */
  async hold(slot: string): Promise<HoldResult> {
    const pane = await this.focusedPane();
    if (!pane) {
      // Orca does not publish the focus of a remote pane, so a pane on a remote host can be pinned
      // from the picker but never matched against the focus. Holding a key that shows a pane then
      // releases it, instead of a failure the user cannot act on.
      const cur = this.store.get(slot);
      if (this.focusUnreadable && cur?.pane) {
        this.release(slot);
        return 'released';
      }
      return 'failed';
    }
    if (this.store.get(slot)?.pane?.paneKey === pane.paneKey) {
      this.release(slot);
      return 'released';
    }
    const had = !!this.store.get(slot)?.pane;
    this.configure(slot, { paneKey: pane.paneKey });
    return had ? 'replaced' : 'mapped';
  }

  /** Number of Pane slots holding a pane (for the Setup doctor). */
  /** A key appeared at `pos`: remember it, and inherit the mapping a key at that position had before. */
  locateSlot(slot: string, pos: SlotPosition, live: ReadonlySet<string>): boolean {
    return this.store.locate(slot, pos, live);
  }

  mappedSlotCount(): number {
    return this.store.mappedCount();
  }

  /** Health plus urgent count, from the latest refresh. */
  overview(): Overview {
    const urgent = this.urgentPanes();
    const onKeys = this.store.mappedPaneKeys();
    // Omitted hosts keep their keys' last known state; only hosts no listing reached are down.
    const down = this.snapshot.downHostIds ?? this.snapshot.omittedHostIds;
    return {
      mode: !this.orcaRunning ? 'down' : this.health.live ? 'live' : 'degraded',
      version: this.health.version,
      unsupported: this.health.unsupported,
      hostsDown: down.length,
      hostsDownNames: down.map((id) => this.downHostName(id)),
      urgent: urgent.length,
      topState: urgent[0]?.state ?? null,
      offDeck: urgent.filter((u) => !onKeys.has(u.pane.paneKey)).length,
      fast: this.health.fast,
    };
  }

  /** Focuses the most urgent pane; repeated presses walk down the list and wrap around. */
  async pressAttention(): Promise<PressResult> {
    const urgent = this.urgentPanes();
    if (urgent.length === 0) return 'unmapped';
    this.attentionCursor %= urgent.length;
    const pane = urgent[this.attentionCursor]?.pane;
    this.attentionCursor++;
    const r = await this.focus(pane);
    if (r === 'focused' && pane) this.ack(pane.paneKey, 'press');
    return r;
  }

  private urgentPanes(): { pane: PaneInfo; state: DeckState }[] {
    if (!this.orcaRunning) return [];
    const down = new Set(this.snapshot.omittedHostIds);
    return (
      this.snapshot.panes
        .filter((p) => p.agentType && !p.orphaned)
        .map((pane) => {
          const status = this.snapshot.statuses.find((e) => e.paneKey === pane.paneKey);
          const { state } = deriveDeckState({
            mapped: true,
            orcaRunning: true,
            found: true,
            connected: pane.connected,
            hostDown: down.has(pane.hostId),
            agentType: pane.agentType,
            agent: status
              ? {
                  state: status.state,
                  outcome: status.outcome ?? null,
                  awaiting: status.awaiting ?? null,
                }
              : null,
            exitCause: pane.exitCause ?? null,
          });
          return { pane, state, lastActivityAt: status?.stateStartedAt ?? 0 };
        })
        // Permission prompts and questions wait for an answer; an error drops out once acknowledged.
        .filter(
          (e) =>
            e.state === 'needs_input' ||
            e.state === 'awaiting_reply' ||
            (e.state === 'error' && this.acks.view(e.pane.paneKey, Date.now())?.unread !== false),
        )
        // Most urgent state first; within a state the pane that has waited longest.
        .sort((a, b) => rank(a) - rank(b) || a.lastActivityAt - b.lastActivityAt)
    );
  }

  private async focus(pane: PaneInfo | undefined): Promise<PressResult> {
    if (!pane) return 'failed';
    // Highlight the key while the switch runs, so a refresh meanwhile does not drop it.
    const before = this.pressedKey;
    this.pressedKey = pane.paneKey;
    // Switch the pane and raise the window concurrently: both are slow subprocess calls.
    const focusPane = (p: PaneInfo) =>
      this.adapter.focus({
        paneKey: p.paneKey,
        hostId: p.hostId,
        handle: p.handle,
        environment: p.environment ?? null,
        worktreeId: p.worktreeId,
      });
    const [first] = await Promise.all([focusPane(pane), this.raise?.()]);
    let r = first;
    if (!r.ok && /stale|not.?found/i.test(r.error ?? '')) {
      // Orca restarted since the last read and its terminal handles rotated: read the panes again and
      // retry once, only when the pane now has another handle (so this cannot loop).
      try {
        this.snapshot = await this.adapter.snapshot();
        this.registry.update(this.snapshot.panes);
        const fresh = this.registry.get(pane.paneKey);
        if (fresh && fresh.handle !== pane.handle) r = await focusPane(fresh);
      } catch {
        // Orca is not reachable: the press fails as before.
      }
    }
    if (!r.ok && this.pressedKey === pane.paneKey) this.pressedKey = before;
    return r.ok ? 'focused' : 'failed';
  }

  /** Keeps the remembered label data of mapped panes current (titles change while mapped). */
  private refreshBindings(slots: string[]): void {
    for (const s of slots) {
      const cur = this.store.get(s);
      const pane = cur?.pane && this.registry.get(cur.pane.paneKey);
      if (!cur?.pane || !pane) continue;
      const fresh = bindingOf(pane);
      if (JSON.stringify(fresh.lastKnown) !== JSON.stringify(cur.pane.lastKnown)) {
        this.store.set(s, { ...cur, pane: { ...cur.pane, lastKnown: fresh.lastKnown } });
      }
    }
  }

  private autofill(slots: string[]): void {
    if (!this.autofillOn) {
      // Off: a pane an earlier version auto-filled must not linger on its key.
      for (const s of slots) {
        const cur = this.store.get(s);
        if (cur?.pane && cur.mode !== 'pinned') {
          this.diag?.(`slot ${short(s)} emptied: auto-fill is off (was ${cur.pane.paneKey})`);
          this.store.remove(s);
        }
      }
      return;
    }
    const taken = this.store.mappedPaneKeys();
    const free = this.snapshot.panes
      .filter(
        (p) => p.agentType && !p.orphaned && !taken.has(p.paneKey) && !this.released.has(p.paneKey),
      )
      .sort((a, b) => a.paneKey.localeCompare(b.paneKey));
    for (const s of slots) {
      const cur = this.store.get(s);
      if (cur?.pane || cur?.mode === 'pinned') continue;
      const p = free.shift();
      if (!p) break;
      this.store.set(s, { ...cur, mode: 'auto', pane: bindingOf(p) });
    }
  }

  private view(slot: string): SlotView {
    const b = this.store.get(slot)?.pane;
    // Orca down: every slot looks empty (the Status key says why); mappings stay for the recovery.
    if (!b || !this.orcaRunning)
      return { state: 'unmapped', stale: false, label: '', line2: lineTwo('unmapped') };
    const pane = this.registry.get(b.paneKey);
    const status = this.snapshot.statuses.find((e) => e.paneKey === b.paneKey);
    const hostDown = this.snapshot.omittedHostIds.includes(b.executionHostId ?? LOCAL_HOST);
    // Trust the live agentType while the pane exists (agent exited -> plain shell); lastKnown only when offline.
    const liveAgent = pane ? (pane.agentType ?? null) : (b.lastKnown.agent ?? null);
    // tmux hides its agents from Orca (stablyai/orca#7797): without hook state the pane is "tmux", not a stale harness.
    const kind = liveAgent ?? (pane && TMUX_TITLE.test(pane.title) ? 'tmux' : null);
    const d = deriveDeckState(
      {
        mapped: true,
        orcaRunning: this.orcaRunning,
        found: !!pane,
        connected: pane?.connected ?? false,
        hostDown,
        agentType: liveAgent,
        agent: status
          ? {
              state: status.state,
              outcome: status.outcome ?? null,
              awaiting: status.awaiting ?? null,
            }
          : null,
        exitCause: pane?.exitCause ?? null,
      },
      this.lastKnown.get(slot),
    );
    if (!d.stale) this.lastKnown.set(slot, d.state);
    // An acknowledged completion reads as idle ("done 12m"), but only while
    // the pane is still in that state: offline (Orca quit, pane gone) must show as offline.
    const av = d.stale ? undefined : this.acks.view(b.paneKey, Date.now());
    const acked =
      av && av.state !== av.from && av.state === 'idle' && av.from === d.state ? av : undefined;
    const shown = acked ? 'idle' : d.state;
    return {
      state: shown,
      stale: d.stale,
      label: labelOf(b),
      agent: kind,
      host: this.hostName(b.executionHostId, b.lastKnown.host),
      focused:
        !!pane &&
        (this.focusedKey === pane.paneKey ||
          (!this.focusedKey && this.pressedKey === pane.paneKey)),
      line2: acked
        ? `done ${acked.doneMinutes ?? 0}m`
        : lineTwo(d.state, {
            elapsedMs: status ? Date.now() - status.stateStartedAt : 0,
            agentName: kind,
          }),
    };
  }
}
