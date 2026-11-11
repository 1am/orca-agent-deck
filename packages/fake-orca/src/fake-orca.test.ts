import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  loadScenario,
  play,
  terminalList,
  worktreePs,
  restart,
  newState,
  addPane,
} from './index.ts';

const terminalSchema = z.object({
  handle: z.string(),
  worktreeId: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  tabId: z.string(),
  leafId: z.string(),
  title: z.string(),
  paneTitle: z.string().nullable(),
  agentIdentity: z.string().nullable(),
  connected: z.boolean(),
  exitCause: z.string().nullable(),
  executionHostId: z.string(),
  verdict: z.string().nullable(),
  lastOutputAt: z.number(),
  preview: z.string(),
  hostScope: z.string(),
});

it('terminal list matches the expected field schema', () => {
  const s = runScenario('permission-approve-success');
  const parsed = z.array(terminalSchema).parse(terminalList(s).result.terminals);
  expect(parsed).toHaveLength(2);
});

it('worktree ps reports the final agent state', () => {
  const s = runScenario('permission-approve-success');
  expect(worktreePs(s).result.worktrees[0]?.agents[0]?.state).toBe('done');
});

it('restart rotates handles', () => {
  const s = newState();
  addPane(s, 'a');
  const before = s.panes[0]?.handle;
  restart(s);
  expect(s.panes[0]?.handle).not.toBe(before);
});

const SCENARIOS = new URL('../../../test/replay/', import.meta.url).pathname;
const runScenario = (name: string) => play(loadScenario(`${SCENARIOS}${name}.ndjson`));

it.each(readdirSync(SCENARIOS).filter((f) => f.endsWith('.ndjson')))(
  'scenario %s is deterministic',
  (file) => {
    const name = file.replace('.ndjson', '');
    expect(runScenario(name).log).toEqual(runScenario(name).log);
  },
);

it('permission-approve-success log snapshot', () => {
  expect(runScenario('permission-approve-success').log).toMatchInlineSnapshot(`
    [
      "t+0ms addPane a",
      "t+0ms addPane b",
      "t+1000ms agent a working",
      "t+3000ms agent a working/Bash",
      "t+6000ms agent a waiting/Bash",
      "t+11000ms agent a working/Bash",
      "t+15000ms agent a done/Bash",
    ]
  `);
});

it('CLI shim records focus in the state log', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'fo-')), 's.json');
  const run = (...a: string[]) =>
    execFileSync('node', ['--experimental-strip-types', 'src/bin.ts', ...a], {
      env: { ...process.env, FAKE_ORCA_STATE: state },
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
    });
  run('scenario', 'multi-agent-day');
  const list = JSON.parse(run('terminal', 'list', '--json'));
  const handle = list.result.terminals[1].handle as string;
  run('terminal', 'switch', '--terminal', handle, '--json');
  expect(JSON.parse(readFileSync(state, 'utf8')).log.at(-1)).toMatch(/focus b$/);
});
