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
  formatKeyNumber,
  keyNumber,
  pairingSlotView,
  spinnerAdvances,
  renderKey,
  type DeckController,
  type SlotView,
} from '@orca-agent-deck/core';
import { replyToPi } from './pi.ts';

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
  private busy = false;
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

  constructor(create: () => Promise<DeckController>) {
    super();
    this.create = create;
    setInterval(() => void this.refresh(), 2000);
    // Spinner advances an eighth turn per tick, or every other tick on a busy deck; keys without a
    // spinner produce an identical image and are not re-sent.
    setInterval(() => {
      this.tick++;
      void this.repaint();
    }, 250);
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
    // Pairing mode: the next press binds the slot instead of focusing.
    if (c.pairing.press(id, 'tap')) {
      await this.refresh();
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

  /** Hold fires: assign / re-assign the focused pane, or release it when already shown here. */
  private async onHold(slot: string): Promise<void> {
    const found = this.actions.find((a) => a.id === slot);
    const key = found?.isKey() ? found : undefined;
    const c = await this.controller();
    if (c.pairing.press(slot, 'hold')) {
      await this.refresh();
      return;
    }
    const t0 = Date.now();
    const r = await c.hold(slot);
    streamDeck.logger.info(
      `hold slot=${slot.slice(0, 6)} -> ${r} ${Date.now() - t0}ms ${r === 'failed' ? c.holdError : ''}`,
    );
    if (r === 'failed') {
      await key?.showAlert();
      // Say why on the key itself (a paired-server pane cannot be read from Orca).
      this.hints.set(slot, { text: c.holdHint, until: Date.now() + HINT_MS });
      void this.repaint();
      return;
    }
    await this.refresh();
    await key?.showOk();
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
    }
    await replyToPi(ev.action.id, {
      type: 'state',
      panes: c.listPanes(),
      config: c.slotConfig(ev.action.id),
    });
  }

  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent): Promise<void> {
    await this.refresh();
    await this.onSendToPlugin({ action: ev.action, payload: { type: 'load' } } as never);
  }

  /** Redraw from the last views at once (pairing mode changes what keys show; no Orca round trip). */
  repaintNow(): void {
    void this.repaint();
  }

  /** A push from plugin A arrived: refresh now instead of waiting for the next poll. */
  nudge(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.keys.size === 0) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        const views = await (await this.controller()).refresh([...this.keys.keys()]);
        for (const [id, v] of views) this.views.set(id, v);
        await this.repaint();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  private async repaint(): Promise<void> {
    const now = Date.now();
    let working = 0;
    for (const id of this.keys.keys()) if (this.views.get(id)?.state === 'working') working++;
    if (spinnerAdvances(this.tick, working)) this.spin++;
    await Promise.all(
      [...this.keys].map(async ([id, k]) => {
        const base = this.views.get(id);
        const waiting = this.ctl?.pairing.state;
        const v =
          waiting?.phase === 'waitingForKey'
            ? pairingSlotView(
                waiting,
                id,
                base,
                waiting.pane.lastKnown.paneTitle ??
                  waiting.pane.lastKnown.title ??
                  waiting.pane.paneKey,
                this.tick % 4 < 2,
              )
            : base;
        if (!v) return;
        const hint = this.hints.get(id);
        if (hint && hint.until <= now) this.hints.delete(id);
        const shown = hint && hint.until > now && hint.text ? { ...v, label: hint.text } : v;
        const img = image(
          renderKey(
            {
              ...shown,
              keyNumber: this.numbers.get(id),
              bigNumber: shown.assign ? (this.numbers.get(id) ?? null) : null,
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
