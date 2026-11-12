import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import streamDeck, { action } from '@elgato/streamdeck';
import {
  doctorInfo,
  runChecks,
  tmuxMissingVars,
  type DeckController,
  type DoctorFacts,
} from '@orca-agent-deck/core';
import { resolveOrcaBinCached, type ResolvedBin } from '@orca-agent-deck/adapter-cli';
import { InfoKey } from './info-key.ts';
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
    mappedSlots: c.mappedSlotCount(),
    orcaPlugin: orcaPluginState(),
    orcaPluginVersion: orcaPluginVersion(),
    tmuxMissing: tmux.missing,
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
  override async onPropertyInspectorDidAppear(): Promise<void> {
    await this.sendChecks();
  }

  override async onSendToPlugin(): Promise<void> {
    await this.sendChecks();
  }

  private async sendChecks(): Promise<void> {
    const c = await this.create();
    await Promise.all([c.refresh([]), readTmux(), refreshInstalled()]);
    await streamDeck.ui.sendToPropertyInspector({
      type: 'checks',
      checks: runChecks(doctorFacts(c)),
    } as never);
  }

  protected async press(c: DeckController) {
    await c.refresh([]);
    return 'ok' as const;
  }
}
