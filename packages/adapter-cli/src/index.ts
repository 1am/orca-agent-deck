import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import type {
  AdapterHealth,
  FocusResult,
  HostInfo,
  OrcaAdapter,
  PaneInfo,
  PaneRef,
  PaneStatusEvent,
  Snapshot,
} from '@orca-agent-deck/core';
import {
  classifyFinalMessage,
  envHostId,
  isLocalHost,
  isRuntimeHostId,
  LOCAL_HOST,
  runtimeHostId,
  type AgentRawState,
  type AwaitingKind,
} from '@orca-agent-deck/core';
import type { z } from 'zod';
import { resolveOrcaBinCached } from './resolve-bin.ts';
import {
  hostListResponse,
  tabTitles,
  activePaneKey,
  statusResponse,
  revealResponse,
  switchResponse,
  terminalShowResponse,
  terminalListResponse,
  worktreePsResponse,
  agentEntry,
  takeSchemaIssues,
} from './schemas.ts';

export * from './schemas.ts';
export * from './resolve-bin.ts';

/** Runs `orca <args>` and returns stdout. Injectable for tests. */
export type Exec = (args: string[]) => Promise<string>;

/** GUI apps (Stream Deck) start plugins with a minimal PATH that lacks the usual `orca` install dirs. */
const EXTRA_PATH = process.platform === 'win32' ? [] : ['/usr/local/bin', '/opt/homebrew/bin'];

export function makeExec(bin?: string, timeoutMs = 5000): Exec {
  return async (args) => {
    const resolved = bin ?? (await resolveOrcaBinCached()).bin;
    return new Promise((resolve, reject) => {
      const path = [process.env['PATH'], ...EXTRA_PATH].filter(Boolean).join(delimiter);
      execFile(
        resolved,
        args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: path } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  };
}

const RAW_STATES = new Set<AgentRawState>(['working', 'waiting', 'blocked', 'done', 'idle']);

/** Oldest Orca app version the adapter is known to work with. */
export const MIN_ORCA_VERSION = '1.4.245';

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Does this agent entry ask the user something? Keeps the verdict, drops the text. */
export function awaitingOf(
  a: z.infer<typeof agentEntry>,
  state: AgentRawState,
  outcome: string | null | undefined,
): AwaitingKind | null {
  // A structured question tool is pending (permission approvals use `approval`, not `questions`).
  if (a.interactivePrompt && state !== 'done' && /"questions"\s*:/.test(a.interactivePrompt)) {
    return 'question';
  }
  if (state !== 'done' || a.interrupted) return null;
  if (outcome && !['success', 'unconfirmed'].includes(outcome)) return null;
  // The last message may be tool output rather than something the agent said.
  if (a.lastAssistantMessageIsToolOutput) return null;
  return classifyFinalMessage(a.lastAssistantMessage).asks ? 'text' : null;
}

/**
 * Hosts no listing could reach. Orca's `hostScope` reports the hosts a listing covered (`hostIds`)
 * and the ones it left out (`omittedHostIds`). A host one listing covered answered that query, even
 * when the other had nothing to report for it: an SSH host with worktrees but no terminals appears
 * only in the terminal listing's gaps.
 *
 * This drives the "hosts down" count only. `omittedHostIds` stays the union of both listings, so a
 * key keeps its last known state for every host a listing could not see.
 */
export function unreachableHostIds(
  terminalScope: ListingHostScope | undefined,
  worktreeScope: ListingHostScope | undefined,
): string[] {
  const scopes = [terminalScope, worktreeScope].filter(
    (scope): scope is ListingHostScope => scope !== undefined,
  );
  const covered = new Set(scopes.flatMap((scope) => scope.hostIds ?? []));
  const omitted = new Set(scopes.flatMap((scope) => scope.omittedHostIds ?? []));
  // `local` answered the call it came from.
  return [...omitted].filter((id) => !isLocalHost(id) && !covered.has(id));
}

export type ListingHostScope = {
  hostIds?: readonly string[];
  omittedHostIds?: readonly string[];
};

export class CliAdapter implements OrcaAdapter {
  /**
   * One read costs 4 `orca` spawns (status, terminal list, worktree ps, host list), and NFR-2 allows
   * 1 call per second.
   */
  readonly minReadIntervalMs = 4000;
  /** Where skipped items are reported (the plugin log), once per distinct issue. */
  diag?: (message: string) => void;
  private readonly loggedIssues = new Set<string>();
  private readonly exec: Exec;
  private readonly now: () => number;
  private unsupported = false;
  /** The local pane reads of the last snapshot, reused by the focus check right after it. */
  private localRead: {
    ps: z.infer<typeof worktreePsResponse>;
    terms: z.infer<typeof terminalListResponse>;
    at: number;
  } | null = null;
  /** Last host list that answered: a failing `host list` must not make paired servers vanish. */
  private lastHosts: HostInfo[] = [];
  constructor(exec: Exec = makeExec(), now: () => number = Date.now) {
    this.exec = exec;
    this.now = now;
  }

  private async call<T extends z.ZodTypeAny>(schema: T, args: string[]): Promise<z.infer<T>> {
    const out = await this.exec([...args, '--json']);
    try {
      return schema.parse(JSON.parse(out));
    } finally {
      // Also when the parse throws: skipped items found before it belong to this call, not the next.
      for (const issue of takeSchemaIssues()) {
        if (this.loggedIssues.has(issue)) continue;
        if (this.loggedIssues.size > 200) this.loggedIssues.clear();
        this.loggedIssues.add(issue);
        this.diag?.(`orca ${args.slice(0, 2).join(' ')}: skipped ${issue}`);
      }
    }
  }

  async health(): Promise<AdapterHealth> {
    try {
      const r = await this.call(statusResponse, ['status']);
      const version = r.result.runtime.appVersion ?? null;
      this.unsupported = version !== null && compareVersions(version, MIN_ORCA_VERSION) < 0;
      return {
        orcaRunning: r.result.app.running && r.result.runtime.state === 'ready',
        version,
        unsupported: this.unsupported,
      };
    } catch {
      return { orcaRunning: false, version: null };
    }
  }

  async snapshot(): Promise<Snapshot> {
    if (this.unsupported) throw new Error('unsupported Orca version');
    const local = await this.snapshotOne(null);
    // Paired Orca servers are separate runtimes reached with --environment; handles are per server.
    let hosts: HostInfo[];
    let hostsKnown = true;
    try {
      hosts = this.lastHosts = await this.listHosts();
    } catch {
      // Seen after wake: without the list the paired-server panes would drop out unmarked and
      // their auto keys would be handed to other panes. Treat those servers as down instead.
      hosts = this.lastHosts;
      hostsKnown = false;
    }
    const omitted = new Set(local.omittedHostIds);
    const down = new Set(local.downHostIds ?? []);
    for (const env of hosts.filter((h) => h.kind === 'environment')) {
      omitted.delete(runtimeHostId(env.id));
      down.delete(runtimeHostId(env.id));
      if (!hostsKnown) {
        omitted.add(envHostId(env.id));
        down.add(envHostId(env.id));
        continue;
      }
      try {
        const r = await this.snapshotOne(env.id);
        local.panes.push(...r.panes);
        local.statuses.push(...r.statuses);
        for (const h of r.omittedHostIds) omitted.add(h);
        // A paired server's own `runtime:` peers belong to its control plane, not to our census.
        for (const h of r.downHostIds ?? []) if (!isRuntimeHostId(h)) down.add(h);
      } catch {
        omitted.add(envHostId(env.id));
        down.add(envHostId(env.id));
      }
    }
    local.omittedHostIds = [...omitted];
    local.downHostIds = [...down];
    // Remote panes carry the host's display name; the raw host id means nothing to the user.
    const names = new Map(
      hosts.flatMap(
        (h) =>
          [
            [h.id, h.name],
            [envHostId(h.id), h.name],
          ] as const,
      ),
    );
    for (const pane of local.panes) {
      if (!isLocalHost(pane.hostId)) pane.hostName = names.get(pane.hostId) ?? null;
    }
    return local;
  }

  private async snapshotOne(environment: string | null): Promise<Snapshot> {
    const envArgs = environment ? ['--environment', environment] : [];
    const [terms, ps] = await Promise.all([
      this.call(terminalListResponse, ['terminal', 'list', '--include-visual-layouts', ...envArgs]),
      this.call(worktreePsResponse, ['worktree', 'ps', ...envArgs]),
    ]);
    if (!environment) this.localRead = { ps, terms, at: this.now() };
    const titles = tabTitles(terms.result.visualLayouts);
    const wts = new Map(ps.result.worktrees.map((w) => [w.worktreeId, w]));
    const panes: PaneInfo[] = terms.result.terminals.map((t) => ({
      paneKey: `${t.tabId}:${t.leafId}`,
      hostId: environment ? envHostId(environment) : t.executionHostId,
      handle: t.handle,
      worktreeId: t.worktreeId,
      // A title set in Orca (set-pane-title) wins, then the Orca tab title; the terminal's own
      // title (tmux rewrites it with the active window) is the last resort.
      title: t.paneTitle || titles.get(t.tabId) || t.title,
      connected: t.connected,
      exitCause: t.exitCause ?? null,
      agentType: t.agentIdentity ?? null,
      worktreePath: t.worktreePath ?? null,
      environment,
      repo: wts.get(t.worktreeId)?.repo ?? null,
      branch:
        wts.get(t.worktreeId)?.branch?.replace('refs/heads/', '') ??
        t.branch?.replace('refs/heads/', '') ??
        null,
      tabTitle: titles.get(t.tabId) ?? null,
      orphaned: t.orphaned ?? false,
      recordedPaneKey: t.recordedPaneKey ?? null,
      lastOutputAt: t.lastOutputAt ?? null,
    }));
    const statuses: PaneStatusEvent[] = [];
    for (const wt of ps.result.worktrees) {
      for (const a of wt.agents) {
        const state = (a.mainAgent?.state ?? a.state) as AgentRawState;
        if (!RAW_STATES.has(state)) continue;
        statuses.push({
          paneKey: a.paneKey,
          state,
          outcome: a.mainAgent?.outcome ?? null,
          // Orca keeps toolName after done; only meaningful while the agent is active.
          toolName: state === 'done' || state === 'idle' ? null : (a.toolName ?? null),
          agentType: a.agentType ?? null,
          stateStartedAt: a.stateStartedAt,
          awaiting: awaitingOf(a, state, a.mainAgent?.outcome ?? null),
        });
      }
    }
    // Hooks report the agent even when the pane title/identity does not show it (e.g. claude inside tmux).
    for (const p of panes) {
      if (!p.agentType)
        p.agentType = statuses.find((x) => x.paneKey === p.paneKey)?.agentType ?? null;
    }
    const termScope = terms.result.hostScope;
    const psScope = ps.result.hostScope;
    const omitted = new Set([
      ...(termScope?.omittedHostIds ?? []),
      ...(psScope?.omittedHostIds ?? []),
    ]);
    // Orca answering means its own host is up; it was seen flapping into omittedHostIds.
    omitted.delete(LOCAL_HOST);
    return {
      panes,
      statuses,
      omittedHostIds: [...omitted],
      downHostIds: unreachableHostIds(termScope, psScope),
    };
  }

  async listHosts(): Promise<HostInfo[]> {
    const r = await this.call(hostListResponse, ['host', 'list']);
    return r.result.hosts.map((h) => ({
      id: h.id,
      kind: h.kind,
      name: h.name,
      connected: h.kind === 'local' ? true : (h.connected ?? false),
    }));
  }

  /**
   * The pane the Orca window has focused. Only readable while a local worktree is shown:
   * `terminal show` knows just the local runtime's last pane, and for a paired server Orca
   * publishes no focus that follows clicks (its remote layout snapshot lags and reports other
   * panes). Then the answer is null and the deck refuses to guess.
   */
  /** Why the last focus read had no answer (counts only), for the plugin log. */
  focusNote = '';

  async focusedPaneKey(maxAgeMs = 0): Promise<string | null> {
    try {
      const cached =
        this.localRead && this.now() - this.localRead.at < maxAgeMs ? this.localRead : null;
      const ps = cached?.ps ?? (await this.call(worktreePsResponse, ['worktree', 'ps']));
      const active = ps.result.worktrees.find((w) => w.isActive);
      // The layout tree knows the selected tab; `terminal show` only the first one.
      const terms =
        cached?.terms ??
        (await this.call(terminalListResponse, ['terminal', 'list', '--include-visual-layouts']));
      const layouts = terms.result.visualLayouts ?? [];
      this.focusNote = `worktrees=${ps.result.worktrees.length} active=${active ? 1 : 0} layouts=${layouts.length}`;
      if (!active) {
        // Orca marks no worktree active (a paired server may be the one shown). Guessing from the
        // layouts could pin a pane that is not on screen, so the answer stays unknown.
        this.focusNote += ' no-active-worktree';
        return null;
      }
      const fromLayout = activePaneKey(layouts, active.worktreeId);
      if (fromLayout) return fromLayout;
      this.focusNote += ' active-worktree-has-no-layout';
      const r = await this.call(terminalShowResponse, ['terminal', 'show']);
      return `${r.result.terminal.tabId}:${r.result.terminal.leafId}`;
    } catch (e) {
      this.focusNote = `focus read failed: ${(e as Error).message.slice(0, 80)}`;
      return null;
    }
  }

  /** `worktree set --read`: clears the unread dot in Orca. Local worktrees only. */
  async markWorktreeRead(worktreeId: string): Promise<void> {
    await this.exec(['worktree', 'set', '--worktree', `id:${worktreeId}`, '--read', '--json']);
  }

  async focus(
    pane: PaneRef & { handle: string; environment?: string | null; worktreeId?: string },
  ): Promise<FocusResult> {
    const [tabId, leafId] = pane.paneKey.split(':');
    if (pane.environment && pane.worktreeId && tabId && leafId) {
      // A paired server has no window: the CLI asks it about the pane (a new remote connection
      // per call, 1.3-3.4 s) and then has this Orca reveal it. We know the pane already, so we
      // ask this Orca directly (`terminal.reveal`, as the CLI does in its last step).
      try {
        const r = await this.call(revealResponse, [
          'terminal',
          'reveal',
          '--worktree',
          pane.worktreeId,
          '--tab',
          tabId,
          '--leaf',
          leafId,
          '--execution-host',
          runtimeHostId(pane.environment),
        ]);
        if (r.result.reveal.navigated) return { ok: true };
      } catch {
        // No runtime socket (CLI-only mode) or an older Orca: take the CLI path below.
      }
    }
    try {
      const envArgs = pane.environment ? ['--environment', pane.environment] : [];
      const r = await this.call(switchResponse, [
        'terminal',
        'switch',
        '--terminal',
        pane.handle,
        ...envArgs,
      ]);
      return r.result.focus?.navigated === false
        ? { ok: false, error: 'not navigated' }
        : { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
