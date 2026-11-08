// Adds the Orca catalog release entry for HEAD to orca-catalog.json, newest first, then validates
// the catalog with Orca. Run it in the public repository after the release commit:
//   node scripts/catalog.mjs   (or: pnpm catalog)
// The entry pins HEAD's commit and content hash, so commit the catalog in a separate commit.
/* global console, process */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = 'orca-catalog.json';
const REPO = 'https://github.com/1am/orca-agent-deck.git';
const RELEASE_LIMIT = 32;

/** The catalog with `entry` first in the plugin's releases (a re-run for the same version replaces it). */
export function withRelease(catalog, { pluginKey, entry, sourcePath }) {
  const doc = catalog ?? { catalogVersion: 2, name: 'Orca Agent Deck', owner: '1am', plugins: [] };
  let plugin = doc.plugins.find((p) => p.id === pluginKey);
  if (!plugin) {
    plugin = {
      id: pluginKey,
      source: { kind: 'git', url: REPO, ref: 'main', ...(sourcePath ? { path: sourcePath } : {}) },
      description: 'Shows Orca agent status on a Stream Deck and focuses panes from it.',
      categories: [],
      releases: [],
    };
    doc.plugins.push(plugin);
  }
  plugin.releases = [entry, ...plugin.releases.filter((r) => r.version !== entry.version)].slice(
    0,
    RELEASE_LIMIT,
  );
  return doc;
}

const isMain = process.argv[1]?.endsWith('catalog.mjs');
if (isMain) {
  const out = JSON.parse(
    execFileSync('orca', ['plugin', 'release-entry', 'orca-plugin', '--json'], {
      encoding: 'utf8',
    }),
  );
  if (!out.ok) throw new Error(`release-entry failed: ${JSON.stringify(out.error ?? out)}`);
  const current = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
  writeFileSync(FILE, `${JSON.stringify(withRelease(current, out.result), null, 2)}\n`);
  execFileSync('orca', ['plugin', 'validate', FILE], { stdio: 'inherit' });
  console.log(
    `${FILE}: ${out.result.pluginKey} ${out.result.entry.version} at ${out.result.entry.commit.slice(0, 7)}`,
  );
}
