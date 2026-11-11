export type AgentState = 'working' | 'waiting' | 'blocked' | 'done' | 'idle';

export interface Pane {
  handle: string;
  tabId: string;
  leafId: string;
  title: string;
  agentIdentity: string | null;
  executionHostId: string;
  connected: boolean;
  /** Set when the pane's process ended: Orca reports it with `connected: false`. */
  exitCause?: 'crash' | 'nonzero' | 'clean' | null;
  preview: string;
  lastOutputAt: number;
  agent: {
    state: AgentState;
    toolName: string | null;
    outcome?: string | null;
    stateStartedAt: number;
    /** What `worktree ps` reports as lastAssistantMessage (content stays inside the adapter). */
    lastMessage?: string;
    interactivePrompt?: string;
  } | null;
}

export interface Host {
  id: string;
  /** `runtime`: a paired runtime that only shows up in the listings' host scope, not in `host list`. */
  kind: 'local' | 'ssh' | 'runtime';
  name: string;
  connected: boolean;
}

export interface SimState {
  now: number;
  generation: number;
  appVersion: string;
  hosts: Host[];
  panes: Pane[];
  focusedHandle: string | null;
  /** What `orca plugin list` reports; undefined = the call fails (an unanswered probe). */
  plugins?: { pluginKey: string; status: string }[];
  log: string[];
}

const BASE_TIME = 1_800_000_000_000;

export function newState(): SimState {
  return {
    now: BASE_TIME,
    generation: 1,
    appVersion: '1.4.245',
    hosts: [{ id: 'local', kind: 'local', name: 'this machine', connected: true }],
    panes: [],
    focusedHandle: null,
    log: [],
  };
}

const handleFor = (gen: number, key: string) => `term_g${gen}-${key}`;

export function addPane(
  s: SimState,
  key: string,
  opts: { title?: string; agent?: string | null; host?: string } = {},
): void {
  const agentIdentity = opts.agent === undefined ? 'claude' : opts.agent;
  s.panes.push({
    handle: handleFor(s.generation, key),
    tabId: 'tab-1',
    leafId: `leaf-${key}`,
    title: opts.title ?? (agentIdentity === 'claude' ? 'Claude Code' : key),
    agentIdentity,
    executionHostId: opts.host ?? 'local',
    connected: true,
    preview: '',
    lastOutputAt: s.now,
    agent: agentIdentity ? { state: 'done', toolName: null, stateStartedAt: s.now } : null,
  });
  note(s, `addPane ${key}`);
}

export function removePane(s: SimState, key: string): void {
  s.panes = s.panes.filter((p) => p.leafId !== `leaf-${key}`);
  note(s, `removePane ${key}`);
}

function find(s: SimState, key: string): Pane {
  const p = s.panes.find((x) => x.leafId === `leaf-${key}`);
  if (!p) throw new Error(`unknown pane ${key}`);
  return p;
}

export function setAgent(
  s: SimState,
  key: string,
  state: AgentState,
  toolName: string | null = null,
  extra: { lastMessage?: string; interactivePrompt?: string; outcome?: string | null } = {},
): void {
  const p = find(s, key);
  if (!p.agent) throw new Error(`pane ${key} has no agent`);
  p.agent = { state, toolName, stateStartedAt: s.now, ...extra };
  p.lastOutputAt = s.now;
  note(s, `agent ${key} ${state}${toolName ? `/${toolName}` : ''}`);
}

export function setHost(s: SimState, id: string, connected: boolean): void {
  const h = s.hosts.find((x) => x.id === id);
  if (!h) throw new Error(`unknown host ${id}`);
  h.connected = connected;
  for (const p of s.panes) if (p.executionHostId === id) p.connected = connected;
  note(s, `host ${id} ${connected ? 'up' : 'down'}`);
}

/** Simulated Orca restart: handles rotate, panes keep tab/leaf ids. */
export function restart(s: SimState): void {
  s.generation += 1;
  for (const p of s.panes) p.handle = handleFor(s.generation, p.leafId.slice(5));
  s.focusedHandle = null;
  note(s, `restart gen=${s.generation}`);
}

export function advance(s: SimState, ms: number): void {
  s.now += ms;
}

/** `terminal switch`: records the focus call. */
export function focus(s: SimState, handle: string): void {
  const p = s.panes.find((x) => x.handle === handle);
  if (!p) throw new Error('terminal_handle_stale');
  s.focusedHandle = handle;
  note(s, `focus ${p.leafId.slice(5)}`);
}

function note(s: SimState, msg: string): void {
  s.log.push(`t+${s.now - BASE_TIME}ms ${msg}`);
}

/** The pane's process ended: Orca lists it as disconnected with the cause, and its agent is gone. */
export function exitPane(s: SimState, paneId: string, cause: 'crash' | 'nonzero' | 'clean'): void {
  const p = s.panes.find((x) => x.leafId === `leaf-${paneId}`);
  if (!p) return;
  p.connected = false;
  p.exitCause = cause;
  p.agentIdentity = null;
  p.agent = null;
  note(s, `pane ${paneId} exited (${cause})`);
}
