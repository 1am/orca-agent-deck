import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types, so it runs as a downloaded single file
import { redact } from './collect-diagnostics.mjs';

it('removes tokens, home paths and e-mail addresses', () => {
  const planted = [
    'bridge listening on 127.0.0.1:47811, token=3f9a0c1e5b7d2f4a6c8e0b1d3f5a7c9e',
    '{"authToken":"abc.def-ghi","port":1}',
    'session 4fE2kQ9xLmP0aZ8wRt5yUi3oPl7kJh6gFd2sAq1z opened',
    'log file /Users/alice/.orca-deck/plugin-a.log',
    'worktree /home/bob/src/app by bob@example.com',
  ].join('\n');
  const out = redact(planted, '/home/bob');
  expect(out).not.toMatch(/3f9a0c1e|abc\.def|4fE2kQ9x|alice|bob@example\.com/);
  expect(out).toContain('token=<redacted>');
  expect(out).toContain('"authToken":"<redacted>"');
  expect(out).toContain('/Users/<user>/.orca-deck/plugin-a.log');
  expect(out).toContain('~/src/app by <email>');
  // Ordinary log lines stay readable.
  const paneKey = '9d92e7bd-9405-48cc-9101-07d85f3b7221:3ee47c9c-41a6-46c5-910b-4b5c6fa05d79';
  expect(redact(`slot 4cc369 auto-filled with ${paneKey}`)).toContain(paneKey);
  expect(redact('press slot=a1b2c3 -> ok 42ms')).toBe('press slot=a1b2c3 -> ok 42ms');
});
