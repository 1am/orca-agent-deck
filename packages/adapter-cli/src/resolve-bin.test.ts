import { describe, expect, it } from 'vitest';
import { resolveOrcaBin, type ResolveDeps } from './resolve-bin.ts';

function deps(over: Partial<ResolveDeps> & { files?: string[] } = {}): ResolveDeps {
  const files = new Set(over.files ?? []);
  return {
    env: {},
    platform: 'darwin',
    home: '/Users/x',
    isExecutable: (p) => files.has(p),
    ...over,
  };
}

describe('resolveOrcaBin', () => {
  it('prefers ORCA_BIN', async () => {
    const r = await resolveOrcaBin(
      deps({
        env: { ORCA_BIN: '/x/orca' },
        files: ['/Applications/Orca.app/Contents/Resources/bin/orca'],
      }),
    );
    expect(r).toMatchObject({ bin: '/x/orca', source: 'env' });
  });

  it('finds the macOS app bundle', async () => {
    const p = '/Applications/Orca.app/Contents/Resources/bin/orca';
    expect(await resolveOrcaBin(deps({ files: [p] }))).toMatchObject({
      bin: p,
      source: 'app-bundle',
    });
  });

  it('finds the per-user app bundle', async () => {
    const p = '/Users/x/Applications/Orca.app/Contents/Resources/bin/orca';
    expect(await resolveOrcaBin(deps({ files: [p] }))).toMatchObject({
      bin: p,
      source: 'app-bundle',
    });
  });

  it('falls back to well-known dirs', async () => {
    const r = await resolveOrcaBin(deps({ files: ['/opt/homebrew/bin/orca'] }));
    expect(r).toMatchObject({ bin: '/opt/homebrew/bin/orca', source: 'fallback' });
  });

  it('returns bare orca when nothing found', async () => {
    expect(await resolveOrcaBin(deps())).toMatchObject({ bin: 'orca', source: 'path' });
  });

  it('uses linux candidates on linux', async () => {
    const r = await resolveOrcaBin(
      deps({ platform: 'linux', files: ['/opt/Orca/resources/bin/orca'] }),
    );
    expect(r.source).toBe('app-bundle');
  });
});
