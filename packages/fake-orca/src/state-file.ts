import { renameSync, writeFileSync } from 'node:fs';

/**
 * Writes the simulation state so a reader (the CLI shim, spawned by the plugin at any moment) sees
 * the old file or the new one, never a half-written or interleaved one: a plain `writeFileSync`
 * truncates first, and two writers leave the longer one's tail behind.
 */
export function writeStateFile(file: string, state: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}
