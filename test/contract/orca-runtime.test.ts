// Runs against a real Orca. Skipped unless ORCA_CONTRACT=1. Checks the runtime socket method names
// and frame shapes the adapter relies on, and that it agrees with the CLI.
import { describe, expect, it } from 'vitest';
import { CliAdapter } from '../../packages/adapter-cli/src/index.ts';
import { RuntimeClient, createRuntimeAdapter } from '../../packages/adapter-runtime/src/index.ts';

describe.skipIf(process.env['ORCA_CONTRACT'] !== '1')('orca runtime socket contract', () => {
  const c = new RuntimeClient();
  it('status.get reports a ready graph and a version', async () => {
    const s = await c.call<{ graphStatus: string; appVersion: string }>('status.get');
    expect(s.graphStatus).toBe('ready');
    expect(s.appVersion).toMatch(/^\d+\.\d+/);
  });
  it('terminal.list, worktree.ps and ssh.listTargets answer with the expected keys', async () => {
    expect(await c.call('terminal.list')).toHaveProperty('terminals');
    expect(await c.call('worktree.ps')).toHaveProperty('worktrees');
    expect(await c.call('ssh.listTargets')).toHaveProperty('targets');
  });
  it('terminal.focus without a handle is an invalid_argument error, not a crash', async () => {
    await expect(c.call('terminal.focus')).rejects.toMatchObject({ code: 'invalid_argument' });
  });
  it('worktree.set accepts { worktree: "id:<id>", isUnread } (written back with the current value: no change)', async () => {
    const { worktrees } = await c.call<{ worktrees: Array<{ id: string; isUnread: boolean }> }>(
      'worktree.list',
    );
    const w = worktrees[0];
    expect(w).toBeDefined();
    await c.call('worktree.set', { worktree: `id:${w!.id}`, isUnread: w!.isUnread });
    const after = await c.call<{ worktrees: Array<{ id: string; isUnread: boolean }> }>(
      'worktree.list',
    );
    expect(after.worktrees.find((x) => x.id === w!.id)?.isUnread).toBe(w!.isUnread);
  });
  it('worktree.ps agents carry the fields the awaiting-reply classifier reads', async () => {
    const ps = await c.call<{ worktrees: Array<{ agents: Array<Record<string, unknown>> }> }>(
      'worktree.ps',
    );
    const agents = ps.worktrees.flatMap((w) => w.agents);
    if (agents.length === 0) return;
    expect(agents.some((a) => 'lastAssistantMessage' in a || 'prompt' in a)).toBe(true);
  });
  it('streaming methods are still refused on the socket (we must keep polling)', async () => {
    await expect(c.call('agentSession.subscribeStatus')).rejects.toMatchObject({
      code: 'method_not_supported',
    });
  });
  it('the runtime adapter sees the same panes as the CLI adapter (local ones)', async () => {
    const viaSocket = await createRuntimeAdapter({
      fallback: async () => {
        throw new Error('no CLI for local data');
      },
    }).snapshot();
    const viaCli = await new CliAdapter().snapshot();
    const local = (x: { panes: { paneKey: string; hostId: string }[] }) =>
      x.panes
        .filter((p) => p.hostId === 'local')
        .map((p) => p.paneKey)
        .sort();
    expect(local(viaSocket)).toEqual(local(viaCli));
  });
});
