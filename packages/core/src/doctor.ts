import type { DeckState } from './status.ts';
import type { InfoModel } from './render.ts';

export type CheckResult = 'ok' | 'warn' | 'fail';
export type CheckId =
  | 'orca-running'
  | 'orca-version'
  | 'orca-response'
  | 'orca-bin'
  | 'live-link'
  | 'slots'
  | 'orca-plugin'
  | 'tmux-env'
  | 'hooks'
  | 'device'
  | 'remote-hosts';

/** A button next to a result: the surface (PI, Orca) runs the named action; core only names it. */
export interface Fix {
  action: 'enable-hooks' | 'install-profile' | 'open-orca-hosts' | 'download-host';
  label: string;
  /** Harness id for `enable-hooks`. */
  harness?: string;
}

export interface Check {
  id: CheckId;
  label: string;
  result: CheckResult;
  /** One line explaining the result, shown in the Setup tab. */
  reason: string;
  /** Short key caption for a non-ok result, 2 lines at most. */
  caption: string;
  /** What the user can do about it. */
  hint?: string;
  /** One-click fix, when there is one. */
  fix?: Fix;
}

/** Facts the plugin collects; `null` means "not checked", which never fails a check. */
export interface DoctorFacts {
  orcaRunning: boolean;
  orcaVersion: string | null;
  orcaUnsupported: boolean;
  /** Orca is up but its latest listing did not parse (see the plugin log for the field). */
  orcaResponseBad?: boolean;
  /** How the `orca` binary was found; `path` means nothing was found and PATH is the last resort. */
  binSource: 'env' | 'app-bundle' | 'fallback' | 'path' | null;
  binReason?: string;
  /** How reads reach Orca: the runtime socket (fast) or the `orca` CLI (a process spawn per read). */
  liveLink?: 'socket' | 'cli' | null;
  /** Pane slot keys that currently hold a pane. */
  mappedSlots: number;
  /**
   * Orca plugin A over the bridge. `asleep` = it connected earlier and Orca idled the worker,
   * which is normal and not a fault. `missing` = it never connected since the plugin started.
   */
  orcaPlugin?: 'connected' | 'asleep' | 'missing' | 'outdated' | null;
  /** Version A reported in `hello`, while connected. */
  orcaPluginVersion?: string | null;
  /** Stream Deck host running plugin B; `unknown` when it cannot be told (see streamdeck-plugin host.ts). */
  host?: 'elgato' | 'opendeck' | 'unknown' | null;
  /**
   * Orca's agent hooks per harness. `not_installed` is a warning for Claude Code and Pi (no status
   * arrives), but not for Codex, which Orca tracks even then (development-changelog 2026-11).
   */
  hooks?: Record<string, 'installed' | 'not_installed' | 'unknown'> | null;
  /** Connected Stream Deck devices, and how many of them show at least one Pane slot. */
  devices?: { connected: number; withPaneSlots: number } | null;
  /** Remote hosts Orca lists that are not reachable right now (display names). */
  hostsDown?: string[] | null;
  /** Hook variables missing from tmux's `update-environment` (see `tmuxMissingVars`). */
  tmuxMissing?: string[] | null;
}

/** Variables Orca's agent hooks need inside tmux; without them an agent in tmux reports nothing. */
const TMUX_HOOK_VARS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_PANE_KEY',
];

/** Hook variables absent from `tmux show-options -g update-environment` output. */
export function tmuxMissingVars(output: string): string[] {
  const have = new Set(
    output
      .split('\n')
      .flatMap((line) => line.trim().split(/\s+/).slice(1))
      .map((v) => v.replace(/^"|"$/g, '')),
  );
  return TMUX_HOOK_VARS.filter((v) => !have.has(v));
}

/** Setup checks, in the order they are shown. */
export function runChecks(f: DoctorFacts): Check[] {
  const checks: Check[] = [];

  checks.push(
    f.orcaRunning
      ? {
          id: 'orca-running',
          label: 'Orca running',
          result: 'ok',
          reason: 'Orca is running',
          caption: '',
        }
      : {
          id: 'orca-running',
          label: 'Orca running',
          result: 'fail',
          reason: 'Orca is not running or its runtime is not ready',
          caption: 'Orca not running',
          hint: 'Open Orca',
        },
  );

  if (f.orcaRunning) {
    checks.push(
      f.orcaUnsupported
        ? {
            id: 'orca-version',
            label: 'Orca version',
            result: 'fail',
            reason: `Orca ${f.orcaVersion ?? '?'} is older than Agent Deck for Orca supports`,
            caption: `Orca ${f.orcaVersion ?? ''} too old`.trim(),
            hint: 'Update Orca',
          }
        : {
            id: 'orca-version',
            label: 'Orca version',
            result: 'ok',
            reason: `Orca ${f.orcaVersion ?? 'unknown version'}`,
            caption: '',
          },
    );
  }

  if (f.orcaRunning && f.orcaResponseBad) {
    checks.push({
      id: 'orca-response',
      label: 'Orca response',
      result: 'fail',
      reason:
        'Orca answered, but a listing did not match what Agent Deck for Orca expects; the keys show the last good read (the plugin log names the field)',
      caption: 'unexpected Orca response',
      hint: 'Update Agent Deck for Orca, or report the plugin log line',
    });
  }

  if (f.binSource === 'path') {
    checks.push({
      id: 'orca-bin',
      label: 'orca binary',
      result: 'warn',
      reason: f.binReason ?? 'orca binary not found; relying on PATH',
      caption: 'orca CLI not found',
      hint: 'Set ORCA_BIN or install the Orca CLI',
    });
  } else if (f.binSource) {
    checks.push({
      id: 'orca-bin',
      label: 'orca binary',
      result: 'ok',
      reason: f.binReason ?? `found via ${f.binSource}`,
      caption: '',
    });
  }

  if (f.liveLink === 'cli') {
    checks.push({
      id: 'live-link',
      label: 'Orca link',
      result: 'warn',
      reason:
        'Reading Orca through the orca CLI, which is slow (the runtime socket is not answering); see the plugin log for the reason',
      caption: 'slow link (CLI)',
      hint: 'Restart Orca, or check that Orca 1.4.245+ is running as the same user',
    });
  } else if (f.liveLink === 'socket') {
    checks.push({
      id: 'live-link',
      label: 'Orca link',
      result: 'ok',
      reason: 'Reading Orca over its runtime socket',
      caption: '',
    });
  }

  checks.push(
    f.mappedSlots > 0
      ? {
          id: 'slots',
          label: 'Pane slots',
          result: 'ok',
          reason: `${f.mappedSlots} pane slot${f.mappedSlots === 1 ? '' : 's'} mapped`,
          caption: '',
        }
      : {
          id: 'slots',
          label: 'Pane slots',
          result: 'warn',
          reason: 'No pane slot is mapped to a pane yet',
          caption: 'no panes mapped',
          hint: 'Hold a Pane slot key while a pane is focused in Orca, or use the picker',
        },
  );

  if (f.orcaPlugin === 'outdated') {
    checks.push({
      id: 'orca-plugin',
      label: 'Orca plugin',
      result: 'warn',
      reason:
        'The installed Orca plugin is older than this Stream Deck plugin and cannot connect; the deck works with slower, polled status',
      caption: 'Orca plugin outdated',
      hint: 'Update the Orca plugin: both plugins must come from the same release',
    });
  } else if (f.orcaPlugin === 'missing') {
    checks.push({
      id: 'orca-plugin',
      label: 'Orca plugin',
      result: 'warn',
      reason:
        'The Agent Deck for Orca plugin has not connected; the deck works with slower, polled status',
      caption: 'Orca plugin missing',
      hint: 'Install or enable the Agent Deck for Orca plugin in Orca',
    });
  } else if (f.orcaPlugin === 'connected' || f.orcaPlugin === 'asleep') {
    checks.push({
      id: 'orca-plugin',
      label: 'Orca plugin',
      result: 'ok',
      reason:
        f.orcaPlugin === 'connected'
          ? `Orca plugin ${f.orcaPluginVersion ? `${f.orcaPluginVersion} ` : ''}connected`
          : 'Orca plugin is installed and connects on the next agent event',
      caption: '',
    });
  }

  if (f.tmuxMissing?.length) {
    checks.push({
      id: 'tmux-env',
      label: 'tmux',
      result: 'warn',
      reason: `tmux does not pass ${f.tmuxMissing.join(', ')} to sessions, so agents inside tmux report no status`,
      caption: 'tmux env missing',
      hint: `Add to ~/.tmux.conf: set -ga update-environment "${TMUX_HOOK_VARS.join(' ')}", then start a new tmux server (tmux kill-server). Full setup: docs/assets/tmux-example.conf`,
    });
  } else if (f.tmuxMissing) {
    checks.push({
      id: 'tmux-env',
      label: 'tmux',
      result: 'ok',
      reason: 'tmux passes the Orca hook variables to sessions',
      caption: '',
    });
  }

  if (f.hooks) {
    for (const [harness, st] of Object.entries(f.hooks)) {
      if (st !== 'not_installed' || harness === 'codex') continue;
      checks.push({
        id: 'hooks',
        label: `${harness} hooks`,
        result: 'warn',
        reason: `Orca's ${harness} status hooks are not installed, so ${harness} panes report no status`,
        caption: `${harness} hooks off`,
        hint: 'Enable the hooks in Orca',
        fix: { action: 'enable-hooks', label: 'Enable', harness },
      });
    }
    if (!checks.some((c) => c.id === 'hooks'))
      checks.push({
        id: 'hooks',
        label: 'Agent hooks',
        result: 'ok',
        reason: 'Orca agent hooks are installed',
        caption: '',
      });
  }

  if (f.devices) {
    checks.push(
      f.devices.connected === 0
        ? {
            id: 'device',
            label: 'Stream Deck',
            result: 'fail',
            reason: 'No Stream Deck device is connected',
            caption: 'no deck',
            hint: 'Connect a device, or quit the other Stream Deck host that holds it',
            ...(f.host === 'unknown' || !f.host
              ? {}
              : { fix: { action: 'download-host' as const, label: 'Get the Stream Deck app' } }),
          }
        : f.devices.withPaneSlots === 0
          ? {
              id: 'device',
              label: 'Stream Deck',
              result: 'warn',
              reason: 'No connected device has a Pane slot key on its page',
              caption: 'no pane slots',
              hint: 'Install the Agent Deck for Orca profile, or drag Pane slot keys onto a page',
              fix: { action: 'install-profile', label: 'Install profile' },
            }
          : {
              id: 'device',
              label: 'Stream Deck',
              result: 'ok',
              reason: `${f.devices.connected} device${f.devices.connected === 1 ? '' : 's'} connected`,
              caption: '',
            },
    );
  }

  if (f.hostsDown?.length) {
    checks.push({
      id: 'remote-hosts',
      label: 'Remote hosts',
      result: 'warn',
      reason: `Not reachable: ${f.hostsDown.join(', ')}. Their keys show the last known state`,
      caption: f.hostsDown.length === 1 ? 'host down' : `${f.hostsDown.length} hosts down`,
      hint: 'Check the host in Orca settings',
      fix: { action: 'open-orca-hosts', label: 'Open Orca hosts' },
    });
  } else if (f.hostsDown) {
    checks.push({
      id: 'remote-hosts',
      label: 'Remote hosts',
      result: 'ok',
      reason: 'All Orca hosts are reachable',
      caption: '',
    });
  }

  return checks;
}

const RANK: Record<CheckResult, number> = { ok: 0, warn: 1, fail: 2 };

/** The worst check (first one wins a tie), or null when everything is fine. */
export function worstCheck(checks: Check[]): Check | null {
  let worst: Check | null = null;
  for (const c of checks)
    if (c.result !== 'ok' && (!worst || RANK[c.result] > RANK[worst.result])) worst = c;
  return worst;
}

/** Status key: the worst failure, otherwise a green tick with the live/polling mode. */
export function doctorInfo(
  checks: Check[],
  ok: {
    mode: 'live' | 'degraded';
    version: string | null;
    hostsDown: number;
    orcaPlugin?: DoctorFacts['orcaPlugin'];
  },
): InfoModel {
  const w = worstCheck(checks);
  if (w) {
    const tone: DeckState =
      w.id === 'orca-running' ? 'offline' : w.result === 'fail' ? 'error' : 'idle';
    return { tone, value: w.id === 'orca-running' ? 'OFF' : '!', caption: w.caption };
  }
  if (ok.hostsDown > 0) {
    return {
      tone: 'idle',
      value: String(ok.hostsDown),
      caption: ok.hostsDown === 1 ? 'host down' : 'hosts down',
    };
  }
  // An installed plugin A that has not connected yet is not a degraded link: Orca starts it on the
  // next agent event and the runtime socket already serves the data.
  return ok.mode === 'live' || ok.orcaPlugin === 'asleep'
    ? { tone: 'completed', value: 'OK', caption: `live ${ok.version ?? ''}`.trim() }
    : { tone: 'idle', value: 'OK', caption: `slow updates ${ok.version ?? ''}`.trim() };
}
