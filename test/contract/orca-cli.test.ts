// Runs against a real Orca. Skipped unless ORCA_CONTRACT=1. Run after every Orca update.
import { describe, expect, it } from 'vitest';
import { CliAdapter } from '../../packages/adapter-cli/src/index.ts';

describe.skipIf(process.env['ORCA_CONTRACT'] !== '1')('orca CLI contract', () => {
  const a = new CliAdapter();
  it('status is healthy and supported', async () => {
    const h = await a.health();
    expect(h.orcaRunning).toBe(true);
    expect(h.unsupported).toBe(false);
  });
  it('terminal list + worktree ps match our schemas', async () => {
    const s = await a.snapshot();
    for (const p of s.panes) expect(p.paneKey).toMatch(/^[^:]+:[^:]+$/);
  });
  it('host list has the local host', async () => {
    expect((await a.listHosts()).some((h) => h.kind === 'local')).toBe(true);
  });
});
