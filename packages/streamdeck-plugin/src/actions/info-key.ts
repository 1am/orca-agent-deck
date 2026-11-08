import {
  SingletonAction,
  type KeyDownEvent,
  type TitleParametersDidChangeEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from '@elgato/streamdeck';
import {
  pairingCancelInfo,
  renderInfoKey,
  type DeckController,
  type InfoModel,
} from '@orca-agent-deck/core';

const image = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;

interface Key {
  setImage(image: string): Promise<void>;
  setTitle(title: string): Promise<void>;
  showAlert(): Promise<void>;
}

/** Base for the Status and Attention keys: shows `model()` of the shared controller, redrawn on change. */
export abstract class InfoKey extends SingletonAction {
  private readonly keys = new Map<string, Key>();
  private readonly sent = new Map<string, string>();
  protected readonly create: () => Promise<DeckController>;

  constructor(create: () => Promise<DeckController>) {
    super();
    this.create = create;
    setInterval(() => {
      void this.repaint();
    }, 1000);
  }

  protected abstract model(c: DeckController): InfoModel;
  protected abstract press(c: DeckController): Promise<'ok' | 'failed'>;

  /** The key image carries the whole label; a title set in the Stream Deck app is wiped at once. */
  override async onTitleParametersDidChange(ev: TitleParametersDidChangeEvent): Promise<void> {
    if (ev.payload.title && ev.action.isKey()) await ev.action.setTitle('');
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) return;
    this.keys.set(ev.action.id, ev.action);
    await ev.action.setTitle('');
    await this.repaint();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.keys.delete(ev.action.id);
    this.sent.delete(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const c = await this.create();
    // While pairing mode waits these keys are Cancel.
    if (c.pairing.state.phase === 'waitingForKey') return c.pairing.cancel();
    if ((await this.press(c)) === 'failed') await ev.action.showAlert();
  }

  private async repaint(): Promise<void> {
    if (this.keys.size === 0) return;
    const c = await this.create();
    await c.refresh([]);
    const p = c.pairing.state;
    const model = p.phase === 'waitingForKey' ? pairingCancelInfo('Mapping pane') : this.model(c);
    const svg = renderInfoKey(model, { size: 144 });
    const img = image(svg);
    await Promise.all(
      [...this.keys].map(async ([id, k]) => {
        if (this.sent.get(id) === img) return;
        this.sent.set(id, img);
        await k.setImage(img);
      }),
    );
  }
}
