/**
 * Dual-host rules (spec 11.3): one plugin runs in the Elgato Stream Deck app and in OpenDeck.
 * Every SDK call plugin B makes is listed here with whether both hosts are known to support it
 * (checked against both hosts). A call that is not portable is only made after `canUse` says yes. `host.test.ts` fails
 * when the sources call an SDK member that is not on this list, so new calls get reviewed here.
 */

export type HostKind = 'elgato' | 'opendeck' | 'unknown';

export interface HostInfo {
  kind: HostKind;
  /** Version string the host registered with (not comparable across hosts). */
  version: string;
  platform: string;
  /** How `kind` was decided, for the Setup doctor and the log. */
  basis: 'env' | 'platform' | 'none';
}

/** Portable subset: members of the `streamDeck` object used by B. `true` = fine in both hosts. */
export const SDK_CALLS = {
  'actions.registerAction': true,
  connect: true,
  'logger.info': true,
  'logger.warn': true,
  'logger.setLevel': true,
  'settings.getGlobalSettings': true,
  'settings.setGlobalSettings': true,
  'ui.sendToPropertyInspector': true,
  devices: true,
  info: true,
} as const satisfies Record<string, boolean>;

/** Features that exist only on the Elgato app (or are not verified in OpenDeck): capability checked. */
export type Feature = 'bundledProfiles' | 'switchToProfile' | 'deviceDidChange';

const ELGATO_ONLY: ReadonlySet<Feature> = new Set(['bundledProfiles', 'switchToProfile']);

/**
 * The registration info carries no application name, so the host cannot be read directly:
 * `ORCA_DECK_HOST` wins, a platform other than mac/windows means OpenDeck (Linux), else unknown.
 */
export function detectHost(
  info: { application?: { version?: string; platform?: string } },
  env: Record<string, string | undefined> = process.env,
): HostInfo {
  const version = info.application?.version ?? '';
  const platform = info.application?.platform ?? '';
  const forced = env.ORCA_DECK_HOST?.toLowerCase();
  if (forced === 'elgato' || forced === 'opendeck')
    return { kind: forced, version, platform, basis: 'env' };
  if (platform && platform !== 'mac' && platform !== 'windows')
    return { kind: 'opendeck', version, platform, basis: 'platform' };
  return { kind: 'unknown', version, platform, basis: 'none' };
}

/** Whether a feature may be used. Unknown hosts get the portable subset only. */
export function canUse(host: HostInfo, feature: Feature): boolean {
  if (feature === 'deviceDidChange') return host.kind === 'elgato';
  return ELGATO_ONLY.has(feature) ? host.kind === 'elgato' : true;
}
