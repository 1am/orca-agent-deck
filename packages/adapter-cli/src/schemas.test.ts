import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { hostListResponse, terminalListResponse, worktreePsResponse } from './schemas.ts';

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
