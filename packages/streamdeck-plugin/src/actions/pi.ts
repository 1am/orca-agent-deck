import streamDeck from '@elgato/streamdeck';

/**
 * `ui.sendToPropertyInspector` targets the PI the user has open. OpenDeck also mounts a hidden PI per
 * action at profile load and those send `load` too, so a reply is only sent to the action whose PI is current.
 * The reply carries that action id as `context` so a PI can drop anything that is not for it.
 */
export const isCurrentPi = (id: string): boolean => streamDeck.ui.action?.id === id;

// The single cast: core's interfaces (PickerPane, Check, ...) have no index signature, so they are not the SDK's JsonObject.
export async function replyToPi(id: string, payload: object): Promise<void> {
  if (!isCurrentPi(id)) return;
  await streamDeck.ui.sendToPropertyInspector({ ...payload, context: id } as never);
}
