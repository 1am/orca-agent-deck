/** Which Stream Deck host app runs plugin B, and on which OS. Pure: the caller passes the process values. */

export type DeckOs = 'mac' | 'windows' | 'linux' | 'other';
export type DeckHost = 'elgato' | 'opendeck' | 'unknown';

export interface DeckHostInfo {
  /** From the Node process, never from the registration info (OpenDeck reports `windows` on every OS). */
  os: DeckOs;
  host: DeckHost;
  /** Version string the host registered with (not comparable across hosts). */
  version: string;
  /** Which signal decided `host`, for the Setup doctor and the log. */
  basis: 'env' | 'linux' | 'version-pixel-ratio' | 'platform-mismatch' | 'build-version' | 'none';
}

/** The registration info members used (`streamDeck.info`). */
export interface RegistrationInfo {
  application?: { version?: string; platform?: string };
  devicePixelRatio?: number;
}

const OS: Partial<Record<NodeJS.Platform, DeckOs>> = {
  darwin: 'mac',
  win32: 'windows',
  linux: 'linux',
};

/**
 * Signals, in order (source review of OpenDeck 2.14.2, docs/compatibility.md): the registration info names no app,
 * but OpenDeck registers Node plugins with version `7.1.0`, `devicePixelRatio` 0 and platform `windows` on every
 * OS, while the Elgato app sends a 4-part build version. There is no Elgato app on Linux.
 */
export function detectHost(
  info: RegistrationInfo,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): DeckHostInfo {
  const os = OS[platform] ?? 'other';
  const version = info.application?.version ?? '';
  const forced = env.ORCA_DECK_HOST?.toLowerCase();
  const found = (host: DeckHost, basis: DeckHostInfo['basis']): DeckHostInfo => ({
    os,
    host,
    version,
    basis,
  });
  if (forced === 'elgato' || forced === 'opendeck') return found(forced, 'env');
  if (os === 'linux') return found('opendeck', 'linux');
  if (version === '7.1.0' && info.devicePixelRatio === 0)
    return found('opendeck', 'version-pixel-ratio');
  if (info.application?.platform === 'windows' && os !== 'windows')
    return found('opendeck', 'platform-mismatch');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(version)) return found('elgato', 'build-version');
  return found('unknown', 'none');
}
