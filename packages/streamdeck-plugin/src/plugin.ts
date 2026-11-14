import streamDeck from '@elgato/streamdeck';
import { MappingStore, DeckController, type SlotSettings } from '@orca-agent-deck/core';
import { makeExec } from '@orca-agent-deck/adapter-cli';
import { createRuntimeAdapter } from '@orca-agent-deck/adapter-runtime';
import { makeRaiser } from '@orca-agent-deck/window-raiser';
import { currentHost } from './host.ts';
import { FileSlotStorage, defaultMappingsPath } from './mapping-file.ts';
import { PaneSlot } from './actions/pane-slot.ts';
import { StatusKey } from './actions/status.ts';
import { AttentionKey } from './actions/attention.ts';
import { BridgedAdapter } from '@orca-agent-deck/adapter-bridge';
import { bridgeServer, deckConnected, startBridge, statusFeed, stopBridge } from './bridge.ts';

type Slots = Record<string, SlotSettings>;

/** 1-based page and row-major index of a slot (spec 7.10), for pairResult. Page is 1: the SDK hides the current page. */
const slotAddress = (slot: string) => paneSlot.address(slot);

// Never log terminal content or the Orca runtime authToken.
streamDeck.logger.setLevel('info');

// Slot mappings live in the plugin's global settings so they survive restarts of the app and Orca.
// Settings can only be read once connected (awaiting them before connect never settles: exit 13),
// so the controller is built lazily and actions are registered before connecting.
async function createController(): Promise<DeckController> {
  const globals = (await streamDeck.settings.getGlobalSettings()) as {
    slots?: Slots;
    hostAliases?: Record<string, string>;
  };
  const saved = globals.slots ?? {};
  let cache = saved;
  // Host settings are only a cache: the mappings live in ~/.orca-deck/mappings.json so they survive
  // switching between the Elgato app and OpenDeck. First run migrates from the host settings.
  const store = new MappingStore(
    new FileSlotStorage(
      defaultMappingsPath(),
      {
        load: () => structuredClone(cache),
        save: (slots) => {
          cache = structuredClone(slots);
          void streamDeck.settings.setGlobalSettings({ slots: cache } as never);
        },
      },
      (m) => streamDeck.logger.info(m),
    ),
  );
  const raiser = makeRaiser();
  const raise = async () => {
    const r = await raiser.raise();
    streamDeck.logger.info(`raise ok=${r.ok} ms=${r.ms}${r.error ? ` error=${r.error}` : ''}`);
  };
  // Steady state reads the runtime socket (no process spawns); the CLI is the degraded fallback.
  const orca = createRuntimeAdapter({
    fallback: makeExec(),
    onFallback: (r) => streamDeck.logger.warn(`runtime socket unusable, using CLI: ${r}`),
    onRecover: () => streamDeck.logger.info('runtime socket back, CLI fallback off'),
  });
  orca.diag = (m) => streamDeck.logger.info(m);
  const deck = new DeckController(
    new BridgedAdapter(orca, statusFeed),
    store,
    raise,
    // Off for 0.1.0: it did not fill keys on a second machine. Keys show pinned panes only.
    { autofill: false },
  );
  deck.diag = (m) => streamDeck.logger.info(m);
  // Pairing mode (Map pane to key from Orca): A asks, the deck shows it, B answers over the bridge.
  deck.onPairingState = (st) => {
    paneSlot.repaintNow();
    if (st.phase === 'waitingForKey')
      bridgeServer.send({
        v: 1,
        type: 'pairState',
        requestId: st.requestId,
        state: 'waitingForKey',
        pane: { label: st.pane.lastKnown.title ?? st.pane.paneKey },
      });
  };
  deck.onPairingResult = (r) => {
    bridgeServer.send({
      v: 1,
      type: 'pairResult',
      requestId: r.requestId,
      ...(r.ok
        ? { ok: true as const, slot: slotAddress(r.slot) }
        : { ok: false as const, reason: r.reason }),
    });
    paneSlot.nudge();
  };
  // Short host names for the badge: global setting `hostAliases` = { "ssh:build-1": "build" }.
  deck.hostAliases = globals.hostAliases ?? {};
  return deck;
}

// One controller shared by all actions (created lazily, after connect).
let shared: Promise<DeckController> | undefined;
const controller = () => (shared ??= createController());
const paneSlot = new PaneSlot(controller);
streamDeck.actions.registerAction(paneSlot);
bridgeServer.on('message', (m) => {
  if (m.type !== 'pairRequest' && m.type !== 'unmapRequest' && m.type !== 'pairCancel') return;
  void (async () => {
    const c = await controller();
    if (m.type === 'pairCancel') return c.pairing.cancel(m.requestId);
    if (m.type === 'unmapRequest') {
      const n = await c.unmapPane(m.pane?.paneKey ?? null);
      streamDeck.logger.info(`unmap request: ${n} slot(s) freed`);
      return paneSlot.nudge();
    }
    const target = await c.pairingTarget(m.pane?.paneKey ?? null);
    c.pairing.start(m.requestId, target, deckConnected());
  })();
});
statusFeed.onChange(() => paneSlot.nudge());
streamDeck.actions.registerAction(new StatusKey(controller));
streamDeck.actions.registerAction(new AttentionKey(controller));
await streamDeck.connect();
const host = currentHost();
streamDeck.logger.info(
  `host: ${host.host} (${host.basis}), app ${host.version}, os ${host.os}, node ${process.version}`,
);
void startBridge();
process.once('SIGTERM', () => void stopBridge());
