import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeRuntime } from './runtime-sim.ts';
import { newState } from './sim.ts';

it('a second runtime on a taken endpoint fails its start with the reason, not the process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-'));
  // A named pipe on Windows, a socket file elsewhere: the same name twice is "in use" on both.
  const sockPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\rt-test-${process.pid}-${Date.now()}`
      : join(dir, 'rt.sock');
  const mk = (n: string) =>
    new FakeRuntime({ state: () => newState(), sockPath, metaPath: join(dir, `${n}.json`) });
  const first = mk('a');
  await first.start();
  try {
    await expect(mk('b').start()).rejects.toThrow(/cannot listen on/);
  } finally {
    await first.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
