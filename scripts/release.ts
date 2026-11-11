// Release helper. Single version source: root package.json (SemVer).
//   release.ts version <x.y.z>   set version in package.json files, the Stream Deck manifest and orca-plugin/main.mjs
//   release.ts notes             write CHANGELOG.md section + dist/RELEASE_NOTES.md from conventional commits
//   release.ts checksums         write dist/SHA256SUMS for the plugins, the Orca zip and the diagnostics script
//   release.ts validate [tag]    check both manifests agree with package.json (and the tag, in CI)
//   release.ts strip-debug       turn off the Node inspector in the Stream Deck manifest (make package, CI release)
//   release.ts root-manifest     write orca-plugin.json at the repository root (keeps the repository-root copy in sync)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const rootPkg = join(root, 'package.json');
const sdPkg = join(root, 'packages/streamdeck-plugin/package.json');
const manifest = join(
  root,
  'packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin/manifest.json',
);
const orcaManifest = join(root, 'orca-plugin/orca-plugin.json');
const orcaMain = join(root, 'orca-plugin/main.mjs');
const PLUGIN_VERSION_RE = /(export const PLUGIN_VERSION = ')[^']*(')/;
const rootOrcaManifest = join(root, 'orca-plugin.json');
const changelog = join(root, 'CHANGELOG.md');
const dist = join(root, 'dist');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

const git = (...args: string[]): string =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file: string, data: unknown): void =>
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

const currentVersion = (): string => String(readJson(rootPkg).version);

function setVersion(version: string): void {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`not a SemVer version: ${version}`);
  for (const file of [rootPkg, sdPkg, orcaManifest])
    writeJson(file, { ...readJson(file), version });
  // The version the Orca plugin reports to the Stream Deck plugin.
  const main = readFileSync(orcaMain, 'utf8');
  // Compare on the pattern, not the result: re-setting the current version changes nothing.
  if (!PLUGIN_VERSION_RE.test(main)) throw new Error(`PLUGIN_VERSION not found in ${orcaMain}`);
  writeFileSync(orcaMain, main.replace(PLUGIN_VERSION_RE, `$1${version}$2`));
  // Stream Deck manifests need four numeric parts, so a prerelease suffix is dropped.
  writeJson(manifest, { ...readJson(manifest), Version: `${m[1]}.${m[2]}.${m[3]}.0` });
  console.log(`version set to ${version} (manifest ${m[1]}.${m[2]}.${m[3]}.0)`);
}

const SECTIONS: [string, string][] = [
  ['feat', 'Added'],
  ['fix', 'Fixed'],
  ['perf', 'Changed'],
  ['refactor', 'Changed'],
];

function commitSections(): string {
  const lastTag = (() => {
    try {
      // In CI the release commit carries the tag itself: look past it.
      return git('describe', '--tags', '--abbrev=0', '--exclude', `v${currentVersion()}`);
    } catch {
      return '';
    }
  })();
  const range = lastTag ? [`${lastTag}..HEAD`] : [];
  const subjects = git('log', ...range, '--no-merges', '--pretty=%s')
    .split('\n')
    .filter(Boolean);
  const groups = new Map<string, string[]>();
  for (const subject of subjects) {
    const m = /^(\w+)(?:\(([^)]+)\))?!?: (.+)$/.exec(subject);
    if (!m) continue;
    const section = SECTIONS.find(([type]) => type === m[1])?.[1];
    if (!section) continue; // docs, chore, test, ci are not user-facing
    const line = `- ${m[2] ? `**${m[2]}:** ` : ''}${m[3]}`;
    groups.set(section, [...(groups.get(section) ?? []), line]);
  }
  return ['Added', 'Changed', 'Fixed']
    .filter((s) => groups.has(s))
    .map((s) => `### ${s}\n\n${groups.get(s)!.join('\n')}`)
    .join('\n\n');
}

/** Body of the version's CHANGELOG.md section (written by the release tooling), or null. */
function changelogSection(version: string): string | null {
  if (!existsSync(changelog)) return null;
  const text = readFileSync(changelog, 'utf8');
  const start = text.indexOf(`## [${version}]`);
  if (start < 0) return null;
  const body = text.slice(text.indexOf('\n', start) + 1);
  const end = body.indexOf('\n## ');
  return (end < 0 ? body : body.slice(0, end)).trim() || null;
}

function writeNotes(): void {
  const version = currentVersion();
  const date = new Date().toISOString().slice(0, 10);
  // A committed (maybe hand-edited) section wins over regenerating it from the commits.
  const body = changelogSection(version) ?? (commitSections() || '- No user-facing changes.');
  const section = `## [${version}] - ${date}\n\n${body}\n`;
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, 'RELEASE_NOTES.md'),
    `# Agent Deck for Orca ${version}\n\nUnofficial Stream Deck plugin for Orca. Install by double-clicking \`orca-agent-deck-${version}.streamDeckPlugin\`. Verify with \`shasum -a 256 -c SHA256SUMS\` or, with the GitHub CLI, \`gh attestation verify <file> --repo 1am/orca-agent-deck\`.\n\n${body}\n`,
  );
  const header =
    '# Changelog\n\nAll notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).\n\n';
  const existing = existsSync(changelog) ? readFileSync(changelog, 'utf8') : '';
  if (existing.includes(`## [${version}]`)) {
    console.log(`CHANGELOG.md already has ${version}, left unchanged`);
  } else {
    const rest = existing.startsWith('# Changelog')
      ? existing.slice(existing.indexOf('\n## '))
      : existing;
    writeFileSync(
      changelog,
      header + section + (rest.trim() ? '\n' + rest.replace(/^\n+/, '') : ''),
    );
    console.log(`CHANGELOG.md updated with ${version}`);
  }
  console.log('wrote dist/RELEASE_NOTES.md');
}

function writeChecksums(): void {
  const files = readdirSync(dist)
    .filter((f) => /\.(streamDeckPlugin|zip|mjs)$/.test(f))
    .sort();
  if (files.length === 0) throw new Error('no artifacts in dist/');
  const lines = files.map(
    (f) =>
      `${createHash('sha256')
        .update(readFileSync(join(dist, f)))
        .digest('hex')}  ${f}`,
  );
  writeFileSync(join(dist, 'SHA256SUMS'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

/** Release gate: one version everywhere, manifests that Orca and Stream Deck will accept. */
function validate(tag?: string): void {
  const version = currentVersion();
  const problems: string[] = [];
  const m = SEMVER.exec(version);
  if (!m) problems.push(`package.json version ${version} is not SemVer`);
  if (tag !== undefined && tag !== `v${version}`)
    problems.push(`tag ${tag} does not match package.json version ${version}`);
  if (readJson(sdPkg).version !== version)
    problems.push(`packages/streamdeck-plugin/package.json version is not ${version}`);

  const sd = readJson(manifest) as {
    Version?: string;
    Nodejs?: { Debug?: string };
    Profiles?: Array<{ Name: string }>;
  };
  if (m && sd.Version !== `${m[1]}.${m[2]}.${m[3]}.0`)
    problems.push(`Stream Deck manifest Version ${sd.Version} is not ${m[1]}.${m[2]}.${m[3]}.0`);
  for (const p of sd.Profiles ?? []) {
    if (!existsSync(join(dirname(manifest), `${p.Name}.streamDeckProfile`)))
      problems.push(`Stream Deck profile ${p.Name}.streamDeckProfile is missing`);
  }
  // The inspector opens a debugging port on the user's machine: never in a published build.
  if (tag !== undefined && sd.Nodejs?.Debug === 'enabled')
    problems.push('Stream Deck manifest has Nodejs.Debug enabled (run release.ts strip-debug)');

  const orca = readJson(orcaManifest) as {
    manifestVersion?: number;
    execution?: string;
    id?: string;
    version?: string;
    main?: string;
    engines?: { orca?: string };
  };
  if (orca.manifestVersion !== 2) problems.push('orca-plugin.json manifestVersion must be 2');
  if (orca.version !== version) problems.push(`orca-plugin.json version is not ${version}`);
  if (!readFileSync(orcaMain, 'utf8').includes(`export const PLUGIN_VERSION = '${version}'`))
    problems.push(`orca-plugin/main.mjs PLUGIN_VERSION is not ${version} (release.ts version)`);
  // Orca reserves the orca- prefix for its own plugins.
  if (!orca.id || orca.id.startsWith('orca-'))
    problems.push(`orca-plugin.json id ${orca.id} is missing or starts with orca-`);
  if (!orca.engines?.orca) problems.push('orca-plugin.json has no engines.orca range');
  if (orca.execution === 'trusted-worker') {
    if (!orca.main || !existsSync(join(root, 'orca-plugin', orca.main)))
      problems.push(`orca-plugin.json main ${orca.main} not found`);
  }
  // The root copy is written by `release.ts root-manifest`.
  if (existsSync(rootOrcaManifest) && readFileSync(rootOrcaManifest, 'utf8') !== rootManifestText())
    problems.push(
      'root orca-plugin.json does not match orca-plugin/orca-plugin.json (release.ts root-manifest)',
    );

  if (problems.length > 0) {
    for (const p of problems) console.error(`release: ${p}`);
    process.exit(1);
  }
  console.log(`release ${version}: manifests ok${tag ? `, tag ${tag} matches` : ''}`);
}

// Why a root copy: Orca's "Install from Git" reads orca-plugin.json at the repository root only, and
// has no way to name a subfolder. The copy is the plugin manifest with its file paths under orca-plugin/.
function rootManifestText(): string {
  const orca = readJson(orcaManifest) as {
    main?: string;
    icon?: string;
    cover?: { path: string };
    screenshots?: Array<{ path: string }>;
  };
  const under = (path: string): string => `orca-plugin/${path}`;
  const copy = {
    ...orca,
    ...(orca.main && { main: under(orca.main) }),
    ...(orca.icon && { icon: under(orca.icon) }),
    ...(orca.cover && { cover: { ...orca.cover, path: under(orca.cover.path) } }),
    ...(orca.screenshots && {
      screenshots: orca.screenshots.map((s) => ({ ...s, path: under(s.path) })),
    }),
  };
  return JSON.stringify(copy, null, 2) + '\n';
}

function writeRootManifest(): void {
  writeFileSync(rootOrcaManifest, rootManifestText());
  console.log('orca-plugin.json written at the repository root');
}

function stripDebug(): void {
  const sd = readJson(manifest) as { Nodejs?: Record<string, unknown> };
  if (sd.Nodejs) delete sd.Nodejs.Debug;
  writeJson(manifest, sd);
  console.log('Stream Deck manifest: Nodejs.Debug removed');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'version' && arg) setVersion(arg);
else if (cmd === 'notes') writeNotes();
else if (cmd === 'checksums') writeChecksums();
else if (cmd === 'validate') validate(arg);
else if (cmd === 'strip-debug') stripDebug();
else if (cmd === 'root-manifest') writeRootManifest();
else {
  console.error(
    'usage: release.ts version <x.y.z> | notes | checksums | validate [tag] | strip-debug | root-manifest',
  );
  process.exit(1);
}
