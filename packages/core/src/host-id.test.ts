import { expect, it } from 'vitest';
import { envHostId, isLocalHost, isRuntimeHostId, parseHostId, runtimeHostId } from './host-id.ts';

it('builds Orca runtime ids with an encoded environment id and ours without', () => {
  expect(runtimeHostId('E1')).toBe('runtime:E1');
  expect(runtimeHostId('env 1')).toBe('runtime:env%201');
  expect(envHostId('env 1')).toBe('env:env 1');
});

it('recognises local and runtime ids by exact prefix', () => {
  expect(isLocalHost('local')).toBe(true);
  expect(isLocalHost('local2')).toBe(false);
  expect(isLocalHost('')).toBe(false);
  expect(isRuntimeHostId('runtime:a%20b')).toBe(true);
  expect(isRuntimeHostId('env:runtime:a')).toBe(false);
  expect(isRuntimeHostId('ssh:runtime:a')).toBe(false);
});

it('parses kinds and keeps the reference byte for byte, encoded or not', () => {
  expect(parseHostId('local')).toEqual({ kind: 'local', ref: '' });
  expect(parseHostId('ssh:build%201')).toEqual({ kind: 'ssh', ref: 'build%201' });
  expect(parseHostId('runtime:env%201')).toEqual({ kind: 'runtime', ref: 'env%201' });
  expect(parseHostId('env:env 1')).toEqual({ kind: 'env', ref: 'env 1' });
  expect(parseHostId('wsl:x')).toEqual({ kind: 'unknown', ref: 'wsl:x' });
  expect(parseHostId('')).toEqual({ kind: 'unknown', ref: '' });
});
