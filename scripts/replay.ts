// Replay runner: `pnpm replay [file|dir ...] [--update] [--side sim]`. See docs/replay.md.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  diffTimeline,
  loadScenario,
  replaySim,
  type Side,
} from '../packages/fake-orca/src/index.ts';

const args = process.argv.slice(2);
const update = args.includes('--update');
const sideAt = args.indexOf('--side');
const side = (sideAt >= 0 ? args[sideAt + 1] : 'sim') as Side;
const targets = args.filter((a, i) => !a.startsWith('--') && (sideAt < 0 || i !== sideAt + 1));
if (side !== 'sim') {
  console.error(
    `--side ${side}: only the sim runner is here; plugin A scenarios run with make replay-a (#176), plugin B with #177`,
  );
  process.exit(2);
}

const root = resolve(import.meta.dirname, '../test/replay');
const files = (targets.length ? targets : [root]).flatMap((t) =>
  statSync(t).isDirectory()
    ? readdirSync(t)
        .filter((f) => f.endsWith('.ndjson'))
        .sort()
        .map((f) => join(t, f))
    : [t],
);

let passed = 0;
let failed = 0;
const skipped: string[] = [];
for (const file of files) {
  const sc = loadScenario(file);
  const name = sc.header.name;
  if (!sc.header.sides.includes(side)) {
    skipped.push(name);
    continue;
  }
  const snap = join(dirname(file), '__snapshots__', `${basename(file, '.ndjson')}.timeline.txt`);
  const r = await replaySim(sc);
  const problems = [...r.failures.map((f) => `  expect: ${f}`)];
  if (update) {
    mkdirSync(dirname(snap), { recursive: true });
    writeFileSync(snap, `${r.timeline.join('\n')}\n`);
  } else if (!existsSync(snap)) problems.push(`  no snapshot ${snap}; run with --update`);
  else {
    const want = readFileSync(snap, 'utf8').trimEnd().split('\n');
    problems.push(...diffTimeline(want, r.timeline));
  }
  if (problems.length) {
    failed++;
    console.log(`FAIL ${name}\n${problems.join('\n')}`);
  } else {
    passed++;
    console.log(`ok   ${name}${update ? ' (snapshot updated)' : ''}`);
  }
}
console.log(
  `${passed} passed, ${failed} failed, ${skipped.length} skipped (not targeting ${side}${skipped.length ? `: ${skipped.join(', ')}` : ''})`,
);
process.exit(failed ? 1 : 0);
