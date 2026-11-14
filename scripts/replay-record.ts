// Turns a sanitized event log into a replay scenario: `pnpm replay:record <log.ndjson> --name <scenario> [--sides a,b] > out.ndjson`.
// Prints what it removed (field paths, never values) on stderr. See docs/replay.md.
import { readFileSync } from 'node:fs';
import { recordScenario, type Side } from '../packages/fake-orca/src/index.ts';

const args = process.argv.slice(2);
const flag = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const name = flag('--name');
if (!file || !name) {
  console.error('usage: replay:record <event-log.ndjson> --name <scenario-name> [--sides a,b]');
  process.exit(2);
}
try {
  const sides = flag('--sides')?.split(',') as Side[] | undefined;
  const r = recordScenario(readFileSync(file, 'utf8'), { name, ...(sides ? { sides } : {}) });
  process.stdout.write(r.text);
  console.error(`removed ${r.removed.length}:\n${r.removed.map((x) => `  ${x}`).join('\n')}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
