import { describe, expect, it } from 'vitest';
import { CliAdapter, awaitingOf, type Exec } from './index.ts';
import type { z } from 'zod';
import type { agentEntry } from './schemas.ts';

type Entry = z.infer<typeof agentEntry>;
const entry = (o: Partial<Entry> = {}): Entry => ({
  paneKey: 't:l',
  state: 'done',
  interrupted: false,
  stateStartedAt: 1,
  ...o,
});
const Q = 'Should I also update the docs?';

describe('awaitingOf', () => {
  it('flags a finished turn that ends with a question as text', () => {
    expect(awaitingOf(entry({ lastAssistantMessage: Q }), 'done', 'success')).toBe('text');
    expect(awaitingOf(entry({ lastAssistantMessage: Q }), 'done', 'unconfirmed')).toBe('text');
    expect(awaitingOf(entry({ lastAssistantMessage: Q }), 'done', null)).toBe('text');
  });
  it('does not flag a plain summary', () => {
    expect(
      awaitingOf(entry({ lastAssistantMessage: 'All tests pass.' }), 'done', 'success'),
    ).toBeNull();
  });
  it('never flags a failed, cancelled or interrupted turn', () => {
    for (const o of ['failure', 'cancellation', 'interruption', 'superseded']) {
      expect(awaitingOf(entry({ lastAssistantMessage: Q }), 'done', o)).toBeNull();
    }
    expect(
      awaitingOf(entry({ lastAssistantMessage: Q, interrupted: true }), 'done', 'success'),
    ).toBeNull();
  });
  it('ignores a last message that is tool output', () => {
    expect(
      awaitingOf(
        entry({ lastAssistantMessage: Q, lastAssistantMessageIsToolOutput: true }),
        'done',
        'success',
      ),
    ).toBeNull();
  });
  it('does not classify while working or waiting (permission prompts stay needs_input)', () => {
    expect(
      awaitingOf(entry({ state: 'working', lastAssistantMessage: Q }), 'working', null),
    ).toBeNull();
    expect(
      awaitingOf(entry({ state: 'waiting', lastAssistantMessage: Q }), 'waiting', null),
    ).toBeNull();
  });
  it('flags a pending structured question', () => {
    const p = JSON.stringify({ questions: [{ question: 'Which?', options: [] }] });
    expect(awaitingOf(entry({ state: 'waiting', interactivePrompt: p }), 'waiting', null)).toBe(
      'question',
    );
    expect(awaitingOf(entry({ state: 'working', interactivePrompt: p }), 'working', null)).toBe(
      'question',
    );
  });
  it('treats a permission approval as a plain permission prompt, not a question', () => {
    const p = JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf x' } });
    expect(
      awaitingOf(entry({ state: 'waiting', interactivePrompt: p }), 'waiting', null),
    ).toBeNull();
  });
  it('a stale interactivePrompt on a finished turn does not count', () => {
    const p = JSON.stringify({ questions: [] });
    expect(awaitingOf(entry({ interactivePrompt: p }), 'done', 'success')).toBeNull();
  });
});

describe('snapshot carries the verdict, never the text', () => {
  it('maps lastAssistantMessage to awaiting and drops the message', async () => {
    const ps = {
      ok: true,
      result: {
        worktrees: [
          {
            worktreeId: 'w',
            agents: [
              { paneKey: 'a:1', state: 'done', stateStartedAt: 5, lastAssistantMessage: Q },
              {
                paneKey: 'a:2',
                state: 'done',
                stateStartedAt: 6,
                lastAssistantMessage: 'Finished.',
              },
            ],
          },
        ],
      },
    };
    const exec: Exec = async (args) => {
      if (args[0] === 'worktree') return JSON.stringify(ps);
      if (args[0] === 'terminal') return JSON.stringify({ ok: true, result: { terminals: [] } });
      if (args[0] === 'host') return JSON.stringify({ ok: true, result: { hosts: [] } });
      throw new Error('x');
    };
    const snap = await new CliAdapter(exec).snapshot();
    expect(snap.statuses.map((s) => [s.paneKey, s.awaiting])).toEqual([
      ['a:1', 'text'],
      ['a:2', null],
    ]);
    expect(JSON.stringify(snap)).not.toContain('Should I');
    expect(JSON.stringify(snap)).not.toContain('Finished');
  });
});
