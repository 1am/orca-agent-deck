// `pnpm replay-e2e`: plays the `e2e` scenarios of test/replay through both shipped plugins at once: the real plugin A
// on Orca's `orca/testing` mountWorker, the built plugin B behind the fake Stream Deck host, joined by the real bridge.
// Build B first (`pnpm sd:build`, `make replay-e2e` does). Same staging as replay-a; local only (Orca >= 1.4.251).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { changedRealState, snapshotRealState } from './replay-guard.ts';
import { loadScenario } from '../packages/fake-orca/src/index.ts';

const MIN_ORCA = [1, 4, 251];
const root = resolve(import.meta.dirname, '..');

let version: string;
try {
  version = execFileSync('orca', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  console.error('replay-e2e needs the `orca` CLI (Orca >= 1.4.251) on PATH; it is local-only');
  process.exit(2);
}
const have = version.split('.').map(Number);
const older = MIN_ORCA.map((n, i) => (have[i] ?? 0) - n).find((d) => d !== 0) ?? 0;
if (older < 0) {
  console.error(`replay-e2e needs Orca >= ${MIN_ORCA.join('.')} (orca/testing), found ${version}`);
  process.exit(2);
}

const stage = mkdtempSync(join(tmpdir(), 'replay-e2e-stage-'));
mkdirSync(join(stage, 'scenarios'));
for (const f of ['main.mjs', 'orca-plugin.json'])
  copyFileSync(join(root, 'orca-plugin', f), join(stage, f));
let count = 0;
for (const f of readdirSync(join(root, 'test/replay')).filter((n) => n.endsWith('.ndjson'))) {
  const file = join(root, 'test/replay', f);
  if (!loadScenario(file).header.sides.includes('e2e')) continue;
  copyFileSync(file, join(stage, 'scenarios', f));
  count++;
}
if (!count) {
  console.log('no scenario targets side e2e');
  process.exit(0);
}

await build({
  entryPoints: [join(root, 'test/replay-e2e/entry.test.ts')],
  outfile: join(stage, 'e2e.test.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['orca/testing', './main.mjs'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
});

const before = snapshotRealState();
// The suite sets its own HOME per scenario; this one keeps a slip (a path fixed at import time) off the real home too.
const home = join(stage, 'home');
mkdirSync(home);
const r = spawnSync('orca', ['plugin', 'test', stage], {
  stdio: 'inherit',
  env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, REPLAY_REPO: root },
});
const afterState = snapshotRealState();
const problems = changedRealState(before, afterState);
if (afterState.note) console.log(`note: ${afterState.note}`);
if (problems.length) {
  console.error(`FAIL ${problems.join('\n')}`);
  process.exit(1);
}
if (r.status === 0) rmSync(stage, { recursive: true, force: true });
else console.error(`kept ${stage}`);
process.exit(r.status ?? 1);
