// `pnpm panel-test`: the sidebar panel on Orca's own `orca/testing` mount (needs Orca >= 1.4.251 installed; local only).
// `orca plugin test` only runs inside a plugin folder, so the panel, a manifest and the test are staged in a temp one.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
try {
  execFileSync('orca', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('panel-test needs the `orca` CLI (Orca >= 1.4.251) on PATH; it is local-only');
  process.exit(2);
}
const stage = mkdtempSync(join(tmpdir(), 'panel-test-stage-'));
for (const f of ['panel.jsx', 'orca-plugin.json'])
  copyFileSync(join(root, 'orca-plugin', f), join(stage, f));
copyFileSync(join(root, 'test/panel/panel.test.mjs'), join(stage, 'panel.test.mjs'));
const r = spawnSync('orca', ['plugin', 'test', stage], { stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
process.exit(r.status ?? 1);
