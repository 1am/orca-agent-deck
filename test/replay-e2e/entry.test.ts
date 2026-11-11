import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseScenario } from '@orca-agent-deck/fake-orca';
import { PROFILES } from '../replay-b/profiles.ts';
import { canRun, runB, type PluginA } from '../replay-b/run-b.ts';

// Bundled into the staged plugin folder by scripts/replay-e2e.ts, next to the real main.mjs and orca-plugin.json.
// The real plugin A runs on Orca's `mountWorker` (only inside `orca plugin test`, hence the import by name), the real
// plugin B build runs behind the fake Stream Deck host, and they talk over the real bridge.
const testing = 'orca/testing';
const main = './main.mjs';
const { mountWorker } = await import(testing);
const plugin = await import(main);
const here = new URL('.', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('orca-plugin.json', here), 'utf8'));
const dir = new URL('scenarios/', here);
// One profile: plugin A has no stop handle, so a worker of an earlier test would still look for the next test's B.
const profile = Object.values(PROFILES).find((p) => canRun(p) === null)!;

function pluginA(): PluginA {
  let worker: {
    emit(e: string, p: unknown): Promise<void>;
    request(name: string, input?: unknown): Promise<unknown>;
    deactivate(): Promise<void>;
  } | null = null;
  const saved = { HOME: process.env['HOME'], APPDATA: process.env['APPDATA'] };
  return {
    async mount(home) {
      // A reads the bridge discovery file under $HOME on every connect.
      process.env['HOME'] = home;
      process.env['USERPROFILE'] = home;
      process.env['APPDATA'] = `${home}/AppData`;
      worker = await mountWorker(plugin, {
        events: manifest.contributes.events.map((e: { on: string }) => e.on),
        hooks: [],
        commands: manifest.contributes.commands.map((c: { id: string }) => c.id),
      });
    },
    emit: (name, payload) => worker!.emit(name, payload),
    request: (name, input) => worker!.request(name, input),
    async stop() {
      await worker?.deactivate();
      worker = null;
      if (saved.HOME === undefined) delete process.env['HOME'];
      else process.env['HOME'] = saved.HOME;
      if (saved.APPDATA === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = saved.APPDATA;
    },
  };
}

for (const file of readdirSync(dir).sort()) {
  const sc = parseScenario(readFileSync(new URL(file, dir), 'utf8'), file);
  test(`${sc.header.name} (${profile.id})`, async () => {
    await runB(sc, profile.id, pluginA());
  });
}
