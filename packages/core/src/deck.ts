import type { OrcaAdapter, PaneInfo, PaneStatusEvent, Snapshot } from './adapter.ts';
import { isLocalHost, LOCAL_HOST, parseHostId, readableHostId } from './host-id.ts';
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
  /** Orca has this pane selected (local panes only: Orca does not publish remote focus). */
  focused?: boolean;
}

const short = (id: string) => id.slice(0, 6);

/**
 * What a failed read says when Orca did answer but not in a shape the adapter knows (a zod issue list or
 * bad JSON): the schema paths and codes, never a value. Null for any other failure (Orca did not answer).
 */
function unreadableResponse(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const issues = (e as { issues?: { path?: unknown[]; code?: string }[] }).issues;
  if (e.name === 'ZodError' && Array.isArray(issues)) {
    return issues.map((i) => `${(i.path ?? []).join('.') || '<root>'} ${i.code}`).join('; ');
  }
  return e instanceof SyntaxError ? 'not JSON' : null;
}

/** How old the snapshot's pane reads may be for the per-refresh focus check. */
const FOCUS_FROM_SNAPSHOT_MS = 300;

export type HealthMode = 'live' | 'degraded' | 'down';

/** What the Status and Attention keys show. */
export interface Overview {
  mode: HealthMode;
  version: string | null;
  unsupported: boolean;
  /** Orca answered the health check, but its latest listing did not parse: the panes are the last good read. */
  badResponse: boolean;
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
  /** Execution host id (tab and leaf ids repeat across hosts). */
  hostId: string;
  host: string;
  /** The address behind a connection label, for searching; absent when `host` is already the address. */
  hostAddress?: string;
  remote: boolean;
  repo: string;
  branch: string;
  tab: string;
  /** The pane's name, the same everywhere: see `paneName`. */
  title: string;
  agent: string | null;
  state: DeckState;
  /** The key of this deck the pane is on, when the caller can tell. */
  onKey?: number;
}

/** One pane in the Orca panel's picker (the `deckState.panes` entry). */
export interface PanelPane {
  paneKey: string;
  /** Execution host id: tab and leaf ids repeat across hosts, so a choice names both. */
  hostId: string;
  label: string;
  /** Pane title and tab: what tells two panes of one worktree apart. */
  detail: string;
  /** Host name of a remote pane, else absent. */
  host?: string;
  /** The address behind a connection label (searchable), else absent. */
  hostAddress?: string;
  /** Structured parts for a grouped list (`label` and `detail` stay for an older panel). */
  repo: string;
  branch: string;
  tab: string;
  /** The pane's name (`paneName`): unique inside its tab. */
  name: string;
  agent: string | null;
  state: DeckState;
  remote: boolean;
  focused: boolean;
  /**
   * Orca shows a paired server, which reports no focus, and this is the pane last opened from the deck there:
   * the panel's best guess for a pane to offer first.
   */
  lastPressed?: boolean;
  onKey?: number;
}

/** The panel lists at most this many panes: the frame stays far under the bridge's 256 KiB. */
export const PANEL_PANES_MAX = 200;

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

/** The pane's process crashed or exited non-zero: Orca lists it with no agent, but it needs a look. */
const endedBadly = (p: PaneInfo): boolean => p.exitCause === 'crash' || p.exitCause === 'nonzero';

/** A focus that failed because Orca no longer knows the handle (it restarted, or the pane closed). */
function isStaleHandle(r: { error?: string; code?: string }): boolean {
  const known = ['terminal_handle_stale', 'terminal_not_found'];
  // The runtime socket gives a code; the CLI path only has the text of its error.
  return r.code !== undefined ? known.includes(r.code) : known.some((c) => r.error?.includes(c));
}

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

function labelOf(b: PaneBinding, suffix = ''): string {
  const k = b.lastKnown;
  return (k.paneTitle || k.branch || k.repo || b.paneKey) + suffix;
}

/**
 * A pane's name: its title, else its tab's title. Panes of one tab that end up with the same name get their
 * position in the tab (counted in the order Orca lists the leaves) so no two share one: "Terminal · pane 2".
 * A pane alone in its tab, or with a name of its own, gets no suffix. `panes` is every pane Orca lists.
 */
export function paneName(
  pane: Pick<PaneInfo, 'paneKey' | 'hostId' | 'title' | 'tabTitle'>,
  panes: readonly Pick<PaneInfo, 'paneKey' | 'hostId' | 'title' | 'tabTitle'>[],
): string {
  const base = pane.title || pane.tabTitle || '';
  const suffix = paneSuffix(pane, panes);
  return suffix ? (base ? `${base} · ${suffix}` : suffix) : base;
}

/** "pane N" when another pane of the same tab has the same name, else ''. */
export function paneSuffix(
  pane: Pick<PaneInfo, 'paneKey' | 'hostId' | 'title' | 'tabTitle'>,
  panes: readonly Pick<PaneInfo, 'paneKey' | 'hostId' | 'title' | 'tabTitle'>[],
): string {
  const tab = splitPaneKey(pane.paneKey).tabId;
  const nameOf = (p: Pick<PaneInfo, 'title' | 'tabTitle'>) => p.title || p.tabTitle || '';
  const siblings = panes.filter(
    (p) => p.hostId === pane.hostId && splitPaneKey(p.paneKey).tabId === tab,
  );
  if (siblings.filter((p) => nameOf(p) === nameOf(pane)).length < 2) return '';
  return `pane ${siblings.findIndex((p) => p.paneKey === pane.paneKey) + 1}`;
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
  /** The last pane the focus read named: what "Map pane" uses when Orca reports none (the settings view is open). */
  private lastFocusedKey: string | null = null;
  /** Execution host of the worktree shown at the last focus read: tab and leaf ids repeat across hosts. */
  private focusedHost: string | null = null;
  private lastFocusedHost: string | null = null;
  /** The focus read behind `focusedKey` / `lastFocusedKey` was a guess (see `OrcaAdapter.focusGuessed`). */
  private focusedGuess = false;
  private lastFocusGuess = false;
  /**
   * Pane the deck focused last. Orca reports no focus while it shows a paired server, so this
   * keeps that key highlighted until Orca reports the user in another pane.
   */
  private pressedKey: string | null = null;
  private pressedHost: string | null = null;
  private snapshot: Snapshot = { panes: [], statuses: [], omittedHostIds: [] };
  private orcaRunning = false;
  /** Why the last snapshot could not be read while Orca was up (paths and codes only), else null. */
  private readFailure: string | null = null;
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
  /** Hosts that showed something (worktree, terminal, agent) the last time they answered: only these count as down. */
  private busyHosts = new Set<string>();
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
  async pairingTarget(
    paneKey: string | null,
    hostId: string | null = null,
  ): Promise<PaneBinding | null> {
    if (paneKey) {
      const named = this.registry.get(paneKey, hostId);
      if (named && !named.orphaned) return bindingOf(named);
    }
    const focused = paneKey ? null : await this.focusedPane();
    if (focused) return bindingOf(focused);
    // Run from the plugin settings, Orca reports no focused pane: the last one it did is the one meant.
    const last =
      !paneKey && this.lastFocusedKey
        ? this.registry.get(this.lastFocusedKey, this.lastFocusedHost)
        : undefined;
    return last && !last.orphaned ? bindingOf(last) : null;
  }

  /**
   * The Orca panel's click on a key: the focused pane goes to `slot`, like pairing mode followed by
   * a tap on that key (so a pane already on another key moves here: a pane is on one key only). A key that already shows a pane needs
   * `replace`. Reports through `onPairingResult`, like every pairing outcome.
   */
  async assignFocusedTo(
    requestId: string,
    slot: string | null,
    replace: boolean,
    deckConnected: boolean,
    paneKey: string | null = null,
    hostId: string | null = null,
  ): Promise<void> {
    if (!slot) return this.onPairingResult?.({ requestId, ok: false, reason: 'noSuchKey' });
    if (!replace && this.store.get(slot)?.pane)
      return this.onPairingResult?.({ requestId, ok: false, reason: 'occupied' });
    // A pane the panel chose must still be there: never fall back to the focused one.
    const target = await this.pairingTarget(paneKey, hostId);
    if (paneKey && !target)
      return this.onPairingResult?.({ requestId, ok: false, reason: 'noSuchPane' });
    this.pairing.start(requestId, target, deckConnected);
    this.pairing.press(slot, 'tap');
  }

  /** The Orca panel's Unmap on a key: the pane leaves it (and stays off auto-fill). */
  unmapSlot(requestId: string, slot: string | null): void {
    if (!slot) return this.onPairingResult?.({ requestId, ok: false, reason: 'noSuchKey' });
    this.release(slot);
    this.onPairingResult?.({ requestId, ok: true, slot, action: 'unmapped' });
  }

  /** User-chosen short names per host id (Orca's `ssh:build-1` etc.); they win over Orca's own name. */
  hostAliases: Record<string, string> = {};

  private hostName(hostId: string | undefined, name?: string | null): string | null {
    return hostLabel(hostId, (hostId && this.hostAliases[hostId]?.trim()) || name);
  }

  /** Devices whose keys appeared in this run (see `MappingStore.locate`). */
  private readonly seenDevices = new Set<string>();

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
  async refresh(slots: string[], opts: { force?: boolean } = {}): Promise<Map<string, SlotView>> {
    if (opts.force) this.polledAt = 0;
    if (slots.length === 0 && !opts.force) {
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
        this.readFailure = null;
        phase.snapshot = Date.now() - started - phase.health;
      } catch (e) {
        const bad = this.orcaRunning ? unreadableResponse(e) : null;
        // Orca answered but its reply did not parse: it is not down, and the last good snapshot stays.
        if (bad === null) this.orcaRunning = false;
        if (bad !== this.readFailure) {
          if (bad !== null) this.diag?.(`orca answered, but the response did not parse: ${bad}`);
          this.readFailure = bad;
        }
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
    if (this.orcaRunning && snap.busyHostIds) this.trackBusyHosts(snap);
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
    const pane = this.registry.get(b.paneKey, b.executionHostId);
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
      if ((!pane.agentType && !synthetic && !endedBadly(pane)) || pane.orphaned) continue;
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
    this.noteFocus(this.focusedKey);
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

  /** The key of the deck `keyOf` describes that shows the pane, if any. */
  private keyOnDeck(
    p: Pick<PaneInfo, 'paneKey' | 'hostId'>,
    keyOf: (slot: string) => number | null,
  ): number | undefined {
    return this.store
      .slotsFor(p.paneKey, p.hostId)
      .map(keyOf)
      .find((k): k is number => k !== null);
  }

  /** Panes that can be mapped, grouped by the caller as host > repo > branch > tab > pane. */
  listPanes(keyOf?: (slot: string) => number | null): PickerPane[] {
    const down = new Set(this.snapshot.omittedHostIds);
    const live = new Set(this.snapshot.panes.map((p) => p.paneKey));
    const missing = [...this.remotePanes.values()].flat().filter((p) => !live.has(p.paneKey));
    const all = [...this.snapshot.panes, ...missing].filter((p) => !p.orphaned);
    return all.map((p) => {
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
      const onKey = keyOf ? this.keyOnDeck(p, keyOf) : undefined;
      return {
        paneKey: p.paneKey,
        hostId: p.hostId,
        host: this.hostName(p.hostId, p.hostName) ?? 'This machine',
        ...(p.hostAddress ? { hostAddress: p.hostAddress } : {}),
        remote: !isLocalHost(p.hostId),
        repo: p.repo ?? '',
        branch: p.branch ?? '',
        tab: p.tabTitle ?? '',
        title: paneName(p, all),
        agent: p.agentType,
        state,
        ...(onKey !== undefined ? { onKey } : {}),
      };
    });
  }

  /**
   * The panes the Orca panel offers for a key: the focused one first, then the rest as listed.
   * `keyOf` turns a slot into the key number it has on the deck the panel draws.
   */
  panelPanes(keyOf: (slot: string) => number | null): PanelPane[] {
    return this.listPanes()
      .map((p) => {
        const onKey = this.keyOnDeck(p, keyOf);
        const where = [p.repo, p.branch].filter(Boolean).join(' / ');
        return {
          paneKey: p.paneKey,
          hostId: p.hostId,
          label: where || p.title,
          // Name first: a long host name must not push it out of a narrow sidebar. The name already says
          // the tab when the pane has no title of its own.
          detail: [where ? p.title : '', p.title.startsWith(p.tab) ? '' : p.tab]
            .filter((s, i, all) => s && s !== where && all.indexOf(s) === i)
            .join(' · '),
          repo: p.repo,
          branch: p.branch,
          tab: p.tab,
          name: p.title,
          ...(p.remote ? { host: p.host } : {}),
          ...(p.remote && p.hostAddress ? { hostAddress: p.hostAddress } : {}),
          agent: p.agent,
          state: p.state,
          remote: p.remote,
          // A guessed focus still serves the deck's own taps and holds, but the panel must not offer it as the focus.
          focused: this.isFocused(p) && !this.focusIsGuess(),
          ...(this.isLastPressedRemote(p) ? { lastPressed: true } : {}),
          ...(onKey !== undefined ? { onKey } : {}),
        };
      })
      .sort((a, b) => Number(b.focused || !!b.lastPressed) - Number(a.focused || !!a.lastPressed))
      .slice(0, PANEL_PANES_MAX);
  }

  /** Whether `currentFocusKey()` comes from a guess. */
  private focusIsGuess(): boolean {
    return this.focusedKey ? this.focusedGuess : this.lastFocusGuess;
  }

  /** The pane key focused in Orca at the last poll, else the last one that was. */
  currentFocusKey(): string | null {
    return this.focusedKey ?? this.lastFocusedKey;
  }

  /** Whether `pane` is the one focused in Orca (key and host: a remote pane may share ids with a local one). */
  private isFocused(pane: Pick<PaneInfo, 'paneKey' | 'hostId'>): boolean {
    const key = this.currentFocusKey();
    return (
      !!key &&
      this.isFocusedAt(pane, key, this.focusedKey ? this.focusedHost : this.lastFocusedHost)
    );
  }

  private isFocusedAt(
    pane: Pick<PaneInfo, 'paneKey' | 'hostId'>,
    key: string,
    host: string | null,
  ): boolean {
    if (pane.paneKey !== key) return false;
    if (!host || pane.hostId === host) return true;
    // The host Orca names may not be the pane's own id: only trust it when it tells panes apart.
    return !this.snapshot.panes.some((p) => p.paneKey === key && p.hostId === host);
  }

  /**
   * Keeps the last focus for "Map pane" when Orca reports none (the settings view is open). Not when
   * Orca shows a remote host: the last local pane is not the one meant then. Orca marks no worktree
   * active both in its settings and while it shows a paired server, so with paired-server panes
   * around that answer may be a remote pane too.
   */
  private noteFocus(key: string | null): void {
    this.focusedHost = this.adapter.focusHostId ?? null;
    this.focusedGuess = !!key && (this.adapter.focusGuessed ?? false);
    if (key) {
      this.lastFocusedKey = key;
      this.lastFocusGuess = this.focusedGuess;
      this.lastFocusedHost = this.focusedHost;
    } else if (
      (this.focusedHost && !isLocalHost(this.focusedHost)) ||
      (!this.focusedHost && this.mayShowPairedServer())
    ) {
      this.lastFocusedKey = null;
      this.lastFocusedHost = null;
    }
  }

  /** The pane last opened from the deck, while Orca shows a paired server with no focus to read. */
  private isLastPressedRemote(pane: Pick<PaneInfo, 'paneKey' | 'hostId'>): boolean {
    return (
      !this.focusedKey &&
      pane.paneKey === this.pressedKey &&
      pane.hostId === this.pressedHost &&
      parseHostId(pane.hostId).kind === 'env' &&
      this.mayShowPairedServer()
    );
  }

  /** No worktree is shown and Orca has paired-server panes: one of them may be the one on screen. */
  private mayShowPairedServer(): boolean {
    return (
      (this.adapter.focusNote ?? '').includes('no-active-worktree') &&
      this.snapshot.panes.some((p) => parseHostId(p.hostId).kind === 'env')
    );
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
  configure(slot: string, c: { paneKey: string | null; hostId?: string | null }): void {
    if (c.paneKey === null) {
      this.diag?.(`slot ${short(slot)} unmapped by the picker`);
      // Unmap: an empty auto slot would be refilled at once, which is the wanted "reset".
      for (const [k, r] of this.released) if (r.slot === slot) this.released.delete(k);
      this.store.remove(slot);
      return;
    }
    const pane = this.registry.get(c.paneKey, c.hostId);
    if (!pane) return;
    for (const other of this.store.slotsFor(c.paneKey, pane.hostId)) {
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
    if (!key) {
      this.noteFocus(null);
      return null;
    }
    this.noteFocus(key);
    const find = () => this.snapshot.panes.find((p) => this.isFocusedAt(p, key, this.focusedHost));
    let pane = find();
    if (!pane) {
      // The pane may be newer than the last poll.
      this.snapshot = await this.adapter.snapshot().catch(() => this.snapshot);
      this.registry.update(this.snapshot.panes);
      pane = find();
    }
    return pane && !pane.orphaned ? pane : null;
  }

  /** A key appeared at `pos`: remember it, and inherit the mapping a key at that position had before. */
  locateSlot(slot: string, pos: SlotPosition, live: ReadonlySet<string>): boolean {
    const inherited = this.store.locate(slot, pos, live, this.seenDevices);
    this.seenDevices.add(pos.device);
    return inherited;
  }

  mappedSlotCount(): number {
    return this.store.mappedCount();
  }

  /** A host that answered keeps its mark only while it shows something; one that is down keeps the last one. */
  private trackBusyHosts(snap: Snapshot): void {
    const busy = new Set(snap.busyHostIds);
    const quiet = new Set([...snap.omittedHostIds, ...(snap.downHostIds ?? [])]);
    for (const h of busy) this.busyHosts.add(h);
    for (const h of [...this.busyHosts])
      if (!busy.has(h) && !quiet.has(h)) this.busyHosts.delete(h);
  }

  /**
   * Down hosts that matter: ones that showed something when they last answered, or that a key is
   * mapped to (that survives a restart while the host is down). A configured host the user does
   * not use is not "down".
   */
  private downHostsInUse(): string[] {
    const down = this.snapshot.downHostIds ?? this.snapshot.omittedHostIds;
    if (!this.snapshot.busyHostIds) return down;
    const mapped = new Set(this.store.bindings().map((b) => b.executionHostId ?? LOCAL_HOST));
    return down.filter((h) => this.busyHosts.has(h) || mapped.has(h));
  }

  /** Health plus urgent count, from the latest refresh. */
  overview(): Overview {
    const urgent = this.urgentPanes();
    const onKeys = this.store.mappedPaneKeys();
    // Omitted hosts keep their keys' last known state; only hosts no listing reached are down.
    const down = this.downHostsInUse();
    return {
      mode: !this.orcaRunning ? 'down' : this.health.live ? 'live' : 'degraded',
      version: this.health.version,
      unsupported: this.health.unsupported,
      badResponse: this.orcaRunning && this.readFailure !== null,
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
        .filter((p) => (p.agentType || endedBadly(p)) && !p.orphaned)
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
    const before = { key: this.pressedKey, host: this.pressedHost };
    this.pressedKey = pane.paneKey;
    this.pressedHost = pane.hostId;
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
    if (!r.ok && isStaleHandle(r)) {
      // Orca restarted since the last read and its terminal handles rotated: read the panes again, through the
      // same queue as every refresh, and retry once, only when the pane now has another handle (no loop).
      await this.refresh([], { force: true }).catch(() => {});
      const fresh = this.registry.get(pane.paneKey, pane.hostId);
      if (fresh && fresh.handle !== pane.handle) r = await focusPane(fresh);
    }
    if (!r.ok && this.pressedKey === pane.paneKey) {
      this.pressedKey = before.key;
      this.pressedHost = before.host;
    }
    return r.ok ? 'focused' : 'failed';
  }

  /** Keeps the remembered label data of mapped panes current (titles change while mapped). */
  private refreshBindings(slots: string[]): void {
    for (const s of slots) {
      const cur = this.store.get(s);
      const pane = cur?.pane && this.registry.get(cur.pane.paneKey, cur.pane.executionHostId);
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
    const pane = this.registry.get(b.paneKey, b.executionHostId);
    // A split tab with unnamed panes: the key says which one it is.
    const suffix = (p: PaneInfo) => {
      const s = paneSuffix(p, this.snapshot.panes);
      return s ? ` · ${s}` : '';
    };
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
      label: labelOf(b, pane && suffix(pane)),
      agent: kind,
      host: this.hostName(b.executionHostId, b.lastKnown.host),
      focused:
        !!pane &&
        ((this.focusedKey && this.isFocused(pane)) ||
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
