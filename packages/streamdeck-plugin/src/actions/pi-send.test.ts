import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { connection } from '../../../../node_modules/@elgato/streamdeck/dist/plugin/connection.js';

const json = (file: string) =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as {
    version?: string;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

it('the SDK internals pi-send.ts uses are still there', () => {
  expect(typeof connection.send).toBe('function');
});

it('the SDK is pinned to the build those internals were checked against', () => {
  const root = json('../../../../package.json');
  const pin =
    root.dependencies?.['@elgato/streamdeck'] ?? root.devDependencies?.['@elgato/streamdeck'];
  expect(pin).toBe('3.0.4');
  expect(json('../../../../node_modules/@elgato/streamdeck/package.json').version).toBe('3.0.4');
});
