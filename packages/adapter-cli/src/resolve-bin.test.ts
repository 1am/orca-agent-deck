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

  it('finds the per-user Windows install', async () => {
    const p = 'C:\\Users\\x\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe';
    const r = await resolveOrcaBin(
      deps({
        platform: 'win32',
        home: 'C:\\Users\\x',
        env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
        files: [p],
      }),
    );
    expect(r).toMatchObject({ bin: p, source: 'app-bundle' });
  });

  it('treats an empty LOCALAPPDATA as missing on Windows', async () => {
    const p = 'C:\\Users\\x\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe';
    const r = await resolveOrcaBin(
      deps({ platform: 'win32', home: 'C:\\Users\\x', env: { LOCALAPPDATA: '' }, files: [p] }),
    );
    expect(r).toMatchObject({ bin: p, source: 'app-bundle' });
  });

  it('ignores the POSIX fallback dirs on Windows', async () => {
    const r = await resolveOrcaBin(
      deps({ platform: 'win32', home: 'C:\\Users\\x', files: ['/usr/local/bin/orca'] }),
    );
    expect(r).toMatchObject({ bin: 'orca', source: 'path' });
  });

  describe('Windows PATH lookup', () => {
    const win = (over: Partial<ResolveDeps> & { files?: string[] }) =>
      deps({ platform: 'win32', home: 'C:\\Users\\x', cwd: 'C:\\work', ...over });

    it('resolves orca.exe on an absolute PATH entry', async () => {
      const p = 'C:\\Tools\\orca.exe';
      const r = await resolveOrcaBin(win({ env: { Path: 'C:\\Other;C:\\Tools' }, files: [p] }));
      expect(r).toMatchObject({ bin: p, source: 'path' });
    });

    it('falls back to orca.cmd', async () => {
      const p = 'C:\\Tools\\orca.cmd';
      const r = await resolveOrcaBin(win({ env: { PATH: 'C:\\Tools' }, files: [p] }));
      expect(r.bin).toBe(p);
    });

    it('skips empty, relative and cwd entries', async () => {
      const r = await resolveOrcaBin(
        win({
          env: { PATH: ';.;bin;C:\\work;c:\\WORK\\' },
          files: ['orca.exe', '.\\orca.exe', 'bin\\orca.exe', 'C:\\work\\orca.exe'],
        }),
      );
      expect(r).toMatchObject({ bin: 'orca', source: 'path' });
    });

    it('reports not found when PATH is unset or has no orca', async () => {
      expect((await resolveOrcaBin(win({}))).bin).toBe('orca');
      expect((await resolveOrcaBin(win({ env: { PATH: 'C:\\Tools' } }))).bin).toBe('orca');
    });

    it('leaves other platforms on the bare name', async () => {
      const r = await resolveOrcaBin(deps({ env: { PATH: '/x' }, files: ['/x/orca'] }));
      expect(r.bin).toBe('orca');
    });
  });
});
