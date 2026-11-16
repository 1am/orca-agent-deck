/**
 * Which decks B counts as connected. The SDK fills `streamDeck.devices` with the decks of the registration info,
 * marked not connected, and marks a deck connected on `deviceDidConnect`. That is right in the Elgato app: its list
 * also holds known decks that are unplugged, and it sends `deviceDidConnect` for the ones that are there. So in the
 * Elgato app the SDK flag alone decides.
 *
 * OpenDeck lists only the decks it has registered (`plugins/info_param.rs:103`; a deck leaves the list on deregister,
 * `events/inbound/devices.rs:89`) and sends `deviceDidConnect` once, when the deck registers
 * (`events/inbound/devices.rs:22`). A plugin started after that (installed, updated or reloaded while OpenDeck runs)
 * never gets it, and the SDK keeps its decks "not connected". So in OpenDeck a deck B knows counts as connected
 * until OpenDeck says it went away. OpenDeck sends no `deviceDidChange`, the only other way a deck enters the list.
 *
 * Any other host (`unknown`; seen: Fifine Control Deck, docs/compatibility.md) is not read from source, so B goes by
 * what the host shows rather than by what its list holds. Fifine was seen to register its decks with
 * `isConnected: false` and never send `deviceDidConnect` for them, while it does send `willAppear` for the keys on
 * them (it also connects a 1x1 virtual device that has none of our keys). A deck the host shows our keys on is in
 * use, so there such a deck counts as connected. Unplug was not observed on Fifine; this stays right if the host
 * sends either `willDisappear` for the keys (the SDK drops them from `device.actions`) or `deviceDidDisconnect`
 * (the deck is "gone"). A `willAppear` on a gone deck (keys shown again on replug) or `deviceDidConnect` (the SDK
 * flag) brings it back. A host that sends neither on unplug keeps the deck counted as connected until B restarts.
 */

import streamDeck from '@elgato/streamdeck';
import { currentHost } from './host.ts';

/** Decks the host reported gone (`deviceDidDisconnect`) and showed no key on since. */
const gone = new Set<string>();
let watching = false;

/** Call before `streamDeck.connect()`, so a `deviceDidDisconnect` the host replays on registration is seen. */
export function watchDevices(): void {
  if (watching) return;
  watching = true;
  streamDeck.devices.onDeviceDidDisconnect((ev) => {
    if (ev.device) gone.add(ev.device.id);
  });
  streamDeck.actions.onWillAppear((ev) => {
    gone.delete(ev.action.device.id);
  });
}

/** The members of an SDK `Device` used here; `actions` = the actions the host currently shows on it. */
export interface DeckLike {
  id: string;
  isConnected: boolean;
  actions: Iterable<unknown>;
}

const showsActions = (d: DeckLike): boolean => !d.actions[Symbol.iterator]().next().done;

/** Whether a deck of `streamDeck.devices` counts as connected (see the top of this file). */
export function isDeckConnected(d: DeckLike): boolean {
  if (d.isConnected) return true;
  const { host } = currentHost();
  if (host === 'elgato' || gone.has(d.id)) return false;
  return host === 'opendeck' || showsActions(d);
}
