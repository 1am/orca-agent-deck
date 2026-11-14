import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseScenario } from '@orca-agent-deck/fake-orca';
import { runA, type Env } from './run-a.ts';

// Bundled into the staged plugin folder by scripts/replay-a.ts, next to the real main.mjs and
// orca-plugin.json. `orca/testing` only exists inside `orca plugin test`, so it is imported by name at runtime.
const testing = 'orca/testing';
const main = './main.mjs';
const { mountWorker } = await import(testing);
const plugin = await import(main);
const here = new URL('.', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('orca-plugin.json', here), 'utf8'));
const dir = new URL('scenarios/', here);

for (const file of readdirSync(dir).sort()) {
  const sc = parseScenario(readFileSync(new URL(file, dir), 'utf8'), file);
  test(sc.header.name, () => runA(sc, { mountWorker, plugin, manifest } as Env));
}
