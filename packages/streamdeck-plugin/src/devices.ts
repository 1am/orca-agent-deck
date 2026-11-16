/**
 * Which decks B counts as connected. The SDK fills `streamDeck.devices` with the decks of the registration info,
 * marked not connected, and marks a deck connected on `deviceDidConnect`. That is right in the Elgato app: its list
 * also holds known decks that are unplugged, and it sends `deviceDidConnect` for the ones that are there. OpenDeck
 * lists only the decks it has registered (`plugins/info_param.rs:103`; a deck leaves the list on deregister,
 * `events/inbound/devices.rs:89`) and sends `deviceDidConnect` once, when the deck registers
 * (`events/inbound/devices.rs:22`). A plugin started after that (installed, updated or reloaded while OpenDeck runs)
 * never gets it, and the SDK keeps its decks "not connected". So in OpenDeck a deck B knows counts as connected
 * until OpenDeck says it went away. OpenDeck sends no `deviceDidChange`, the only other way a deck enters the list.
 */

import streamDeck from '@elgato/streamdeck';
import { currentHost } from './host.ts';

/** Decks the host reported gone since B started. */
const gone = new Set<string>();
let watching = false;

/** Call before `streamDeck.connect()`, so a `deviceDidDisconnect` the host replays on registration is seen. */
export function watchDevices(): void {
  if (watching) return;
  watching = true;
  streamDeck.devices.onDeviceDidDisconnect((ev) => {
    if (ev.device) gone.add(ev.device.id);
  });
}

/** Whether a deck of `streamDeck.devices` counts as connected; outside OpenDeck this is the SDK's `isConnected`. */
export function isDeckConnected(d: { id: string; isConnected: boolean }): boolean {
  if (d.isConnected) return true;
  return currentHost().host === 'opendeck' && !gone.has(d.id);
}
