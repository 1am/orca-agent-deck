import type { AwaitingKind } from './awaiting.ts';

export type DeckState =
  | 'unmapped'
  | 'offline'
  | 'unreachable'
  | 'idle'
  | 'working'
  | 'needs_input'
  | 'awaiting_reply'
  | 'completed'
  | 'error'
  | 'cancelled';

export type AgentRawState = 'working' | 'waiting' | 'blocked' | 'done' | 'idle';

export interface PaneObservation {
  mapped: boolean;
  orcaRunning: boolean;
  /** Pane present in the latest terminal list. */
  found: boolean;
  connected: boolean;
  /** Execution host is in hostScope.omitted or its connection is down. */
  hostDown: boolean;
  agentType: string | null;
  agent: { state: AgentRawState; outcome?: string | null; awaiting?: AwaitingKind | null } | null;
  exitCause?: 'crash' | 'nonzero' | 'clean' | null;
}

const SUCCESS = new Set(['success', 'unconfirmed']);
const CANCEL = new Set(['cancellation', 'interruption', 'superseded']);

/** Per-harness overrides for the default done-outcome mapping. */
const harnessOverrides: Record<string, Partial<Record<string, DeckState>>> = {};

function doneState(agentType: string | null, outcome: string | null | undefined): DeckState {
  const o = outcome ?? 'unconfirmed';
  const override = agentType ? harnessOverrides[agentType]?.[o] : undefined;
  if (override) return override;
  if (SUCCESS.has(o)) return 'completed';
  if (o === 'failure') return 'error';
  if (CANCEL.has(o)) return 'cancelled';
  return 'completed';
}

export interface DerivedState {
  state: DeckState;
  stale: boolean;
  lastKnown?: DeckState | undefined;
}

/**
 * Derive the deck state of one pane. `lastKnown` is kept while the host is
 * unreachable so the key shows the last state with a link-broken badge.
 */
export function deriveDeckState(obs: PaneObservation, lastKnown?: DeckState): DerivedState {
  const fresh = (state: DeckState) => ({ state, stale: false });
  if (!obs.mapped) return fresh('unmapped');
  if (!obs.orcaRunning) return fresh('offline');
  if (obs.hostDown) {
    return { state: 'unreachable', stale: true, lastKnown };
  }
  if (!obs.found) return fresh('offline');
  // Orca lists a pane whose process ended as disconnected with the cause: a crash is an error, not "offline".
  if (obs.exitCause === 'crash' || obs.exitCause === 'nonzero') return fresh('error');
  if (!obs.connected) return fresh('offline');
  const a = obs.agent;
  if (!a) return fresh('idle');
  switch (a.state) {
    case 'working':
      // A pending structured question (AskUserQuestion) can still read as working in Orca.
      return fresh(a.awaiting === 'question' ? 'awaiting_reply' : 'working');
    case 'waiting':
    case 'blocked':
      return fresh(a.awaiting === 'question' ? 'awaiting_reply' : 'needs_input');
    case 'done': {
      const done = doneState(obs.agentType, a.outcome);
      // Only a successful turn that ended with a question; a failure or stop stays what it is.
      return fresh(done === 'completed' && a.awaiting ? 'awaiting_reply' : done);
    }
    default:
      return fresh('idle');
  }
}

/** Colour and line-2 text per deck state. */
export const stateColour: Record<DeckState, string> = {
  unmapped: 'dark grey',
  offline: 'dim grey',
  unreachable: 'dim grey + link-broken',
  idle: 'grey',
  working: 'blue',
  needs_input: 'amber',
  awaiting_reply: 'orange + speech bubble',
  completed: 'green',
  error: 'red',
  cancelled: 'purple-grey',
};

export function lineTwo(
  state: DeckState,
  ctx: { elapsedMs?: number; agentName?: string | null } = {},
): string {
  const secs = Math.floor((ctx.elapsedMs ?? 0) / 1000);
  switch (state) {
    case 'unmapped':
      return 'empty';
    case 'offline':
      return 'offline';
    case 'unreachable':
      return 'host down';
    case 'idle':
      return ctx.agentName ?? 'idle';
    case 'working':
      return `working ${secs}s`;
    case 'needs_input':
      // Orca's agent.status.changed carries no tool name, only the poll does: the same state must read the same on both paths.
      return 'needs you';
    case 'awaiting_reply':
      return 'asks you';
    case 'completed':
      return 'done';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'stopped';
  }
}
