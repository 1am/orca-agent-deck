import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  hostListResponse,
  takeSchemaIssues,
  terminalListResponse,
  worktreePsResponse,
} from './schemas.ts';

const fx = (n: string): unknown => JSON.parse(readFileSync(`test/fixtures/orca/${n}`, 'utf8'));

it('parses terminal list fixture', () => {
  const r = terminalListResponse.parse(fx('terminal-list.json'));
  expect(r.result.terminals.length).toBeGreaterThan(0);
  expect(r.result.terminals[0]?.executionHostId).toBe('local');
});

it('parses worktree ps fixture', () => {
  const r = worktreePsResponse.parse(fx('worktree-ps.json'));
  expect(r.result.worktrees[0]?.agents[0]?.paneKey).toContain(':');
});

it('tolerates unknown extra fields', () => {
  const r = hostListResponse.parse({
    ok: true,
    brandNew: 1,
    result: { hosts: [{ id: 'local', kind: 'local', name: 'x', extra: true }], more: 1 },
  });
  expect(r.result.hosts).toHaveLength(1);
});

it('rejects wrong types', () => {
  expect(hostListResponse.safeParse({ ok: true, result: { hosts: [{ id: 1 }] } }).success).toBe(
    false,
  );
});

const terminalEntry = (over: Record<string, unknown> = {}) => ({
  handle: 'term_1',
  worktreeId: 'w1',
  tabId: 't1',
  leafId: 'l1',
  connected: true,
  ...over,
});
const listOf = (terminals: unknown[]) => ({ ok: true, result: { terminals } });

it('reads a plain shell terminal Orca describes with null fields (issue #6)', () => {
  const r = terminalListResponse.parse(
    listOf([
      terminalEntry({
        title: null,
        agentIdentity: null,
        lastOutputAt: null,
        executionHostId: null,
      }),
    ]),
  );
  expect(r.result.terminals[0]).toMatchObject({ title: '', executionHostId: 'local' });
});

it('normalises null for the host scope, worktree host and agents, and an interrupted flag', () => {
  const r = worktreePsResponse.parse({
    ok: true,
    result: {
      worktrees: [
        { worktreeId: 'w1', hostId: null, agents: null },
        {
          worktreeId: 'w2',
          agents: [{ paneKey: 't:l', state: 'done', stateStartedAt: 1, interrupted: null }],
        },
      ],
      hostScope: { hostIds: null, omittedHostIds: null },
    },
  });
  expect(r.result.worktrees[0]).toMatchObject({ hostId: 'local', agents: [] });
  expect(r.result.worktrees[1]?.agents[0]?.interrupted).toBe(false);
  expect(r.result.hostScope).toEqual({ hostIds: [], omittedHostIds: [] });
});

it('skips a malformed terminal and keeps the good ones, naming the issue without content', () => {
  takeSchemaIssues();
  const r = terminalListResponse.parse(
    listOf([
      terminalEntry({ handle: 'good_1' }),
      terminalEntry({ handle: 'bad_1', tabId: 5, preview: 'secret text' }),
      terminalEntry({ handle: 'good_2' }),
    ]),
  );
  expect(r.result.terminals.map((t) => t.handle)).toEqual(['good_1', 'good_2']);
  expect(takeSchemaIssues()).toEqual(['terminals[1] (bad_1): tabId invalid_type']);
  expect(takeSchemaIssues()).toEqual([]);
});

it('skips a malformed agent entry without dropping its worktree or the other agents', () => {
  takeSchemaIssues();
  const r = worktreePsResponse.parse({
    ok: true,
    result: {
      worktrees: [
        {
          worktreeId: 'w1',
          agents: [
            { paneKey: 'a:1', state: 'done', stateStartedAt: 1 },
            { paneKey: 'b:1', state: 'done', stateStartedAt: 'x', lastAssistantMessage: 'hi' },
          ],
        },
        { branch: 'no id' },
      ],
    },
  });
  expect(r.result.worktrees).toHaveLength(1);
  expect(r.result.worktrees[0]?.agents.map((a) => a.paneKey)).toEqual(['a:1']);
  expect(takeSchemaIssues()).toEqual([
    'agents[1] (b:1): stateStartedAt invalid_type',
    'worktrees[1]: worktreeId invalid_type',
  ]);
});
