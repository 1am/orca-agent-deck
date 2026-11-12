import streamDeck from '@elgato/streamdeck';
import { MappingStore, DeckController, type SlotSettings } from '@orca-agent-deck/core';
import { makeExec } from '@orca-agent-deck/adapter-cli';
import {
  RuntimeClient,
  RuntimeUnavailableError,
  createRuntimeAdapter,
  openPluginPanel,
} from '@orca-agent-deck/adapter-runtime';
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

/** Only a message: an error here may carry runtime text, and a failed push must never take the plugin down. */
const logFailure = (what: string) => (e: unknown) =>
  streamDeck.logger.warn(`${what} failed: ${e instanceof Error ? e.name : 'error'}`);

const runtime = new RuntimeClient();

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
  for (const d of store.dedupedOnLoad)
    streamDeck.logger.info(
      `mappings: pane ${d.paneKey} was on ${d.removed.length + 1} keys, kept the newest (${d.removed.length} cleared)`,
    );
  const raiser = makeRaiser();
  const raise = async () => {
    const r = await raiser.raise();
    streamDeck.logger.info(`raise ok=${r.ok} ms=${r.ms}${r.error ? ` error=${r.error}` : ''}`);
  };
  // Steady state reads the runtime socket (no process spawns); the CLI is the degraded fallback.
  const orca = createRuntimeAdapter({
    client: runtime,
    fallback: makeExec(),
    onFallback: (r) => streamDeck.logger.warn(`runtime socket unusable, using CLI: ${r}`),
    onRecover: () => streamDeck.logger.info('runtime socket back, CLI fallback off'),
  });
  // Windows does not let the plugin raise Orca; Orca's reveal raises its own window.
  orca.revealLocal = process.platform === 'win32';
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
        ? { ok: true as const, slot: slotAddress(r.slot), action: r.action }
        : { ok: false as const, reason: r.reason }),
    });
    // The Orca panel shows the result: tell it the keys as they are now, not a second later.
    void paneSlot
      .nudge()
      .then(() => pushDeck(true))
      .catch(logFailure('deck push after a pairing result'));
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
/** Last `deckState` sent, so an unchanged deck is not sent again. */
let lastDeck = '';
/** Tells A (the Orca panel) how the deck looks, when it changed or `force`d. Only an A that knows the frame gets it. */
async function pushDeck(force = false): Promise<void> {
  if ((bridgeServer.connection?.minor ?? 0) < 1) return;
  const c = await controller();
  const state = {
    ...paneSlot.deckState(),
    panes: c.panelPanes((slot) => paneSlot.keyOfSlot(slot)),
  };
  const sig = JSON.stringify(state);
  if (!force && sig === lastDeck) return;
  if (bridgeServer.send({ v: 1, type: 'deckState', ...state })) lastDeck = sig;
}
setInterval(() => void pushDeck().catch(logFailure('deck push')), 1000);
bridgeServer.on('hello', () => void pushDeck(true).catch(logFailure('deck push')));
bridgeServer.on('message', (m) => {
  if (m.type === 'requestDeck') return void pushDeck(true).catch(logFailure('deck push'));
  if (m.type === 'openPanel') {
    const { requestId } = m;
    // Never terminal text: the runtime's error is reduced to who could not answer.
    void openPluginPanel(runtime, m.panelId)
      .then(() => ({ ok: true as const }))
      .catch((e: unknown) => {
        const reason: 'unavailable' | 'refused' =
          e instanceof RuntimeUnavailableError ? 'unavailable' : 'refused';
        streamDeck.logger.warn(`open panel: ${reason}`);
        return { ok: false as const, reason };
      })
      .then((r) => bridgeServer.send({ v: 1, type: 'openPanelResult', requestId, ...r }));
    return;
  }
  if (
    m.type !== 'pairRequest' &&
    m.type !== 'unmapRequest' &&
    m.type !== 'pairCancel' &&
    m.type !== 'assignKey' &&
    m.type !== 'unmapKey'
  )
    return;
  void (async () => {
    const c = await controller();
    // Clicks in the Orca panel: B checks the key exists on the deck it shows, never A.
    if (m.type === 'assignKey')
      return c.assignFocusedTo(
        m.requestId,
        paneSlot.slotOfKey(m.key),
        m.replace,
        deckConnected(),
        m.paneKey ?? null,
      );
    if (m.type === 'unmapKey') {
      c.unmapSlot(m.requestId, paneSlot.slotOfKey(m.key));
      return paneSlot.nudge();
    }
    if (m.type === 'pairCancel') return c.pairing.cancel(m.requestId);
    if (m.type === 'unmapRequest') {
      const n = await c.unmapPane(m.pane?.paneKey ?? null);
      streamDeck.logger.info(`unmap request: ${n} slot(s) freed`);
      return paneSlot.nudge();
    }
    const target = await c.pairingTarget(m.pane?.paneKey ?? null);
    c.pairing.start(m.requestId, target, deckConnected());
  })().catch(logFailure('bridge request'));
});
statusFeed.onChange(() => void paneSlot.nudge().catch(logFailure('key refresh')));
streamDeck.actions.registerAction(new StatusKey(controller));
streamDeck.actions.registerAction(new AttentionKey(controller));
await streamDeck.connect();
const host = currentHost();
streamDeck.logger.info(
  `host: ${host.host} (${host.basis}), app ${host.version}, os ${host.os}, node ${process.version}`,
);
void startBridge();
process.once('SIGTERM', () => void stopBridge());
