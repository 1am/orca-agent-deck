import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  action,
  type PropertyInspectorDidAppearEvent,
  type SendToPluginEvent,
} from '@elgato/streamdeck';
import {
  doctorInfo,
  runChecks,
  tmuxMissingVars,
  type DeckController,
  type DoctorFacts,
} from '@orca-agent-deck/core';
import { resolveOrcaBinCached, type ResolvedBin } from '@orca-agent-deck/adapter-cli';
import { InfoKey } from './info-key.ts';
import { currentHost } from '../host.ts';
import { isCurrentPi, replyToPi } from './pi.ts';
import { orcaPluginState, orcaPluginVersion, refreshInstalled } from '../bridge.ts';

let bin: ResolvedBin | undefined;
void resolveOrcaBinCached().then((b) => (bin = b));

// Stream Deck starts plugins with a minimal PATH, so look where tmux is usually installed.
const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) =>
  existsSync(p),
);
const TMUX_TTL_MS = 60_000;
let tmux: { missing: string[] | null; at: number } = { missing: null, at: 0 };

/** Re-reads tmux's update-environment; no tmux or no server running = not checked (null). */
function readTmux(): Promise<void> {
  if (!TMUX) return Promise.resolve();
  return new Promise((done) =>
    execFile(TMUX, ['show-options', '-g', 'update-environment'], { timeout: 2000 }, (err, out) => {
      tmux = { missing: err ? null : tmuxMissingVars(out), at: Date.now() };
      done();
    }),
  );
}

/** Longest the Setup list waits for one probe; the inspector gives up after 5 s (10 s while Orca is read through the CLI). */
const PROBE_MS = 4000;

/** `p`, or undefined after `ms` or when it fails: the caller carries on with what it already knows. */
function within(p: Promise<unknown>, ms: number): Promise<unknown> {
  let stop = () => {};
  const deadline = new Promise<undefined>((done) => {
    const t = setTimeout(done, ms);
    stop = () => clearTimeout(t);
  });
  return Promise.race([p.catch(() => undefined), deadline]).finally(stop);
}

/** Setup doctor facts. */
function doctorFacts(c: DeckController): DoctorFacts {
  if (Date.now() - tmux.at > TMUX_TTL_MS) {
    tmux.at = Date.now();
    void readTmux();
  }
  const o = c.overview();
  return {
    orcaRunning: o.mode !== 'down',
    orcaVersion: o.version,
    orcaUnsupported: o.unsupported,
    orcaResponseBad: o.badResponse,
    binSource: bin?.source ?? null,
    binReason: bin?.reason,
    liveLink: o.mode === 'down' ? null : o.fast ? 'socket' : 'cli',
    // The key counts the same hosts (`overview().hostsDown`), so key and list cannot disagree.
    hostsDown: o.mode === 'down' ? null : o.hostsDownNames,
    mappedSlots: c.mappedSlotCount(),
    orcaPlugin: orcaPluginState(),
    orcaPluginVersion: orcaPluginVersion(),
    tmuxMissing: tmux.missing,
    host: currentHost(),
    nodeVersion: process.version,
  };
}

/** Worst Setup doctor result, else adapter health. Press = reconnect (refresh now). */
@action({ UUID: 'pl.1am.orca-agent-deck.status' })
export class StatusKey extends InfoKey {
  protected model(c: DeckController) {
    const o = c.overview();
    return doctorInfo(runChecks(doctorFacts(c)), {
      mode: o.mode === 'live' ? 'live' : 'degraded',
      version: o.version,
      hostsDown: o.hostsDown,
      orcaPlugin: orcaPluginState(),
    });
  }
  /** Setup tab: send every check result to the Property Inspector. */
  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent): Promise<void> {
    await this.sendChecks(ev.action.id);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<never, never>): Promise<void> {
    await this.sendChecks(ev.action.id);
  }

  private async sendChecks(id: string): Promise<void> {
    // A hidden PI's `load` must not cost a refresh and tmux spawn.
    if (!isCurrentPi(id)) return;
    const c = await this.create();
    // Every probe gets a deadline below the inspector's own: a hung one (a host that does not answer, a queued
    // refresh behind it) must not keep the whole list from being sent. The list then shows what is known.
    await Promise.all(
      [c.refresh([]), readTmux(), refreshInstalled()].map((p) => within(p, PROBE_MS)),
    );
    await replyToPi(id, {
      type: 'checks',
      checks: runChecks(doctorFacts(c)),
      // The inspector waits longer for an answer while every read spawns the CLI.
      slow: !c.overview().fast,
    });
  }

  protected async press(c: DeckController) {
    await c.refresh([]);
    return 'ok' as const;
  }
}
