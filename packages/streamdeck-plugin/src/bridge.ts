import streamDeck from '@elgato/streamdeck';
import {
  BridgeServer,
  BridgeStatusFeed,
  PluginInstallProbe,
} from '@orca-agent-deck/adapter-bridge';
import { makeExec } from '@orca-agent-deck/adapter-cli';

/** `asleep` = A connected earlier and Orca idled its worker (normal). `missing` = never connected. */
export type OrcaPluginState = 'connected' | 'asleep' | 'missing' | 'outdated';

// Created up front so the adapter can read the feed before (or without) the server starting.
const deckInfo = () => ({
  connected: streamDeck.devices.some((d) => d.isConnected),
  devices: [...streamDeck.devices]
    .filter((d) => d.isConnected)
    .map((d) => ({ model: String(d.type), keys: d.size.columns * d.size.rows })),
});
export const bridgeServer = new BridgeServer({
  deck: deckInfo,
  // Metadata only; the bridge never logs tokens or terminal content.
  log: (m) => streamDeck.logger.info(m),
});
export const statusFeed = new BridgeStatusFeed(bridgeServer);
let started = false;

/** Starts the bridge once. A failure here must never take the deck down (B works without A). */
export async function startBridge(): Promise<void> {
  if (started) return;
  try {
    await bridgeServer.start();
    started = true;
  } catch (e) {
    streamDeck.logger.warn(`bridge not started: ${String(e)}`);
  }
}

// Orca starts A's worker on the first event, so before that "never connected" is not "missing":
// ask Orca whether the plugin is installed (rarely, the CLI spawn is only for the Setup doctor).
const probe = new PluginInstallProbe((args) => makeExec()(args));
/** An outdated A retries every 30 s at most; one missed retry still counts. */
const OUTDATED_MS = 90_000;

/** Forces a fresh install probe and waits for it (the Setup tab's "Check again"). */
export const refreshInstalled = (): Promise<void> => probe.refresh(true);

export function orcaPluginState(): OrcaPluginState | null {
  if (!started) return null;
  if (statusFeed.connected) return 'connected';
  // An older Orca plugin keeps retrying with the old hello: it never gets in until it is updated.
  if (bridgeServer.outdatedPeerAt && Date.now() - bridgeServer.outdatedPeerAt < OUTDATED_MS)
    return 'outdated';
  if (statusFeed.hasBridge) return 'asleep';
  void probe.refresh();
  // Unanswered probe: unknown, not missing.
  if (probe.installed === null) return null;
  return probe.installed ? 'asleep' : 'missing';
}

export function orcaPluginVersion(): string | null {
  return bridgeServer.connection?.pluginVersion ?? null;
}

export async function stopBridge(): Promise<void> {
  started = false;
  await bridgeServer.stop();
}

export const deckConnected = () => deckInfo().connected;
