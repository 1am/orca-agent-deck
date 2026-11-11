#!/usr/bin/env node
// Shim mimicking the real `orca` CLI JSON output. State lives in $FAKE_ORCA_STATE (JSON file).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as r from './render.ts';
import { focus, newState, type SimState } from './sim.ts';
import { loadScenario } from './replay/load.ts';
import { play } from './replay/play.ts';

const file = process.env.FAKE_ORCA_STATE ?? join(tmpdir(), 'fake-orca-state.json');
const args = process.argv.slice(2);
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function load(): SimState {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SimState) : newState();
}

const [a, b] = args;
try {
  if (a === 'scenario') {
    // `scenario <name>` plays test/replay/<name>.ndjson; the path is relative to this file.
    const dir = new URL('../../../test/replay/', import.meta.url);
    const s = play(loadScenario(fileURLToPath(new URL(`${b ?? ''}.ndjson`, dir))));
    writeFileSync(file, JSON.stringify(s));
    console.log(s.log.join('\n'));
  } else if (a === 'terminal' && b === 'list') out(r.terminalList(load()));
  else if (a === 'terminal' && b === 'switch') {
    const s = load();
    const i = args.indexOf('--terminal');
    focus(s, args[i + 1] ?? '');
    writeFileSync(file, JSON.stringify(s));
    out({ id: 'fake', ok: true, result: { focus: { navigated: true } } });
  } else if (a === 'worktree' && b === 'ps') out(r.worktreePs(load()));
  else if (a === 'host' && b === 'list') out(r.hostList(load()));
  else if (a === 'plugin' && b === 'list') {
    const plugins = load().plugins;
    if (!plugins) throw new Error('plugin list is not answered by this simulation');
    out({ id: 'fake', ok: true, result: { plugins } });
  } else if (a === 'status') out(r.status(load()));
  else throw new Error(`unsupported command: ${args.join(' ')}`);
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: { message: (e as Error).message } }));
  process.exit(1);
}
