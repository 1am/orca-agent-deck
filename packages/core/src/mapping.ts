export interface PaneBinding {
  paneKey: string;
  worktreeId: string;
  tabId: string;
  leafId: string;
  executionHostId?: string;
  lastKnown: {
    repo?: string;
    branch?: string;
    worktreePath?: string;
    title?: string;
    paneTitle?: string;
    agent?: string;
    /** Display name of the remote host. */
    host?: string;
  };
}

/** Where a key sits on a device. Stable across reinstalls, unlike the action context. */
export interface SlotPosition {
  device: string;
  column: number;
  row: number;
}

export interface SlotSettings {
  mode: 'pinned' | 'auto';
  /** Last known key position, used to carry the mapping over when the action context changes. */
  pos?: SlotPosition;
  pane?: PaneBinding;
  autoFilter?: Record<string, unknown>;
  /** ms epoch when the bound pane was last seen; used for offline retention. */
  lastSeenAt?: number;
}

export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * An auto-filled slot keeps a vanished pane this long before it is freed. A pane can drop out of
 * one listing (an SSH host reconnecting, a layout reload) and come back; freeing the slot at once
 * let auto-fill hand the key to another pane for good.
 */
export const DEFAULT_AUTO_GRACE_MS = 60 * 1000;

/** Storage abstraction (Stream Deck action settings are plugged in by EPIC 5). */
export interface SlotStorage {
  load(): Record<string, SlotSettings>;
  save(slots: Record<string, SlotSettings>): void;
}

export class MemoryStorage implements SlotStorage {
  private data: Record<string, SlotSettings> = {};
  load() {
    return structuredClone(this.data);
  }
  save(slots: Record<string, SlotSettings>) {
    this.data = structuredClone(slots);
  }
}

const samePos = (a?: SlotPosition, b?: SlotPosition) =>
  !!a && !!b && a.device === b.device && a.column === b.column && a.row === b.row;

export class MappingStore {
  private slots: Record<string, SlotSettings>;
  private readonly storage: SlotStorage;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly autoGraceMs: number;
  constructor(
    storage: SlotStorage = new MemoryStorage(),
    now: () => number = Date.now,
    retentionMs = DEFAULT_RETENTION_MS,
    autoGraceMs = DEFAULT_AUTO_GRACE_MS,
  ) {
    this.autoGraceMs = autoGraceMs;
    this.storage = storage;
    this.now = now;
    this.retentionMs = retentionMs;
    this.slots = storage.load();
  }

  get(slot: string): SlotSettings | undefined {
    return this.slots[slot];
  }

  set(slot: string, s: SlotSettings): void {
    this.slots[slot] = {
      ...s,
      pos: s.pos ?? this.slots[slot]?.pos,
      lastSeenAt: s.pane ? this.now() : s.lastSeenAt,
    };
    this.persist();
  }

  /**
   * Records where a key sits. A key with no settings of its own takes over the mapping of a vanished
   * key (reinstall, re-imported profile: new action context) at the same position, when exactly one
   * such key exists (the other keys being on another page cannot be told apart from vanished ones,
   * hence only keys without any settings inherit). Returns true when a mapping was carried over.
   */
  locate(
    slot: string,
    pos: SlotPosition,
    live: ReadonlySet<string>,
    /** Devices seen live since this process started: their keys are not a host switch, a deck just went away. */
    seenDevices: ReadonlySet<string> = new Set(),
  ): boolean {
    const cur = this.slots[slot];
    // Only a key never seen before may inherit: a known key keeps its own settings, and a key that is
    // merely on another page right now must not be mistaken for a vanished one.
    if (cur) {
      if (!samePos(cur.pos, pos)) {
        cur.pos = pos;
        this.persist();
      }
      return false;
    }
    const vanished = Object.entries(this.slots).filter(
      ([k, o]) =>
        k !== slot &&
        !live.has(k) &&
        o.pane &&
        o.pos?.column === pos.column &&
        o.pos.row === pos.row,
    );
    // The same deck seen by another host has another device id (OpenDeck: `sd-<serial>`): without an exact
    // device match, take a vanished key whose device has no live key left, so two real decks are never merged.
    const liveDevices = new Set(
      Object.entries(this.slots).flatMap(([k, o]) => (live.has(k) && o.pos ? [o.pos.device] : [])),
    );
    // Another live deck with a key at this position could be the owner of that orphan, and a deck that was live a
    // moment ago (Stream Deck Mobile disconnecting) is gone, not another host's name for this one: neither inherits.
    const liveElsewhere = Object.entries(this.slots).some(
      ([k, o]) =>
        live.has(k) &&
        o.pos?.device !== pos.device &&
        o.pos?.column === pos.column &&
        o.pos.row === pos.row,
    );
    const exact = vanished.filter(([, o]) => samePos(o.pos, pos));
    const orphans = exact.length
      ? exact
      : liveElsewhere
        ? []
        : vanished.filter(
            ([, o]) => !liveDevices.has(o.pos!.device) && !seenDevices.has(o.pos!.device),
          );
    if (orphans.length === 1) {
      const [k, o] = orphans[0]!;
      delete this.slots[k];
      this.slots[slot] = { ...o, pos };
    } else {
      this.slots[slot] = { mode: 'auto', pos };
    }
    this.persist();
    return orphans.length === 1;
  }

  remove(slot: string): void {
    delete this.slots[slot];
    this.persist();
  }

  /** paneKey -> slot contexts (a pane may be shown on several slots). */
  slotsFor(paneKey: string): string[] {
    return Object.entries(this.slots)
      .filter(([, s]) => s.pane?.paneKey === paneKey)
      .map(([k]) => k);
  }

  /** Number of slots currently holding a pane. */
  mappedCount(): number {
    return Object.values(this.slots).filter((s) => s.pane).length;
  }

  mappedPaneKeys(): Set<string> {
    return new Set(Object.values(this.slots).flatMap((s) => (s.pane ? [s.pane.paneKey] : [])));
  }

  /**
   * Reconcile with the live pane list: refresh lastSeenAt for present panes, free auto slots
   * of panes gone longer than the grace period, drop pinned mappings of panes gone longer than retention.
   * Returns the slots that were cleared.
   */
  reconcile(livePaneKeys: Set<string>): string[] {
    const cleared: string[] = [];
    const t = this.now();
    for (const [k, s] of Object.entries(this.slots)) {
      if (!s.pane) continue;
      if (livePaneKeys.has(s.pane.paneKey)) {
        s.lastSeenAt = t;
      } else if (s.mode === 'auto') {
        if (t - (s.lastSeenAt ?? t) >= this.autoGraceMs) {
          delete s.pane;
          cleared.push(k);
        }
      } else if (t - (s.lastSeenAt ?? t) > this.retentionMs) {
        delete s.pane;
        cleared.push(k);
      }
    }
    this.persist();
    return cleared;
  }

  private persist(): void {
    this.storage.save(this.slots);
  }
}
