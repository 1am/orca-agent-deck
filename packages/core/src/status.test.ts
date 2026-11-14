import { describe, expect, it } from 'vitest';
import {
  deriveDeckState,
  lineTwo,
  type AgentRawState,
  type DeckState,
  type PaneObservation,
} from './status.ts';

const base: PaneObservation = {
  mapped: true,
  orcaRunning: true,
  found: true,
  connected: true,
  hostDown: false,
  agentType: 'claude',
  agent: null,
};
const withAgent = (state: AgentRawState, outcome?: string): PaneObservation => ({
  ...base,
  agent: { state, outcome: outcome ?? null },
});

const rows: [string, PaneObservation, DeckState][] = [
  ['no pane mapped', { ...base, mapped: false }, 'unmapped'],
  ['orca not running', { ...base, orcaRunning: false }, 'offline'],
  ['pane not found', { ...base, found: false }, 'offline'],
  ['terminal disconnected', { ...base, connected: false }, 'offline'],
  ['no agent activity', base, 'idle'],
  ['agent idle', withAgent('idle'), 'idle'],
  ['working', withAgent('working'), 'working'],
  ['waiting', withAgent('waiting'), 'needs_input'],
  ['blocked', withAgent('blocked'), 'needs_input'],
  ['done success', withAgent('done', 'success'), 'completed'],
  ['done unconfirmed', withAgent('done', 'unconfirmed'), 'completed'],
  ['done no outcome', withAgent('done'), 'completed'],
  ['done failure', withAgent('done', 'failure'), 'error'],
  ['done cancellation', withAgent('done', 'cancellation'), 'cancelled'],
  ['done interruption', withAgent('done', 'interruption'), 'cancelled'],
  ['done superseded', withAgent('done', 'superseded'), 'cancelled'],
  ['exit crash', { ...withAgent('working'), exitCause: 'crash' }, 'error'],
  ['exit non-zero', { ...base, exitCause: 'nonzero' }, 'error'],
  ['crash, pane disconnected', { ...base, connected: false, exitCause: 'crash' }, 'error'],
  ['clean exit, pane disconnected', { ...base, connected: false, exitCause: 'clean' }, 'offline'],
  ['exit clean', { ...base, exitCause: 'clean' }, 'idle'],
];

describe('deriveDeckState', () => {
  it.each(rows)('%s -> %s', (_n, obs, expected) => {
    expect(deriveDeckState(obs).state).toBe(expected);
  });

  it('keeps the last known state when the host is down', () => {
    const r = deriveDeckState({ ...withAgent('working'), hostDown: true }, 'working');
    expect(r).toEqual({ state: 'unreachable', stale: true, lastKnown: 'working' });
  });

  it('unmapped wins over host down', () => {
    expect(deriveDeckState({ ...base, mapped: false, hostDown: true }).state).toBe('unmapped');
  });
});

describe('awaiting_reply', () => {
  const obs = (agent: PaneObservation['agent']): PaneObservation => ({
    mapped: true,
    orcaRunning: true,
    found: true,
    connected: true,
    hostDown: false,
    agentType: 'claude',
    agent,
  });
  it('a successful turn that ended with a question asks you', () => {
    expect(
      deriveDeckState(obs({ state: 'done', outcome: 'success', awaiting: 'text' })).state,
    ).toBe('awaiting_reply');
    expect(deriveDeckState(obs({ state: 'done', outcome: null, awaiting: 'text' })).state).toBe(
      'awaiting_reply',
    );
  });
  it('a plain done stays completed', () => {
    expect(deriveDeckState(obs({ state: 'done', outcome: 'success', awaiting: null })).state).toBe(
      'completed',
    );
    expect(deriveDeckState(obs({ state: 'done', outcome: 'success' })).state).toBe('completed');
  });
  it('failure and stop win over a question', () => {
    expect(
      deriveDeckState(obs({ state: 'done', outcome: 'failure', awaiting: 'text' })).state,
    ).toBe('error');
    expect(
      deriveDeckState(obs({ state: 'done', outcome: 'cancellation', awaiting: 'text' })).state,
    ).toBe('cancelled');
  });
  it('a pending structured question asks you, whether Orca says waiting or working', () => {
    expect(deriveDeckState(obs({ state: 'waiting', awaiting: 'question' })).state).toBe(
      'awaiting_reply',
    );
    expect(deriveDeckState(obs({ state: 'working', awaiting: 'question' })).state).toBe(
      'awaiting_reply',
    );
  });
  it('a permission prompt stays needs_input', () => {
    expect(deriveDeckState(obs({ state: 'waiting', awaiting: null })).state).toBe('needs_input');
  });
  it('needs_input reads "needs you" whatever the path knows about the tool', () => {
    // Orca's pushed status has no tool name and the poll has: the label must not depend on it.
    expect(lineTwo('needs_input')).toBe('needs you');
    expect(lineTwo('needs_input', { elapsedMs: 5000, agentName: 'claude' })).toBe('needs you');
  });
  it('shows the label "asks you"', () => {
    expect(lineTwo('awaiting_reply')).toBe('asks you');
  });
});
