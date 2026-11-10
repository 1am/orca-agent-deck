import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';

export type BinSource = 'env' | 'app-bundle' | 'fallback' | 'path';

export interface ResolvedBin {
  /** Absolute path, or bare `orca` when nothing was found (last resort, relies on PATH). */
  bin: string;
  source: BinSource;
  /** Human-readable explanation for the Setup doctor. */
  reason: string;
}

export interface ResolveDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  isExecutable: (path: string) => boolean;
  /** Current directory, never searched on Windows. Defaults to `process.cwd()`. */
  cwd?: string;
}

const FALLBACK_DIRS = ['/usr/local/bin', '/opt/homebrew/bin'];

function bundleCandidates(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Orca.app/Contents/Resources/bin/orca',
      `${home}/Applications/Orca.app/Contents/Resources/bin/orca`,
    ];
  }
  if (platform === 'linux') {
    return [
      '/opt/Orca/resources/bin/orca',
      '/opt/orca/resources/bin/orca',
      '/usr/lib/orca/resources/bin/orca',
      `${home}/.local/bin/orca`,
    ];
  }
  if (platform === 'win32') {
    return [
      `${env['LOCALAPPDATA'] || `${home}\\AppData\\Local`}\\Programs\\orca\\resources\\bin\\orca.exe`,
      `${env['ProgramFiles'] || 'C:\\Program Files'}\\Orca\\resources\\bin\\orca.exe`,
    ];
  }
  return [];
}

/**
 * Windows: a bare `orca` makes libuv search the current directory and every PATH entry, including
 * writable and relative ones. Scan PATH ourselves and accept absolute entries only, never the cwd.
 */
function findOnWindowsPath(deps: ResolveDeps): string | undefined {
  const pathKey = Object.keys(deps.env).find((k) => k.toLowerCase() === 'path');
  const cwd = win32.resolve(deps.cwd ?? process.cwd()).toLowerCase();
  for (const raw of (pathKey ? deps.env[pathKey] : undefined)?.split(';') ?? []) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !win32.isAbsolute(dir) || win32.resolve(dir).toLowerCase() === cwd) continue;
    for (const name of ['orca.exe', 'orca.cmd']) {
      const p = win32.join(dir, name);
      if (deps.isExecutable(p)) return p;
    }
  }
  return undefined;
}

/** Resolution order: ORCA_BIN > app bundle > well-known bin dirs > bare `orca`.
 * No login shell: sourcing the user's rc files can touch ~/Documents, ~/Desktop or iCloud and raise a
 * macOS Files and Folders prompt attributed to the Stream Deck app. */
export async function resolveOrcaBin(deps: ResolveDeps): Promise<ResolvedBin> {
  const fromEnv = deps.env['ORCA_BIN'];
  if (fromEnv) return { bin: fromEnv, source: 'env', reason: `ORCA_BIN=${fromEnv}` };

  for (const p of bundleCandidates(deps.platform, deps.home, deps.env)) {
    if (deps.isExecutable(p))
      return { bin: p, source: 'app-bundle', reason: `Orca app bundle at ${p}` };
  }

  // On Windows these resolve to `C:\usr\local\bin`, a folder any local account can create.
  for (const dir of deps.platform === 'win32' ? [] : FALLBACK_DIRS) {
    const p = `${dir}/orca`;
    if (deps.isExecutable(p)) return { bin: p, source: 'fallback', reason: `found in ${dir}` };
  }

  if (deps.platform === 'win32') {
    const p = findOnWindowsPath(deps);
    if (p) return { bin: p, source: 'path', reason: `found on PATH at ${p}` };
    return { bin: 'orca', source: 'path', reason: 'orca not found on PATH' };
  }

  return { bin: 'orca', source: 'path', reason: 'orca not found; falling back to PATH lookup' };
}

function realIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let cached: Promise<ResolvedBin> | undefined;

/** Cached resolution against the real environment. */
export function resolveOrcaBinCached(): Promise<ResolvedBin> {
  cached ??= resolveOrcaBin({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    isExecutable: realIsExecutable,
  });
  return cached;
}
