import type { Pane, SimState } from './sim.ts';

const envelope = <T>(result: T) => ({ id: 'fake', ok: true, result });
const WORKTREE = 'fake-repo::/fake/agent-deck';

function terminal(p: Pane) {
  return {
    handle: p.handle,
    worktreeId: WORKTREE,
    worktreePath: '/fake/agent-deck',
    branch: 'refs/heads/main',
    tabId: p.tabId,
    leafId: p.leafId,
    title: p.title,
    paneTitle: null,
    connected: p.connected,
    exitCause: null,
    verdict: null,
    writable: true,
    lastOutputAt: p.lastOutputAt,
    preview: p.preview,
    executionHostId: p.executionHostId,
    agentIdentity: p.agentIdentity,
    hostScope: 'local',
  };
}

function scope(s: SimState) {
  return {
    hostIds: s.hosts.filter((h) => h.connected).map((h) => h.id),
    omittedHostIds: s.hosts.filter((h) => !h.connected).map((h) => h.id),
  };
}

/** Layout tree with the selected tab/pane, like Orca's `--include-visual-layouts` (no titles). */
function visualLayouts(s: SimState) {
  const focused = s.panes.find((p) => p.handle === s.focusedHandle);
  if (!focused) return [];
  const tabIds = [...new Set(s.panes.map((p) => p.tabId))];
  return [
    {
      worktreeId: WORKTREE,
      root: {
        type: 'group',
        activeTabId: focused.tabId,
        tabs: tabIds.map((tabId) => ({
          tabId,
          activeLeafId:
            tabId === focused.tabId
              ? focused.leafId
              : s.panes.find((p) => p.tabId === tabId)?.leafId,
          panes: {},
        })),
      },
    },
  ];
}

export function terminalList(s: SimState) {
  const terminals = s.panes.map(terminal);
  return envelope({
    terminals,
    visualLayouts: visualLayouts(s),
    hostScope: scope(s),
    totalCount: terminals.length,
    truncated: false,
  });
}

export function worktreePs(s: SimState) {
  const agents = s.panes.flatMap((p) =>
    p.agent
      ? [
          {
            paneKey: `${p.tabId}:${p.leafId}`,
            state: p.agent.state,
            agentType: p.agentIdentity,
            toolName: p.agent.toolName,
            interrupted: false,
            ...(p.agent.lastMessage === undefined
              ? {}
              : { lastAssistantMessage: p.agent.lastMessage }),
            ...(p.agent.interactivePrompt === undefined
              ? {}
              : { interactivePrompt: p.agent.interactivePrompt }),
            ...(p.agent.outcome === undefined
              ? {}
              : {
                  mainAgent: {
                    state: p.agent.state,
                    outcome: p.agent.outcome,
                    stateStartedAt: p.agent.stateStartedAt,
                  },
                }),
            stateStartedAt: p.agent.stateStartedAt,
            updatedAt: p.agent.stateStartedAt,
            hasLivePty: p.connected,
            programStatus: {
              state: p.agent.state === 'working' ? 'busy' : 'idle',
              observedAt: s.now,
            },
          },
        ]
      : [],
  );
  const wt = {
    worktreeId: WORKTREE,
    path: '/fake/agent-deck',
    isActive: s.focusedHandle !== null,
    liveTerminalCount: s.panes.length,
    agents,
  };
  return envelope({ worktrees: [wt], hostScope: scope(s), totalCount: 1, truncated: false });
}

export function hostList(s: SimState) {
  return envelope({
    hosts: s.hosts
      .filter((h) => h.kind !== 'runtime')
      .map((h) => ({
        kind: h.kind,
        name: h.name,
        id: h.id,
        selector: h.kind === 'local' ? '--host local' : `--host ssh:${h.id}`,
        ...(h.kind === 'ssh' ? { connected: h.connected } : {}),
      })),
  });
}

export function status(s: SimState) {
  return envelope({
    target: { kind: 'local' },
    app: { running: true, desktopWindowStatus: 'available' },
    runtime: { state: 'ready', reachable: true, appVersion: s.appVersion },
  });
}
