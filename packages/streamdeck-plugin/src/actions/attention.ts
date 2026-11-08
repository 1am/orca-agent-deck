import { action } from '@elgato/streamdeck';
import { attentionInfo, statusInfo, type DeckController } from '@orca-agent-deck/core';
import { InfoKey } from './info-key.ts';

/** Number of panes that need you. Press = focus the most urgent, again = next. */
@action({ UUID: 'pl.1am.orca-agent-deck.attention' })
export class AttentionKey extends InfoKey {
  protected model(c: DeckController) {
    const o = c.overview();
    // mobile-6 has no Status key: a failed setup check (Orca off or too old) takes over this one.
    if (o.mode === 'down' || o.unsupported) return statusInfo(o);
    return attentionInfo(o.urgent, o.topState, o.offDeck);
  }
  protected async press(c: DeckController) {
    return (await c.pressAttention()) === 'failed' ? ('failed' as const) : ('ok' as const);
  }
}
