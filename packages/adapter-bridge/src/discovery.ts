import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { PROTOCOL_VERSION } from './protocol.ts';

/** Port range tried by B, first free wins. */
export const PORT_RANGE = { first: 47800, last: 47809 } as const;

export const discoveryFile = z.object({
  v: z.literal(PROTOCOL_VERSION),
  port: z.number().int(),
  token: z.string().min(1),
  pid: z.number().int(),
});
export type Discovery = z.infer<typeof discoveryFile>;

export function defaultDiscoveryPath(): string {
  if (process.platform === 'win32') {
    // A worker can start without APPDATA in its environment: fall back to the same per-user folder.
    return join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'orca-deck',
      'bridge.json',
    );
  }
  return join(homedir(), '.orca-deck', 'bridge.json');
}

export async function writeDiscovery(path: string, d: Discovery): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir applies the umask and keeps the mode of an existing dir: fix it on every start
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  await writeFile(path, JSON.stringify(d), { mode: 0o600 });
  // writeFile keeps the mode of a pre-existing file
  await chmod(path, 0o600);
}

/**
 * True when `path` is a regular file (not a symlink) owned by the current user and not readable
 * by group or other. Files in the discovery dir carry the bridge token or the Orca runtime token,
 * so anything else is not trusted. On Windows, where modes and uids mean nothing, only the
 * regular-file check applies and the profile ACL does the rest.
 */
export async function isPrivateFile(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (process.platform === 'win32') return st.isFile();
    return st.isFile() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Returns null when the file is missing, malformed or not private (see isPrivateFile). */
export async function readDiscovery(path: string): Promise<Discovery | null> {
  try {
    if (!(await isPrivateFile(path))) return null;
    return discoveryFile.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export async function removeDiscovery(path: string): Promise<void> {
  await rm(path, { force: true });
}
