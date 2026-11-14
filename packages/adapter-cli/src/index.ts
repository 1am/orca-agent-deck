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
  LOCAL_HOST,
  mergeHostCensus,
  paneKey,
  runtimeHostId,
  splitPaneKey,
  unreachableHostIds,
  type HostCensus,
  type ListingHostScope,
  type AgentRawState,
  type AwaitingKind,
} from '@orca-agent-deck/core';
import type { z } from 'zod';
import { resolveOrcaBinCached } from './resolve-bin.ts';
import { spawnPlan } from './spawn-plan.ts';
import {
  environmentListResponse,
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
export * from './spawn-plan.ts';

/** Runs `orca <args>` and returns stdout. Injectable for tests. */
export type Exec = (args: string[]) => Promise<string>;

/** GUI apps (Stream Deck) start plugins with a minimal PATH that lacks the usual `orca` install dirs. */
const EXTRA_PATH = process.platform === 'win32' ? [] : ['/usr/local/bin', '/opt/homebrew/bin'];

export function makeExec(bin?: string, timeoutMs = 5000): Exec {
  return async (args) => {
    const resolved = bin ?? (await resolveOrcaBinCached()).bin;
    return new Promise((resolve, reject) => {
      const path = [process.env['PATH'], ...EXTRA_PATH].filter(Boolean).join(delimiter);
      let plan;
      try {
        plan = spawnPlan(resolved, args, process.platform);
      } catch (e) {
        return reject(e);
      }
      execFile(
        plan.file,
        plan.args,
        {
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PATH: path },
          windowsVerbatimArguments: plan.verbatim,
        },
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

export { unreachableHostIds, type ListingHostScope };

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
  private envLabels: { key: string; labels: Map<string, string> } | null = null;
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
    const paired: { id: string; census: HostCensus | null; busy: string[] }[] = [];
    for (const env of hosts.filter((h) => h.kind === 'environment')) {
      if (!hostsKnown) {
        paired.push({ id: env.id, census: null, busy: [] });
        continue;
      }
      try {
        const r = await this.snapshotOne(env.id);
        local.panes.push(...r.panes);
        local.statuses.push(...r.statuses);
        paired.push({
          id: env.id,
          census: { omitted: r.omittedHostIds, down: r.downHostIds ?? [] },
          busy: r.busyHostIds ?? [],
        });
      } catch {
        paired.push({ id: env.id, census: null, busy: [] });
      }
    }
    const merged = mergeHostCensus(
      { omitted: local.omittedHostIds, down: local.downHostIds ?? [] },
      paired,
    );
    local.omittedHostIds = [...merged.omitted];
    local.downHostIds = [...merged.down];
    local.busyHostIds = [
      ...new Set([...(local.busyHostIds ?? []), ...paired.flatMap((p) => p.busy)]),
    ];
    // Remote panes carry the host's display name; the raw host id means nothing to the user.
    const names = new Map(
      hosts.flatMap(
        (h) =>
          [
            [h.id, h],
            [envHostId(h.id), h],
          ] as const,
      ),
    );
    for (const pane of local.panes) {
      if (isLocalHost(pane.hostId)) continue;
      const h = names.get(pane.hostId);
      pane.hostName = h ? (h.label ?? h.name) : null;
      if (h?.label) pane.hostAddress = h.name;
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
      paneKey: paneKey(t.tabId, t.leafId),
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
    // On a paired server every row is that server's: its own worktrees say `local`.
    const busy = new Set([
      ...panes.map((p) => p.hostId),
      ...ps.result.worktrees.map((w) => (environment ? envHostId(environment) : w.hostId)),
    ]);
    return {
      panes,
      statuses,
      omittedHostIds: [...omitted],
      downHostIds: unreachableHostIds(termScope, psScope),
      busyHostIds: [...busy],
    };
  }

  async listHosts(): Promise<HostInfo[]> {
    const r = await this.call(hostListResponse, ['host', 'list']);
    // A paired server Orca deployed onto an SSH target is named by its address; the target has the
    // connection name the user knows. The runtime route says it in `label`; the plain CLI needs the
    // environment list, read once per set of servers. Best effort: the list stands without it.
    const labels = new Map<string, string>();
    const envs = r.result.hosts.filter((h) => h.kind === 'environment');
    for (const h of envs) if (h.label) labels.set(h.id, h.label);
    if (envs.some((h) => !h.label)) {
      const sshNames = new Map(
        r.result.hosts.filter((h) => h.kind === 'ssh').map((h) => [h.id, h.name]),
      );
      const key = JSON.stringify([...envs.map((h) => h.id), ...sshNames]);
      if (this.envLabels?.key !== key) {
        const found = new Map<string, string>();
        try {
          const e = await this.call(environmentListResponse, ['environment', 'list']);
          for (const env of e.result.environments) {
            const label = sshNames.get(env.orcadDeployment?.sshTargetId ?? '');
            if (label && label !== env.name) found.set(env.id, label);
          }
          this.envLabels = { key, labels: found };
        } catch {
          // keep the address; try again next time
        }
      }
      for (const [id, label] of this.envLabels?.labels ?? [])
        if (!labels.has(id)) labels.set(id, label);
    }
    return r.result.hosts.map((h) => {
      const label = labels.get(h.id);
      return {
        id: h.id,
        kind: h.kind,
        name: h.name,
        ...(label ? { label } : {}),
        connected: h.kind === 'local' ? true : (h.connected ?? false),
      };
    });
  }

  /**
   * The pane the Orca window has focused. Only readable while a local worktree is shown:
   * `terminal show` knows just the local runtime's last pane, and for a paired server Orca
   * publishes no focus that follows clicks (its remote layout snapshot lags and reports other
   * panes). Then the answer is null and the deck refuses to guess.
   */
  /** Why the last focus read had no answer (counts only), for the plugin log. */
  focusNote = '';

  /** Execution host of the worktree the last focus read found shown, null when none was. */
  focusHostId: string | null = null;

  /** The last focus read was a guess (`terminal show` names the local runtime's last pane), not what is focused. */
  focusGuessed = false;

  /**
   * Focus local panes through `terminal.reveal` too. Unlike `terminal.focus`, reveal brings Orca's
   * window to the front, with Orca's own workarounds for the Windows foreground lock. For hosts
   * where the plugin cannot raise Orca itself (Windows).
   */
  revealLocal = false;

  async focusedPaneKey(maxAgeMs = 0): Promise<string | null> {
    this.focusGuessed = false;
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
      this.focusHostId = active ? active.hostId : null;
      if (!active) {
        // Orca marks no worktree active (a paired server may be the one shown). Guessing from the
        // layouts could pin a pane that is not on screen, so the answer stays unknown.
        this.focusNote += ' no-active-worktree';
        return null;
      }
      const fromLayout = activePaneKey(layouts, active.worktreeId);
      if (fromLayout) return fromLayout;
      this.focusNote += ' active-worktree-has-no-layout';
      if (!isLocalHost(active.hostId)) {
        // `terminal show` answers for the local runtime only: on a remote host's worktree it would
        // name a local pane. The answer stays unknown.
        this.focusNote += ' remote-worktree';
        return null;
      }
      const r = await this.call(terminalShowResponse, ['terminal', 'show']);
      this.focusGuessed = true;
      return paneKey(r.result.terminal.tabId, r.result.terminal.leafId);
    } catch (e) {
      this.focusHostId = null;
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
    const { tabId, leafId } = splitPaneKey(pane.paneKey);
    if ((pane.environment || this.revealLocal) && pane.worktreeId && tabId && leafId) {
      // A paired server has no window: the CLI asks it about the pane (a new remote connection
      // per call, 1.3-3.4 s) and then has this Orca reveal it. We know the pane already, so we
      // ask this Orca directly (`terminal.reveal`, as the CLI does in its last step).
      const host = pane.environment ? ['--execution-host', runtimeHostId(pane.environment)] : [];
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
          ...host,
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
      const code = (e as { code?: unknown }).code;
      return {
        ok: false,
        error: (e as Error).message,
        ...(typeof code === 'string' ? { code } : {}),
      };
    }
  }
}
