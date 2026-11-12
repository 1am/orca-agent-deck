import type { PaneInfo } from './adapter.ts';

export interface PaneIdentity {
  paneKey: string;
  worktreePath?: string | undefined;
  title?: string | undefined;
  agent?: string | undefined;
}

export interface Resolution {
  pane: PaneInfo;
  /** Heuristic match: show the "re-linked?" badge until the user presses the key. */
  relinked: boolean;
}

/** paneKey -> current handle map, rebuilt from every pane listing. Handles are never persisted. */
export class PaneRegistry {
  private panes: PaneInfo[] = [];
  private byKey = new Map<string, PaneInfo>();
  private byHostKey = new Map<string, PaneInfo>();

  update(panes: PaneInfo[]): void {
    this.panes = panes;
    this.byKey = new Map(panes.map((p) => [p.paneKey, p]));
    this.byHostKey = new Map(panes.map((p) => [`${p.hostId}\0${p.paneKey}`, p]));
  }

  /** Tab and leaf ids are only unique per host: with `hostId` the pane of that host wins over another with the same key. */
  get(paneKey: string, hostId?: string | null): PaneInfo | undefined {
    return (hostId && this.byHostKey.get(`${hostId}\0${paneKey}`)) || this.byKey.get(paneKey);
  }

  /** Exact paneKey, then recordedPaneKey on an orphaned terminal, then a heuristic match. */
  resolve(id: PaneIdentity): Resolution | undefined {
    const exact = this.byKey.get(id.paneKey);
    if (exact) return { pane: exact, relinked: false };
    const recorded = this.panes.find((p) => p.recordedPaneKey === id.paneKey);
    if (recorded) return { pane: recorded, relinked: false };
    if (!id.worktreePath || !id.title) return undefined;
    const taken = (p: PaneInfo) => p.paneKey !== id.paneKey && this.mappedElsewhere?.has(p.paneKey);
    const candidates = this.panes.filter(
      (p) =>
        p.worktreePath === id.worktreePath &&
        p.title === id.title &&
        (!id.agent || p.agentType === id.agent) &&
        !taken(p),
    );
    // Ambiguous matches are not guessed.
    return candidates.length === 1 && candidates[0]
      ? { pane: candidates[0], relinked: true }
      : undefined;
  }

  /** paneKeys already claimed by other mappings; heuristics must not steal them. */
  mappedElsewhere?: Set<string>;
}
