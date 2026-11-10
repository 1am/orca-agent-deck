import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';

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
      `${env['LOCALAPPDATA'] ?? `${home}\\AppData\\Local`}\\Programs\\orca\\resources\\bin\\orca.exe`,
      `${env['ProgramFiles'] ?? 'C:\\Program Files'}\\Orca\\resources\\bin\\orca.exe`,
    ];
  }
  return [];
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

  for (const dir of FALLBACK_DIRS) {
    const p = `${dir}/orca`;
    if (deps.isExecutable(p)) return { bin: p, source: 'fallback', reason: `found in ${dir}` };
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
