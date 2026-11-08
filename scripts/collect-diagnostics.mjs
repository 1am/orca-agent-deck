// Writes orca-deck-diagnostics-<time>.txt for a bug report: versions, setup facts and the last log
// lines of both plugins. Tokens, home paths and e-mail addresses are removed. Plain Node, no
// dependencies, so it also runs as a downloaded single file: `node collect-diagnostics.mjs`.
/* global process, console */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LINES = 300;

/** Removes secrets and personal data from one block of text. */
export function redact(text, home = homedir()) {
  return (
    text
      .replaceAll(home, '~')
      .replace(/\/Users\/[^/\s"']+/g, '/Users/<user>')
      .replace(/("?(?:auth)?token"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1<redacted>')
      // Long opaque strings are secrets; UUIDs (pane keys, worktree ids) are not and help debugging.
      .replace(/\b(?![0-9a-f]{8}-[0-9a-f]{4}-)[A-Za-z0-9+/_-]{32,}={0,2}/gi, '<redacted>')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
  );
}

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return 'n/a';
  }
};
const plist = (app, key) => run('defaults', ['read', `${app}/Contents/Info`, key]);
const tail = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-LINES).join('\n');
  } catch {
    return `(not found: ${file})`;
  }
};

function collect() {
  const home = homedir();
  const sdDir = join(home, 'Library/Application Support/com.elgato.StreamDeck/Plugins');
  const bDir = join(sdDir, 'pl.1am.orca-agent-deck.sdPlugin');
  let bVersion = 'not installed';
  try {
    bVersion = JSON.parse(readFileSync(join(bDir, 'manifest.json'), 'utf8')).Version;
  } catch {
    // not installed
  }
  let aVersion = 'not installed';
  try {
    const list = JSON.parse(run('orca', ['plugin', 'list', '--json'])).result.plugins;
    const a = list.find((p) => p.pluginKey?.endsWith('.agent-deck'));
    if (a) aVersion = `${a.version} (${a.pluginKey})`;
  } catch {
    // orca CLI missing or Orca not running
  }
  const bLogs = join(bDir, 'logs');
  let bLog = join(bLogs, 'pl.1am.orca-agent-deck.0.log');
  try {
    bLog = readdirSync(bLogs)
      .map((f) => join(bLogs, f))
      .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0];
  } catch {
    // no log folder yet
  }

  return [
    `Orca Agent Deck diagnostics, ${new Date().toISOString()}`,
    '',
    `macOS: ${run('sw_vers', ['-productVersion'])} (${process.arch})`,
    `Orca app: ${plist('/Applications/Orca.app', 'CFBundleShortVersionString')}`,
    `orca CLI: ${run('orca', ['--version'])}`,
    `Elgato Stream Deck app: ${plist('/Applications/Elgato Stream Deck.app', 'CFBundleShortVersionString')}`,
    `Stream Deck plugin: ${bVersion}`,
    `Orca plugin: ${aVersion}`,
    `Node: ${process.version}`,
    `tmux update-environment: ${run('tmux', ['show-options', '-g', 'update-environment'])
      .split('\n')
      .map((l) => l.split(/\s+/).slice(1).join(' ') || l)
      .join(' ')}`,
    '',
    `== Stream Deck plugin log (last ${LINES} lines) ==`,
    tail(bLog),
    '',
    `== Orca plugin log (last ${LINES} lines) ==`,
    tail(join(home, '.orca-deck', 'plugin-a.log')),
    '',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = `orca-deck-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  writeFileSync(out, redact(collect()));
  console.log(`Wrote ${out}. Read it before attaching it to an issue.`);
}
