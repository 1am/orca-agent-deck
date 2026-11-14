/**
 * Dual-host rules (spec 11.3): one plugin runs in the Elgato Stream Deck app and in OpenDeck.
 * Every SDK call plugin B makes is listed here with whether both hosts are known to support it
 * (checked against both hosts). A call that is not portable is only made after `canUse` says yes. `host.test.ts` fails
 * when the sources call an SDK member that is not on this list, so new calls get reviewed here.
 */

import streamDeck from '@elgato/streamdeck';
import { detectHost, type DeckHostInfo } from '@orca-agent-deck/core';

/** Portable subset: members of the `streamDeck` object used by B. `true` = fine in both hosts. */
export const SDK_CALLS = {
  'actions.registerAction': true,
  connect: true,
  'logger.info': true,
  'logger.warn': true,
  'logger.setLevel': true,
  'settings.getGlobalSettings': true,
  'settings.setGlobalSettings': true,
  'ui.action': true,
  'ui.sendToPropertyInspector': true,
  devices: true,
  info: true,
} as const satisfies Record<string, boolean>;

/** Features that exist only on the Elgato app (or are not verified in OpenDeck): capability checked. */
export type Feature = 'bundledProfiles' | 'switchToProfile' | 'deviceDidChange';

const ELGATO_ONLY: ReadonlySet<Feature> = new Set(['bundledProfiles', 'switchToProfile']);

let detected: DeckHostInfo | undefined;

/** The host plugin B runs in; only after `streamDeck.connect()` (the registration info is not there before). */
export const currentHost = (): DeckHostInfo =>
  (detected ??= detectHost(streamDeck.info, process.platform, process.env));

/** Whether a feature may be used. Unknown hosts get the portable subset only. */
export function canUse(host: DeckHostInfo, feature: Feature): boolean {
  if (feature === 'deviceDidChange') return host.host === 'elgato';
  return ELGATO_ONLY.has(feature) ? host.host === 'elgato' : true;
}
