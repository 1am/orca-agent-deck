// The one place that reaches into the Stream Deck SDK's internals.
//
// `streamDeck.ui.sendToPropertyInspector` only sends to the inspector the app announced with
// `propertyInspectorDidAppear`. After the plugin restarts, an inspector that was already open sends
// `load` but is never announced again, so the SDK has nobody to answer. The SDK's `exports` map does
// not expose its connection, so it is imported by file path: bundled by rollup it is the very module
// the SDK itself uses. That is only safe against one SDK build, hence the exact pin of
// `@elgato/streamdeck` in package.json and `pi-send.test.ts`, which fails when the path or export moves.
import { connection } from '../../../../node_modules/@elgato/streamdeck/dist/plugin/connection.js';

/** Sends `payload` to the inspector of the action `context`, whether or not the SDK knows it is open. */
export function sendToInspectorOf(context: string, payload: object): Promise<void> {
  return connection.send({ event: 'sendToPropertyInspector', context, payload } as never);
}
