// Shared by the replay runners: a run must leave the real working tree and the real Agent Deck for Orca data dir
// (`~/.orca-deck`, `%APPDATA%\orca-deck`) as it found them. Plugin A once wrote its log there from a test.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deckDataDir } from '../packages/adapter-bridge/src/index.ts';

const root = resolve(import.meta.dirname, '..');

/** The pid in the real `bridge.json`, when that process is alive: a running Agent Deck for Orca owns the dir. */
function liveOwner(dir: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(join(dir, 'bridge.json'), 'utf8')) as { pid?: unknown })
      .pid;
    if (typeof pid !== 'number') return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** The names, sizes and modification times in the real data dir, and `git status`. */
export function snapshotRealState(): { dataDir: string; git: string | null; note?: string } {
  const dir = deckDataDir();
  // A live plugin B (and its Orca plugin A) writes to this dir by itself: it cannot be told from a test leak.
  const owner = liveOwner(dir);
  if (owner !== null)
    return {
      dataDir: dir,
      git: gitStatus(),
      note: `real data dir not compared: in use by a running Agent Deck for Orca (pid ${owner}); every child ran with its own HOME`,
    };
  const files = existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((f) => {
          const st = statSync(join(dir, f));
          return `${f} ${st.size} ${st.mtimeMs}`;
        })
        .join('\n')
    : '(absent)';
  return { dataDir: `${dir}\n${files}`, git: gitStatus() };
}

function gitStatus(): string | null {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  } catch {
    return null; // not a git checkout
  }
}

/** Problems between two snapshots, empty when the run left everything alone. */
export function changedRealState(
  before: ReturnType<typeof snapshotRealState>,
  after: ReturnType<typeof snapshotRealState>,
): string[] {
  const out: string[] = [];
  if (before.git !== null && after.git !== before.git)
    out.push(`the run changed the working tree:\n${after.git}`);
  if (before.dataDir !== after.dataDir)
    out.push(
      `the run changed the real Agent Deck for Orca data dir (or a running Agent Deck for Orca wrote to it meanwhile):\n--- before\n${before.dataDir}\n--- after\n${after.dataDir}`,
    );
  return out;
}
