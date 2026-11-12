import type { AwaitingKind } from './awaiting.ts';
import type { AgentRawState } from './status.ts';

/** paneKey = `${tabId}:${leafId}` (stable across handle changes). */
export interface PaneRef {
  paneKey: string;
  hostId: string;
}

export interface PaneInfo extends PaneRef {
  handle: string;
  worktreeId: string;
  title: string;
  connected: boolean;
  exitCause?: 'crash' | 'nonzero' | 'clean' | null;
  agentType: string | null;
  worktreePath?: string | null;
  /** Project (repo) name and branch of the worktree, for grouping. */
  repo?: string | null;
  branch?: string | null;
  tabTitle?: string | null;
  /** Paired Orca server (`--environment`) that issued the handle; absent for this machine and its SSH hosts. */
  environment?: string | null;
  /** Display name of a remote host (SSH target or paired server); absent for this machine. */
  hostName?: string | null;
  /** Orca marks terminals whose pane is gone. */
  orphaned?: boolean;
  /** paneKey this terminal was recorded under before a restart, when Orca reports it. */
  recordedPaneKey?: string | null;
  /** ms epoch of the pane's last output, when Orca reports it. */
  lastOutputAt?: number | null;
}

export interface PaneStatusEvent {
  paneKey: string;
  state: AgentRawState;
  outcome?: string | null;
  toolName?: string | null;
  agentType?: string | null;
  stateStartedAt: number;
  /** Made by the deck from shell activity, not reported by Orca or an agent. */
  synthetic?: boolean;
  /**
   * The agent asks the user something: `question` = a structured question tool is pending,
   * `text` = the turn ended with a question (classified). Decided by the adapter; the message
   * text itself never leaves the adapter.
   */
  awaiting?: AwaitingKind | null;
}

export interface HostInfo {
  id: string;
  kind: 'local' | 'ssh' | 'environment';
  name: string;
  connected: boolean;
}

export interface FocusResult {
  ok: boolean;
  error?: string;
  /** Orca's error code when it gave one (`terminal_handle_stale`, ...), else absent. */
  code?: string;
}

export interface AdapterHealth {
  orcaRunning: boolean;
  version: string | null;
  /** True when events are pushed; absent means the adapter polls (degraded). */
  live?: boolean;
  /** True when Orca is older than the declared minimum. */
  unsupported?: boolean;
  /** True when reads are cheap (runtime socket), so extra calls per refresh are fine. */
  fast?: boolean;
}

export interface Snapshot {
  panes: PaneInfo[];
  statuses: PaneStatusEvent[];
  /** Hosts whose panes are missing from the snapshot. */
  omittedHostIds: string[];
  /**
   * Hosts no listing could reach, for the Setup "hosts down" count. A host omitted by one listing
   * but covered by the other is not down. Adapters that do not report it fall back to
   * `omittedHostIds`.
   */
  downHostIds?: string[];
  /**
   * Hosts this read shows anything on (a worktree, a terminal, an agent): what Orca's left sidebar
   * lists. Only these count as down once they stop answering. Unset: every down host counts.
   */
  busyHostIds?: string[];
}

export interface OrcaAdapter {
  /**
   * Minimum time between reads (`health` + `snapshot`) for an adapter that spawns a process per
   * read: refreshes in between reuse the last snapshot. Unset when a read is cheap.
   */
  readonly minReadIntervalMs?: number;
  health(): Promise<AdapterHealth>;
  snapshot(): Promise<Snapshot>;
  listHosts(): Promise<HostInfo[]>;
  focus(
    pane: PaneRef & { handle: string; environment?: string | null; worktreeId?: string },
  ): Promise<FocusResult>;
  /**
   * paneKey of the pane focused in Orca right now (any host), or null when unknown. `maxAgeMs`
   * lets the adapter answer from pane reads it made that recently (the refresh's own snapshot).
   */
  focusedPaneKey?(maxAgeMs?: number): Promise<string | null>;
  /** Why the last focus read had no answer (counts only), for the log. */
  readonly focusNote?: string;
  /** Execution host of the worktree shown in the last focus read (ids repeat across hosts), null when none was. */
  readonly focusHostId?: string | null;
  /** Clears Orca's unread dot for a worktree (`isUnread`), so reading in the deck clears it in Orca too. */
  markWorktreeRead?(worktreeId: string): Promise<void>;
}
