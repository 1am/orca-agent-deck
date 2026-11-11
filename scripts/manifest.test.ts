import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (file: string) =>
  JSON.parse(readFileSync(join(root, file), 'utf8')) as {
    contributes: {
      commands: { id: string; when?: string }[];
      keybindings: { command: string; key: string; when?: string }[];
    };
  };

it('every shortcut belongs to a command the plugin contributes, once per chord', () => {
  const { commands, keybindings } = read('orca-plugin/orca-plugin.json').contributes;
  const ids = new Set(commands.map((c) => c.id));
  for (const k of keybindings) {
    expect(ids.has(k.command), k.command).toBe(true);
    // A shortcut may only restate its command's `when`.
    expect(k.when ?? commands.find((c) => c.id === k.command)?.when).toBe(
      commands.find((c) => c.id === k.command)?.when,
    );
  }
  const chords = keybindings.map((k) => k.key.toLowerCase());
  expect(new Set(chords).size).toBe(chords.length);
});

it('the repository-root manifest carries the same contributions', () => {
  expect(read('orca-plugin.json').contributes).toEqual(
    read('orca-plugin/orca-plugin.json').contributes,
  );
});
