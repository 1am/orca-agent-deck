// Adds the Orca catalog release entry for HEAD to orca-catalog.json, newest first, then validates
// the catalog with Orca. Run it in the public repository after the release commit:
//   node scripts/catalog.mjs   (or: pnpm catalog)
// The entry pins HEAD's commit and content hash, so commit the catalog in a separate commit.
/* global console, process */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';

const FILE = 'orca-catalog.json';
const REPO = 'https://github.com/1am/orca-agent-deck.git';
const RELEASE_LIMIT = 32;

/** The catalog with `entry` first in the plugin's releases (a re-run for the same version replaces it). */
export function withRelease(catalog, { pluginKey, entry, sourcePath }) {
  const doc = catalog ?? { catalogVersion: 2, name: 'Orca Agent Deck', owner: '1am', plugins: [] };
  const source = {
    kind: 'git',
    url: REPO,
    ref: 'main',
    ...(sourcePath ? { path: sourcePath } : {}),
  };
  let plugin = doc.plugins.find((p) => p.id === pluginKey);
  if (!plugin) {
    plugin = {
      id: pluginKey,
      source,
      description: 'Shows Orca agent status on a Stream Deck and focuses panes from it.',
      categories: [],
      releases: [],
    };
    doc.plugins.push(plugin);
  }
  // Why drop the older releases: the source path is shared by all of them, so a release hashed under
  // another path no longer installs.
  const older =
    plugin.source.path === source.path
      ? plugin.releases.filter((r) => r.version !== entry.version)
      : [];
  plugin.source = source;
  plugin.releases = [entry, ...older].slice(0, RELEASE_LIMIT);
  return doc;
}

const isMain = process.argv[1]?.endsWith('catalog.mjs');
if (isMain) {
  const out = JSON.parse(
    execFileSync('orca', ['plugin', 'release-entry', '.', '--json'], {
      encoding: 'utf8',
    }),
  );
  if (!out.ok) throw new Error(`release-entry failed: ${JSON.stringify(out.error ?? out)}`);
  const current = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
  const json = JSON.stringify(withRelease(current, out.result), null, 2);
  // Formatted the way `pnpm lint` (prettier --check) expects, or CI fails on the catalog commit.
  const options = (await resolveConfig(FILE)) ?? {};
  writeFileSync(FILE, await format(json, { ...options, filepath: FILE }));
  execFileSync('orca', ['plugin', 'validate', FILE], { stdio: 'inherit' });
  console.log(
    `${FILE}: ${out.result.pluginKey} ${out.result.entry.version} at ${out.result.entry.commit.slice(0, 7)}`,
  );
}
