import streamDeck, {
  action,
  SingletonAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type TitleParametersDidChangeEvent,
  type PropertyInspectorDidAppearEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from '@elgato/streamdeck';
import {
  HoldGestures,
  deckLayout,
  formatKeyNumber,
  keyNumber,
  spinnerAdvances,
  renderKey,
  type DeckController,
  type LayoutCell,
  type SlotView,
} from '@orca-agent-deck/core';
import { isCurrentPi, replyToPi } from './pi.ts';

const image = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;

const HINT_MS = 3000;

type PluginEvent = Parameters<NonNullable<SingletonAction['onSendToPlugin']>>[0];

interface PiMessage {
  type?: string;
  paneKey?: string | null;
}

/** The part of a key action that we use. */
interface Key {
  setImage(image: string): Promise<void>;
  setTitle(title: string): Promise<void>;
}

/**
 * The Orca panel, the one place a key is mapped. While it is open for mapping `pick` hands it a tapped key
 * (false: it could not be sent); `open` shows it at a held key's details (false: it could not be opened) or, while
 * the panel is already in view, hides the right sidebar instead ('hidden').
 */
export interface PanelPicker {
  selecting(): boolean;
  pick(key: number): boolean;
  open(key: number): Promise<boolean | 'hidden'>;
}
const NO_PANEL: PanelPicker = {
  selecting: () => false,
  pick: () => false,
  open: () => Promise.resolve(false),
};

/** One key per slot; slot id = action context. State comes from the shared DeckController. */
@action({ UUID: 'pl.1am.orca-agent-deck.pane' })
export class PaneSlot extends SingletonAction {
  private readonly keys = new Map<string, Key>();
  /** Formatted key number per key, recomputed on willAppear (never persisted). */
  private readonly numbers = new Map<string, string>();
  /** Raw 1-based key number per key, for pairResult. */
  private readonly indexes = new Map<string, number>();
  /** Set once the controller exists; pairing mode is read synchronously while repainting. */
  private ctl: DeckController | undefined;
  private readonly create: () => Promise<DeckController>;
  private ready: Promise<DeckController> | undefined;
  /** Last image sent per key; keys are only updated on change (Mobile runs over Wi-Fi). */
  private readonly sent = new Map<string, string>();
  private readonly views = new Map<string, SlotView>();
  private tick = 0;
  /** Spinner position, advanced by `spinnerAdvances` so a busy deck is not flooded with images. */
  private spin = 0;
  /** A refresh was asked for while one ran; run once more so a press is not shown stale. */
  private again = false;
  /** Short text shown on a key for a moment after a failed hold. */
  private readonly hints = new Map<string, { text: string; until: number }>();
  private readonly gestures = new HoldGestures((slot) => void this.onHold(slot));
  private readonly panel: PanelPicker;

  /** Brings Orca to the front (the same raise a focus press uses); a no-op where the OS does not allow it. */
  private readonly raise: () => Promise<unknown>;

  constructor(
    create: () => Promise<DeckController>,
    panel: PanelPicker = NO_PANEL,
    raise: () => Promise<unknown> = () => Promise.resolve(),
  ) {
    super();
    this.create = create;
    this.panel = panel;
    this.raise = raise;
    setInterval(() => void this.refresh(), 2000);
    // Spinner advances an eighth turn per tick, or every other tick with more than 2 working keys.
    // A tick with nothing to animate does not repaint at all; keys that did not change are not re-sent.
    setInterval(() => {
      this.tick++;
      if (this.animating()) void this.repaint();
    }, 250);
  }

  /** Is anything on the deck changing with time: a spinner, a hint about to expire? */
  private animating(): boolean {
    if (this.hints.size > 0) return true;
    for (const id of this.keys.keys()) if (this.views.get(id)?.state === 'working') return true;
    return false;
  }

  /** Created on first use, i.e. after the plugin connected to Stream Deck. */
  private controller(): Promise<DeckController> {
    return (this.ready ??= this.create().then((c) => (this.ctl = c)));
  }

  /** Address of a key for pairResult: 1-based page (the SDK hides the current page, so 1) and key number. */
  address(slot: string): { page: number; index: number } {
    return { page: 1, index: this.indexes.get(slot) ?? 1 };
  }

  /** The key image carries the whole label; a title set in the Stream Deck app is wiped at once. */
  override async onTitleParametersDidChange(ev: TitleParametersDidChangeEvent): Promise<void> {
    if (ev.payload.title && ev.action.isKey()) await ev.action.setTitle('');
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) return;
    this.keys.set(ev.action.id, ev.action);
    const coords = 'coordinates' in ev.payload ? ev.payload.coordinates : undefined;
    // The SDK does not expose the current page, so only the key number is shown.
    if (coords) {
      const n = keyNumber(coords, ev.action.device.size.columns);
      this.indexes.set(ev.action.id, n);
      this.numbers.set(ev.action.id, formatKeyNumber(n));
    }
    // Reinstalling gives keys new contexts: carry the mapping over by device and position.
    if (coords) {
      const c = await this.controller();
      const live = new Set(this.keys.keys());
      c.locateSlot(
        ev.action.id,
        { device: ev.action.device.id, column: coords.column, row: coords.row },
        live,
      );
    }
    // Titles from earlier versions persist in the profile and would be drawn over the image.
    await ev.action.setTitle('');
    await this.refresh();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.keys.delete(ev.action.id);
    this.sent.delete(ev.action.id);
    this.views.delete(ev.action.id);
    this.numbers.delete(ev.action.id);
    this.indexes.delete(ev.action.id);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    this.gestures.keyDown(ev.action.id);
  }

  /** A tap focuses; a hold already acted while the key was down. */
  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    if (!this.gestures.keyUp(ev.action.id)) return;
    const id = ev.action.id;
    const c = await this.controller();
    // With the Orca panel open for mapping a tap selects the key there (its details open).
    const key = this.panel.selecting() ? this.keyOfSlot(id) : null;
    if (key !== null && this.panel.pick(key)) {
      // The panel's details change in Orca: bring it forward, no pane focus change.
      void this.raise().catch(() => {});
      streamDeck.logger.info(
        `press slot=${id.slice(0, 6)} -> key ${key} opened in the Orca panel, Orca raised`,
      );
      return;
    }
    // A paired-server pane takes over a second to switch: mark the key focused at once so the
    // press is visibly taken. The next refresh shows what Orca really has selected.
    const v = this.views.get(id);
    if (v && v.state !== 'unmapped') {
      this.views.set(id, { ...v, focused: true });
      void this.repaint();
    }
    const t0 = Date.now();
    const r = await c.press(id);
    const host = c.slotHost(id);
    streamDeck.logger.info(
      `press slot=${id.slice(0, 6)} -> ${r} ${Date.now() - t0}ms${host ? ` (${host === 'local' ? 'local' : host.split(':')[0]})` : ''}`,
    );
    if (r === 'failed') await ev.action.showAlert();
    void this.refresh();
  }

  /** Hold fires: the Orca panel opens at this key's details (mapping happens there, never from the deck). */
  private async onHold(slot: string): Promise<void> {
    const key = this.keyOfSlot(slot);
    const t0 = Date.now();
    const opened = key !== null && (await this.panel.open(key));
    // Only a panel that did open brings Orca forward; a hide leaves Orca where it is.
    if (opened === true) await this.raise().catch(() => {});
    streamDeck.logger.info(
      `hold slot=${slot.slice(0, 6)} -> ${opened === 'hidden' ? 'sidebar hidden' : opened ? 'panel opened, Orca raised' : 'panel not opened'} ${Date.now() - t0}ms`,
    );
    if (opened) return;
    // Orca closed, the Orca plugin missing or an old Orca: say where else a key is mapped, long enough to read.
    this.hints.set(slot, { text: 'Map in Orca', until: Date.now() + HINT_MS });
    void this.repaint();
  }

  /** The PI asks for its state on load and sends `configure` to pin, relabel or unmap. */
  override async onSendToPlugin(ev: PluginEvent): Promise<void> {
    const c = await this.controller();
    const m = ev.payload as PiMessage;
    if (m.type === 'clear') {
      c.clear(ev.action.id);
      await this.refresh();
    } else if (m.type === 'configure') {
      // Picking a pane pins it; no pane means back to auto-fill (or just empty while it is off).
      c.configure(ev.action.id, {
        paneKey: m.paneKey ?? null,
      });
      await this.refresh();
    } else {
      // A `load` can arrive before the first snapshot is in (the app opens the inspector as the plugin starts).
      await this.refresh();
    }
    const current = isCurrentPi(ev.action.id);
    if (current) this.piOpen = ev.action.id;
    streamDeck.logger.info(
      `pi ${m.type ?? 'load'} slot=${ev.action.id.slice(0, 6)} -> ${current ? `reply ${c.listPanes().length} panes` : 'not the open inspector, no reply'}`,
    );
    await this.replyState(c, ev.action.id);
  }

  /** The slot whose inspector is open: it gets the pane list again when a refresh changes it. */
  private piOpen: string | null = null;
  private piSent = '';

  private async replyState(c: DeckController, id: string, force = true): Promise<void> {
    const payload = {
      type: 'state',
      panes: c.listPanes((slot) => this.keyOfSlot(slot)),
      config: c.slotConfig(id),
    };
    const sig = JSON.stringify(payload);
    if (!force && sig === this.piSent) return;
    this.piSent = sig;
    await replyToPi(id, payload);
  }

  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent): Promise<void> {
    this.piOpen = ev.action.id;
    await this.refresh();
    await this.onSendToPlugin({ action: ev.action, payload: { type: 'load' } } as never);
  }

  override onPropertyInspectorDidDisappear(ev: { action: { id: string } }): void {
    if (this.piOpen === ev.action.id) this.piOpen = null;
  }

  /** Redraw from the last views at once (pairing mode changes what keys show; no Orca round trip). */
  repaintNow(): void {
    void this.repaint();
  }

  /** The slot (action id) of a 1-based key number on the deck the Orca panel shows, or null. */
  slotOfKey(key: number): string | null {
    const dev = this.shownDevice();
    for (const a of this.actions)
      if (a.device.id === dev && this.indexes.get(a.id) === key) return a.id;
    return null;
  }

  /** The key number a slot has on the deck the Orca panel shows, or null. */
  keyOfSlot(slot: string): number | null {
    const dev = this.shownDevice();
    const a = this.actions.find((x) => x.id === slot);
    return a && a.device.id === dev ? (this.indexes.get(slot) ?? null) : null;
  }

  /** The first connected device that has our keys on it: the one the Orca panel draws. */
  private shownDevice(): string | null {
    for (const d of streamDeck.devices)
      if (d.isConnected && this.actions.some((a) => a.device.id === d.id)) return d.id;
    return null;
  }

  /** The Status and Attention actions, so the panel's grid can show what else of ours sits on the deck. */
  private infoKeys: { kind: 'status' | 'attention'; source: SingletonAction }[] = [];
  setInfoKeys(keys: { kind: 'status' | 'attention'; source: SingletonAction }[]): void {
    this.infoKeys = keys;
  }

  /** The deck as the Orca panel draws it (the `deckState` frame without its envelope). */
  deckState(): {
    connected: boolean;
    model: string | null;
    cols: number;
    rows: number;
    keys: { key: number; label: string; state: string; mapped: boolean }[];
    layout: LayoutCell[];
  } {
    const id = this.shownDevice();
    const dev = streamDeck.devices.find((d) => d.id === id);
    if (!dev) return { connected: false, model: null, cols: 0, rows: 0, keys: [], layout: [] };
    const keys = this.actions
      .filter((a) => a.device.id === id && this.indexes.has(a.id))
      .toArray()
      .map((a) => {
        const v = this.views.get(a.id);
        const mapped = !!v && v.state !== 'unmapped';
        return {
          key: this.indexes.get(a.id) ?? 0,
          label: mapped ? v.label : '',
          state: v?.state ?? 'unmapped',
          mapped,
        };
      })
      .sort((x, y) => x.key - y.key);
    return {
      connected: true,
      model: String(dev.type),
      cols: dev.size.columns,
      rows: dev.size.rows,
      keys,
      layout: deckLayout(dev.size.columns, dev.size.rows, [
        ...this.actions
          .filter((a) => a.device.id === id && a.isKey() && !!a.coordinates)
          .toArray()
          .map((a) => ({ kind: 'pane' as const, coordinates: a.coordinates! })),
        ...this.infoKeys.flatMap(({ kind, source }) =>
          source.actions
            .filter((a) => a.device.id === id && a.isKey() && !!a.coordinates)
            .toArray()
            .map((a) => ({ kind, coordinates: a.coordinates! })),
        ),
      ]),
    };
  }

  /** A push from plugin A arrived: refresh now instead of waiting for the next poll. */
  nudge(): Promise<void> {
    return this.refresh();
  }

  /** Resolves when the refresh that is running, including the one it was asked to repeat, is done. */
  private running: Promise<void> | null = null;

  private refresh(): Promise<void> {
    if (this.keys.size === 0) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const views = await (await this.controller()).refresh([...this.keys.keys()]);
          for (const [id, v] of views) this.views.set(id, v);
          await this.repaint();
          if (this.piOpen && this.ctl) await this.replyState(this.ctl, this.piOpen, false);
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async repaint(): Promise<void> {
    const now = Date.now();
    let working = 0;
    for (const id of this.keys.keys()) if (this.views.get(id)?.state === 'working') working++;
    if (spinnerAdvances(this.tick, working)) this.spin++;
    await Promise.all(
      [...this.keys].map(async ([id, k]) => {
        const base = this.views.get(id);
        const v = base;
        if (!v) return;
        const hint = this.hints.get(id);
        if (hint && hint.until <= now) this.hints.delete(id);
        const shown = hint && hint.until > now && hint.text ? { ...v, label: hint.text } : v;
        const img = image(
          renderKey(
            {
              ...shown,
              keyNumber: this.numbers.get(id),
            },
            { size: 144, spin: this.spin },
          ),
        );
        if (this.sent.get(id) === img) return;
        this.sent.set(id, img);
        await k.setImage(img);
      }),
    );
  }
}
