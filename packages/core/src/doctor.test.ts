import { describe, expect, it } from 'vitest';
import type { DeckHostInfo } from './host.ts';
import {
  ORCA_PLUGIN_INSTALL_URL,
  doctorInfo,
  runChecks,
  tmuxMissingVars,
  worstCheck,
  type DoctorFacts,
} from './doctor.ts';

const good: DoctorFacts = {
  orcaRunning: true,
  orcaVersion: '1.4.2',
  orcaUnsupported: false,
  binSource: 'app-bundle',
  mappedSlots: 4,
};
const ok = { mode: 'live' as const, version: '1.4.2', hostsDown: 0 };

describe('runChecks', () => {
  it('shows the detected host and never makes it a problem', () => {
    const host = {
      os: 'mac',
      host: 'opendeck',
      version: '7.1.0',
      basis: 'version-pixel-ratio',
    } as const;
    const checks = runChecks({ ...good, host });
    expect(checks.find((c) => c.id === 'deck-host')).toMatchObject({
      result: 'ok',
      reason: 'OpenDeck 7.1.0, mac (by version-pixel-ratio)',
    });
    const unknown = runChecks({ ...good, host: { ...host, host: 'unknown', basis: 'none' } });
    expect(unknown.find((c) => c.id === 'deck-host')?.reason).toContain('ORCA_DECK_HOST');
    expect(worstCheck(unknown)).toBeNull();
  });

  it('warns on a Node below 20 in the Stream Deck app row, with the OpenDeck hint', () => {
    const od: DeckHostInfo = { os: 'linux', host: 'opendeck', version: '7.1.0', basis: 'linux' };
    const row = (nodeVersion: string, host = od) =>
      runChecks({ ...good, host, nodeVersion }).find((c) => c.id === 'deck-host');
    expect(row('v18.19.0')).toMatchObject({
      result: 'warn',
      caption: 'Node too old',
      hint: 'OpenDeck uses your system Node: install Node 20+',
    });
    expect(row('v18.19.0', { ...od, host: 'elgato' })?.hint).toMatch(/Update the Elgato/);
    expect(row('v20.20.2')).toMatchObject({ result: 'ok' });
    expect(row('v20.20.2')?.reason).toContain('Node 20.20.2');
    expect(row('v9.11.2')?.result).toBe('warn');
    expect(
      runChecks({ ...good, host: od }).find((c) => c.id === 'deck-host')?.reason,
    ).not.toContain('Node');
  });

  it('passes everything on a healthy setup', () => {
    const checks = runChecks(good);
    expect(checks.every((c) => c.result === 'ok')).toBe(true);
    expect(worstCheck(checks)).toBeNull();
  });

  it('fails with "Orca not running" and hides the version check', () => {
    const checks = runChecks({ ...good, orcaRunning: false });
    expect(checks.find((c) => c.id === 'orca-version')).toBeUndefined();
    expect(worstCheck(checks)).toMatchObject({
      id: 'orca-running',
      caption: 'Orca not running',
      hint: 'Open Orca',
    });
  });

  it('fails with "unexpected Orca response" when Orca is up but its listing did not parse', () => {
    expect(worstCheck(runChecks({ ...good, orcaResponseBad: true }))).toMatchObject({
      id: 'orca-response',
      result: 'fail',
      caption: 'unexpected Orca response',
    });
  });

  it('fails on an unsupported Orca version', () => {
    const w = worstCheck(runChecks({ ...good, orcaVersion: '1.0.0', orcaUnsupported: true }));
    expect(w).toMatchObject({ id: 'orca-version', result: 'fail', caption: 'Orca 1.0.0 too old' });
  });

  it('warns when the orca binary was not found', () => {
    const w = worstCheck(runChecks({ ...good, binSource: 'path' }));
    expect(w).toMatchObject({ id: 'orca-bin', result: 'warn' });
  });

  it('warns when no slot is mapped', () => {
    expect(worstCheck(runChecks({ ...good, mappedSlots: 0 }))?.id).toBe('slots');
  });

  it('skips checks that were not run', () => {
    const ids = runChecks({ ...good, binSource: null }).map((c) => c.id);
    expect(ids).toEqual(['orca-running', 'orca-version', 'slots']);
  });

  it('warns when reads go through the slow CLI instead of the runtime socket', () => {
    const link = (liveLink: DoctorFacts['liveLink']) =>
      runChecks({ ...good, liveLink }).find((c) => c.id === 'live-link');
    expect(link('cli')?.result).toBe('warn');
    expect(link('socket')?.result).toBe('ok');
    expect(link(null)).toBeUndefined();
  });

  it('shows the Orca plugin as ok when connected and when asleep, warns when missing', () => {
    const plugin = (orcaPlugin: DoctorFacts['orcaPlugin']) =>
      runChecks({ ...good, orcaPlugin }).find((c) => c.id === 'orca-plugin');
    expect(plugin('connected')).toMatchObject({ result: 'ok', reason: 'Orca plugin connected' });
    expect(
      runChecks({ ...good, orcaPlugin: 'connected', orcaPluginVersion: '0.1.0' }).find(
        (c) => c.id === 'orca-plugin',
      )?.reason,
    ).toBe('Orca plugin 0.1.0 connected');
    expect(plugin('asleep')).toMatchObject({ result: 'ok' });
    expect(plugin('asleep')?.reason).toMatch(/installed and connects on the next agent event/);
    expect(plugin('missing')).toMatchObject({
      result: 'warn',
      caption: 'Install the Orca plugin',
      fix: { action: 'open-url', url: ORCA_PLUGIN_INSTALL_URL },
    });
    expect(plugin(null)).toBeUndefined();
    expect(plugin(undefined)).toBeUndefined();
  });

  it('an idle Orca plugin never makes the key show a problem', () => {
    expect(worstCheck(runChecks({ ...good, orcaPlugin: 'asleep' }))).toBeNull();
  });

  it('puts a fail ahead of an earlier warning', () => {
    const w = worstCheck(runChecks({ ...good, binSource: 'path', orcaUnsupported: true }));
    expect(w?.id).toBe('orca-version');
  });
});

describe('doctorInfo', () => {
  it('shows OFF when Orca is down', () => {
    expect(doctorInfo(runChecks({ ...good, orcaRunning: false }), ok)).toEqual({
      tone: 'offline',
      value: 'OFF',
      caption: 'Orca not running',
    });
  });

  it('shows the worst reason for other failures', () => {
    const m = doctorInfo(runChecks({ ...good, binSource: 'path' }), ok);
    expect(m).toMatchObject({ tone: 'idle', value: '!', caption: 'orca CLI not found' });
  });

  it('shows a green tick with the mode when all is well', () => {
    expect(doctorInfo(runChecks(good), ok)).toMatchObject({
      tone: 'completed',
      value: 'OK',
      caption: 'live 1.4.2',
    });
    expect(doctorInfo(runChecks(good), { ...ok, mode: 'degraded' })).toMatchObject({
      tone: 'idle',
      caption: 'slow updates 1.4.2',
    });
  });

  it('reads live when plugin A is installed but has not connected yet', () => {
    const degraded = { ...ok, mode: 'degraded' as const };
    expect(doctorInfo(runChecks(good), { ...degraded, orcaPlugin: 'asleep' })).toMatchObject({
      tone: 'completed',
      caption: 'live 1.4.2',
    });
    expect(doctorInfo(runChecks(good), { ...degraded, orcaPlugin: null })).toMatchObject({
      caption: 'slow updates 1.4.2',
    });
  });

  it('still warns when the probe answered not installed', () => {
    const m = doctorInfo(runChecks({ ...good, orcaPlugin: 'missing' }), {
      ...ok,
      mode: 'degraded',
      orcaPlugin: 'missing',
    });
    expect(m).toMatchObject({ value: '!', caption: 'Install the Orca plugin' });
  });

  it('reports hosts down after setup checks pass', () => {
    expect(doctorInfo(runChecks(good), { ...ok, hostsDown: 2 })).toMatchObject({
      value: '2',
      caption: 'hosts down',
    });
  });
});

describe('outdated Orca plugin', () => {
  it('warns with the update hint', () => {
    expect(worstCheck(runChecks({ ...good, orcaPlugin: 'outdated' }))).toMatchObject({
      id: 'orca-plugin',
      result: 'warn',
      caption: 'Update Agent Deck for Orca',
    });
  });
});

describe('tmux env check', () => {
  const show = (vars: string[]) => vars.map((v, i) => `update-environment[${i}] ${v}`).join('\n');

  it('lists the hook variables tmux does not pass on', () => {
    expect(tmuxMissingVars(show(['DISPLAY', 'SSH_AUTH_SOCK']))).toEqual([
      'ORCA_AGENT_HOOK_PORT',
      'ORCA_AGENT_HOOK_TOKEN',
      'ORCA_AGENT_HOOK_ENDPOINT',
      'ORCA_PANE_KEY',
    ]);
    expect(tmuxMissingVars(show(['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT']))).toEqual([
      'ORCA_AGENT_HOOK_TOKEN',
      'ORCA_AGENT_HOOK_ENDPOINT',
    ]);
    expect(
      tmuxMissingVars(
        show([
          'ORCA_AGENT_HOOK_PORT',
          '"ORCA_AGENT_HOOK_TOKEN"',
          'ORCA_AGENT_HOOK_ENDPOINT',
          'ORCA_PANE_KEY',
        ]),
      ),
    ).toEqual([]);
    expect(tmuxMissingVars('')).toHaveLength(4);
  });

  it('warns with the fix when variables are missing, skips when tmux was not checked', () => {
    const w = worstCheck(runChecks({ ...good, tmuxMissing: ['ORCA_PANE_KEY'] }));
    expect(w).toMatchObject({ id: 'tmux-env', result: 'warn', caption: 'tmux env missing' });
    expect(w?.hint).toContain('set -ga update-environment');
    expect(runChecks({ ...good, tmuxMissing: [] }).find((c) => c.id === 'tmux-env')?.result).toBe(
      'ok',
    );
    expect(
      runChecks({ ...good, tmuxMissing: null }).find((c) => c.id === 'tmux-env'),
    ).toBeUndefined();
  });
});

describe('doctor v2 checks', () => {
  const base = {
    orcaRunning: true,
    orcaVersion: '1.4.245',
    orcaUnsupported: false,
    binSource: null,
    mappedSlots: 1,
  } as const;
  const by = (f: object, id: string) =>
    runChecks({ ...base, ...f } as never).filter((c) => c.id === id);

  it('offers Enable for a harness whose hooks are not installed, but never gates Codex', () => {
    const [c] = by(
      { hooks: { claude: 'not_installed', codex: 'not_installed', pi: 'installed' } },
      'hooks',
    );
    expect(c).toMatchObject({ result: 'warn', fix: { action: 'enable-hooks', harness: 'claude' } });
    expect(
      by({ hooks: { claude: 'not_installed', codex: 'not_installed' } }, 'hooks'),
    ).toHaveLength(1);
    expect(by({ hooks: { codex: 'not_installed' } }, 'hooks')[0]?.result).toBe('ok');
    expect(by({ hooks: null }, 'hooks')).toEqual([]);
  });

  it('device: none connected fails, none with pane slots offers the profile, else ok', () => {
    expect(by({ devices: { connected: 0, withPaneSlots: 0 } }, 'device')[0]?.result).toBe('fail');
    expect(by({ devices: { connected: 1, withPaneSlots: 0 } }, 'device')[0]).toMatchObject({
      result: 'warn',
      fix: { action: 'install-profile' },
    });
    expect(by({ devices: { connected: 2, withPaneSlots: 1 } }, 'device')[0]).toMatchObject({
      result: 'ok',
      reason: '2 devices connected',
    });
  });

  it('remote hosts: lists the unreachable ones, ok when all are up, silent when unchecked', () => {
    expect(by({ hostsDown: ['build-1', 'nas'] }, 'remote-hosts')[0]).toMatchObject({
      result: 'warn',
      caption: '2 hosts down',
    });
    expect(by({ hostsDown: [] }, 'remote-hosts')[0]?.result).toBe('ok');
    expect(by({}, 'remote-hosts')).toEqual([]);
  });

  it('the Status key and the list agree: the same warn row, naming the hosts', () => {
    const checks = runChecks({ ...good, hostsDown: ['build-1', 'nas'] });
    expect(doctorInfo(checks, { ...ok, hostsDown: 2 })).toMatchObject({
      value: '2',
      caption: '2 hosts down',
    });
    expect(worstCheck(checks)?.reason).toContain('build-1, nas');
  });
});
