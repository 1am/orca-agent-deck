// `pnpm replay-b [file ...]`: plays the side-`b` scenarios of test/replay into the built plugin B (bin/plugin.js)
// through a fake Stream Deck host, once per host profile that can run on this OS. No Orca needed. Build first.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadScenario } from '../packages/fake-orca/src/index.ts';
import { changedRealState, snapshotRealState } from './replay-guard.ts';
import { PROFILES } from '../test/replay-b/profiles.ts';
import { canRun, missingHost, runB } from '../test/replay-b/run-b.ts';

const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'test/replay');
const args = process.argv.slice(2);
const nodeAt = args.indexOf('--node');
if (nodeAt >= 0) process.env['REPLAY_NODE'] = args[nodeAt + 1];
const only = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined;
const targets = args.filter(
  (a, i) => !a.startsWith('--') && args[i - 1] !== '--profile' && args[i - 1] !== '--node',
);
const files = targets.length
  ? targets
  : readdirSync(dir)
      .filter((f) => f.endsWith('.ndjson'))
      .sort()
      .map((f) => join(dir, f));
if (
  !existsSync(
    join(root, 'packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin/bin/plugin.js'),
  )
) {
  console.error('replay-b needs the built plugin: run pnpm sd:build first');
  process.exit(2);
}
const before = snapshotRealState();
const t0 = Date.now();
const jobs: {
  name: string;
  profile: string;
  skip: string | null;
  run: () => Promise<{ orcaCalls: number }>;
}[] = [];
const names: string[] = [];
for (const file of files) {
  const sc = loadScenario(file);
  if (!sc.header.sides.includes('b')) continue;
  names.push(sc.header.name);
  for (const p of Object.values(PROFILES).filter((x) => !only || x.id === only))
    jobs.push({
      name: sc.header.name,
      profile: p.id,
      skip: canRun(p) ?? missingHost(sc, p),
      run: () => runB(sc, p.id),
    });
}

const results = new Map<string, string>();
const failures: string[] = [];
const todo = jobs.filter((j) => !j.skip);
const pool = Number(process.env['REPLAY_JOBS']) || 6;
const workers = Array.from({ length: Math.min(pool, todo.length) }, async () => {
  for (let j = todo.shift(); j; j = todo.shift()) {
    const t = Date.now();
    try {
      const { orcaCalls } = await j.run();
      results.set(
        `${j.name}/${j.profile}`,
        `ok ${((Date.now() - t) / 1000).toFixed(1)}s${orcaCalls ? ` (${orcaCalls} orca)` : ''}`,
      );
    } catch (e) {
      results.set(`${j.name}/${j.profile}`, 'FAIL');
      failures.push(`FAIL ${j.name} on ${j.profile}\n${(e as Error).message}`);
    }
  }
});
await Promise.all(workers);

const profiles = Object.keys(PROFILES);
const w = Math.max(...names.map((n) => n.length), 8);
console.log(`${''.padEnd(w)}  ${profiles.map((p) => p.padEnd(22)).join('')}`);
for (const n of names)
  console.log(
    `${n.padEnd(w)}  ${profiles
      .map((p) =>
        (() => {
          const skip = jobs.find((j) => j.name === n && j.profile === p)?.skip;
          // A profile of another OS is a dash; a scenario that needs a host this OS lacks says which.
          return skip
            ? skip.startsWith('needs ')
              ? '-'
              : `skip: ${skip}`
            : (results.get(`${n}/${p}`) ?? '?');
        })().padEnd(22),
      )
      .join('')}`,
  );
console.log(`\n${failures.join('\n\n')}${failures.length ? '\n' : ''}`);
const afterState = snapshotRealState();
const problems = changedRealState(before, afterState);
if (problems.length) {
  console.log(`FAIL ${problems.join('\n')}`);
  process.exit(1);
}
const skipped = [
  ...new Set(jobs.filter((j) => j.skip?.startsWith('needs ')).map((j) => j.profile)),
];
const scenarioSkips = jobs.filter((j) => j.skip && !j.skip.startsWith('needs '));
console.log(
  `${jobs.filter((j) => !j.skip).length - failures.length} passed, ${failures.length} failed in ${((Date.now() - t0) / 1000).toFixed(1)} s; profiles skipped here: ${skipped.join(', ') || 'none'}`,
);
for (const j of scenarioSkips) console.log(`skipped ${j.name} on ${j.profile}: ${j.skip}`);
if (afterState.note) console.log(`note: ${afterState.note}`);
process.exit(failures.length ? 1 : 0);
