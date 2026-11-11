import streamDeck from '@elgato/streamdeck';
import { sendToInspectorOf } from './pi-send.ts';

/**
 * `ui.sendToPropertyInspector` targets the PI the user has open. OpenDeck also mounts a hidden PI per
 * action at profile load and those send `load` too, so a reply is only sent to the action whose PI is current.
 * The reply carries that action id as `context` so a PI can drop anything that is not for it.
 */
/**
 * May this action's inspector be answered? Yes when it is the one the app announced. When the SDK knows
 * none (the plugin restarted with an inspector open) a `load` from an inspector can only be a real one,
 * and its reply goes to that inspector alone (see `replyToPi`). Never while another action's is current.
 */
export const isCurrentPi = (id: string): boolean => {
  const current = streamDeck.ui.action;
  return current === undefined || current.id === id;
};

// The single cast: core's interfaces (PickerPane, Check, ...) have no index signature, so they are not the SDK's JsonObject.
export async function replyToPi(id: string, payload: object): Promise<void> {
  if (!isCurrentPi(id)) return;
  const message = { ...payload, context: id };
  // The SDK sends to the announced inspector only; with none announced, name the asking one.
  if (streamDeck.ui.action === undefined) await sendToInspectorOf(id, message);
  else await streamDeck.ui.sendToPropertyInspector(message as never);
}
